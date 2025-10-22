// src/index.js — stable base + live fetching (RSSBridge → Nitter fallback)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- Health check
    if (path === "/__ping") {
      return new Response("pong", { headers: { "access-control-allow-origin": "*" } });
    }

    if (path === "/__write") {
      try {
        const key = url.searchParams.get("key") || "frontend.xml";
        const q   = url.searchParams.get("q")   || "react";
        const xml =
          (await fetchViaRssBridge(q, { verbose: true })) ||
          (await fetchViaNitter(q,   { verbose: true }));
    
        if (!xml) {
          throw new Error(`no data from mirrors for query="${q}"`);
        }
    
        await env.FEEDS.put(key, xml, { metadata: { query: q, ts: Date.now() } });
        await env.META.put(key, JSON.stringify({ query: q, updated: Date.now() }));
        return new Response(`wrote ${key} for "${q}"`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log("WRITE_ERROR", msg);
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
        });
      }
    }

    // --- Manual seed (no network) — proves KV+dashboard work
    if (path === "/__seed") {
      const key = "frontend.xml";
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Manual Seed</title>
  <updated>${new Date().toISOString()}</updated>
  <entry>
    <title>Hello world</title>
    <link href="https://twitter.com"/>
    <summary>Seeded item</summary>
  </entry>
</feed>`;
      await env.FEEDS.put(key, xml, { metadata: { query: "manual seed", ts: Date.now() } });
      await env.META.put(key, JSON.stringify({ query: "manual seed", updated: Date.now() }));
      return new Response("seeded");
    }

    // --- Debug: list FEEDS keys
    if (path === "/__debug") {
      const keys = await env.FEEDS.list();
      return new Response(JSON.stringify(keys, null, 2), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
      });
    }

    // --- Live: refresh all feeds (fetch → store → return summary)
    if (path === "/__refresh") {
      const summary = await updateAllFeeds(env, { verbose: true });
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
      });
    }

    // --- Live: write one feed on demand (helpful for tests)
    //     /__write?key=frontend.xml&q=frontend%20developer
    if (path === "/__write") {
      const key = url.searchParams.get("key") || "frontend.xml";
      const q   = url.searchParams.get("q")   || "frontend developer";
      const xml = await fetchViaRssBridge(q, { verbose: true }) || await fetchViaNitter(q, { verbose: true });
      if (!xml) return new Response("Fetch failed", { status: 502 });
      await env.FEEDS.put(key, xml, { metadata: { query: q, ts: Date.now() } });
      await env.META.put(key, JSON.stringify({ query: q, updated: Date.now() }));
      return new Response(`wrote ${key} for "${q}"`);
    }

    // /__probe?q=react  → shows which mirrors return content
    if (url.pathname === "/__probe") {
      const q = url.searchParams.get("q") || "react";
      const report = await probeSources(q);
      return new Response(JSON.stringify(report, null, 2), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
      });
    }


    // --- JSON endpoint (parse Atom minimally)
    if (path.endsWith(".json")) {
      const feedKey = path.slice(1).replace(".json", ".xml");
      const xml = await env.FEEDS.get(feedKey);
      const items = xml ? extractEntries(xml) : [];
      return new Response(JSON.stringify(items), {
        headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" }
      });
    }

    // --- Serve XML from KV
    if (path.endsWith(".xml")) {
      const feedKey = path.slice(1);
      const xml = await env.FEEDS.get(feedKey);
      if (!xml) return new Response("missing", { status: 404 });
      return new Response(xml, { headers: { "content-type": "application/atom+xml; charset=utf-8" } });
    }

    // --- Dashboard
    if (path === "/" || path === "/index.html") {
      const keys = await env.FEEDS.list();
      const rows = await Promise.all(keys.keys.map(async k => {
        const metaRaw = await env.META.get(k.name);
        const meta = metaRaw ? JSON.parse(metaRaw) : {};
        const updated = meta.updated ? new Date(meta.updated).toLocaleString() : "never";
        return `<tr>
          <td><a href="/${k.name}">${k.name}</a></td>
          <td><a href="/${k.name.replace('.xml','.json')}">${k.name.replace('.xml','.json')}</a></td>
          <td>${escape(meta.query || "(unknown)")}</td>
          <td>${escape(updated)}</td>
        </tr>`;
      }));
      return new Response(`<!doctype html><meta charset="utf-8">
<style>body{font-family:system-ui;padding:24px;max-width:900px;margin:auto}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}th{background:#f3f4f6}</style>
<h1>Feeds Dashboard</h1>
<p>Use <code>/__refresh</code> to fetch live data. You can also write one feed with <code>/__write?key=frontend.xml&q=frontend%20developer</code>.</p>
<table><tr><th>RSS</th><th>JSON</th><th>Query</th><th>Updated</th></tr>
${rows.join("") || "<tr><td colspan=4>(empty)</td></tr>"}</table>`,
        { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("404", { status: 404 });
  }
};

async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

// Try direct → proxy via r.jina.ai (http & https). Returns string or null.
async function fetchHtmlWithProxy(url, opts = {}, ms = 6000) {
  try {
    const r = await fetchWithTimeout(url, opts, ms);
    if (r.ok) return await r.text();
  } catch {}

  try {
    const proxied = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`;
    const r = await fetchWithTimeout(proxied, opts, ms);
    if (r.ok) return await r.text();
  } catch {}

  try {
    const proxied = `https://r.jina.ai/https://${url.replace(/^https?:\/\//, "")}`;
    const r = await fetchWithTimeout(proxied, opts, ms);
    if (r.ok) return await r.text();
  } catch {}

  return null;
}

/* ---------------- Config ---------------- */

const QUERIES = {
  // start simple; we can add smart filters once we see data flowing
  "frontend.xml": "frontend developer",
  "design.xml":   "design engineering"
};

const RSSBRIDGE_MIRRORS = [
  "https://bridge.suumitsu.eu",
  "https://rss-bridge.bb8.fun",
  "https://rssbridge.nixnet.services"
];

const NITTER_MIRRORS = [
  "https://nitter.poast.org",
  "https://nitter.moomoo.me",
  "https://nitter.privacydev.net",
  "https://nitter.net" // keep last as flaky
];

const COMMON_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9"
};

/* -------------- Fetch orchestration -------------- */

async function updateAllFeeds(env, { verbose = false } = {}) {
  const summary = [];
  for (const [file, query] of Object.entries(QUERIES)) {
    let xml = await fetchViaRssBridge(query, { verbose });
    if (!xml) xml = await fetchViaNitter(query, { verbose });

    if (xml) {
      await env.FEEDS.put(file, xml, { metadata: { query, ts: Date.now() } });
      await env.META.put(file, JSON.stringify({ query, updated: Date.now() }));
      summary.push({ file, ok: true });
    } else {
      summary.push({ file, ok: false, error: "no data from mirrors" });
    }
  }
  if (verbose) console.log("summary", summary);
  return summary;
}

// function fetchWithTimeout(url, opts = {}, ms = 6000) {
//   const ctrl = new AbortController();
//   const id = setTimeout(() => ctrl.abort(), ms);
//   return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
// }

async function fetchViaRssBridge(query, { verbose = false } = {}) {
  const q = encodeURIComponent(query);
  for (const base of RSSBRIDGE_MIRRORS) {
    const url = `${base}/?action=display&bridge=Twitter&format=Atom&q=${q}`;
    try {
      const r = await fetchWithTimeout(url, {
        headers: COMMON_HEADERS,
        cf: { cacheTtl: 60, cacheEverything: true }
      }, 6000);
      if (verbose) console.log("rssbridge", base, r.status);
      if (!r.ok) continue;
      const text = await r.text();
      if (text.includes("<entry") || text.includes("<feed")) return text;
    } catch (e) {
      if (verbose) console.log("rssbridge err", base, String(e));
    }
  }
  return null;
}

async function fetchViaNitter(query, { verbose = false } = {}) {
  const q = encodeURIComponent(query);
  for (const base of NITTER_MIRRORS) {
    const url = `${base}/search?f=tweets&q=${q}`;
    try {
      const r = await fetchWithTimeout(url, { headers: COMMON_HEADERS }, 6000);
      if (verbose) console.log("nitter", base, r.status);
      if (!r.ok) continue;
      const html = await r.text();
      const items = extractFromNitter(html);
      if (items.length) return itemsToAtom(query, items);
    } catch (e) {
      if (verbose) console.log("nitter err", base, String(e));
    }
  }
  return null;
}

/* -------------- Parsing helpers -------------- */

// function extractFromNitter(html) {
//   const out = [];
//   const statusRe = /href="\/([^"\/]+)\/status\/(\d+)"[^>]*class="tweet-link"/g;
//   let m, seen = new Set();
//   while ((m = statusRe.exec(html)) && out.length < 40) {
//     const user = m[1], id = m[2];
//     if (seen.has(id)) continue;
//     seen.add(id);
//     const link = `https://twitter.com/${user}/status/${id}`;

//     const ctx = html.slice(Math.max(0, m.index - 400), m.index + 400);
//     const t = ctx.match(/<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
//     const txt = t ? stripTags(t[1]).replace(/\s+/g, " ").trim() : `Tweet by @${user}`;
//     out.push({ title: txt.slice(0, 90), link, summary: txt });
//   }
//   return out;
// }

function extractFromNitter(html) {
  const out = [];
  // 1) Find status links (avoid requiring class="tweet-link")
  const linkRe = /href="\/([^"\/]+)\/status\/(\d+)"/g;
  const seen = new Set();
  let m;

  while ((m = linkRe.exec(html)) && out.length < 40) {
    const user = m[1];
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);

    const link = `https://twitter.com/${user}/status/${id}`;

    // 2) Try to get text near the link; Nitter varies between <div> and <p> containers
    const ctxStart = Math.max(0, m.index - 1200);
    const ctxEnd = Math.min(html.length, m.index + 1200);
    const ctx = html.slice(ctxStart, ctxEnd);

    // Try a few patterns, fall back gracefully
    const candidates = [
      /<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/,
      /<p class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/p>/,
      /<div class="content"[^>]*>([\s\S]*?)<\/div>/,
    ];
    let text = "";
    for (const re of candidates) {
      const mm = ctx.match(re);
      if (mm && mm[1]) { text = mm[1]; break; }
    }
    text = text ? stripTags(text).replace(/\s+/g, " ").trim() : `Tweet by @${user}`;

    const title = text.length > 100 ? text.slice(0, 97) + "…" : text;
    out.push({ title, link, summary: text });
  }
  return out;
}


function itemsToAtom(query, items) {
  const entries = items.map(it => `
    <entry>
      <title>${escapeXml(it.title)}</title>
      <link href="${escapeXml(it.link)}" />
      <id>${escapeXml(it.link)}</id>
      <updated>${new Date().toISOString()}</updated>
      <summary>${escapeXml(it.summary)}</summary>
    </entry>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Twitter search: ${escapeXml(query)}</title>
  <updated>${new Date().toISOString()}</updated>
  ${entries}
</feed>`;
}

function extractEntries(atomXml = "") {
  const out = [];
  const entryRe = /<entry[\s\S]*?<\/entry>/g;
  const titleRe = /<title[^>]*>([\s\S]*?)<\/title>/;
  const linkRe = /<link[^>]*href="([^"]+)"/;
  const summaryRe = /<summary[^>]*>([\s\S]*?)<\/summary>/;
  for (const e of atomXml.match(entryRe) || []) {
    const title = stripTags((e.match(titleRe) || [])[1] || "");
    const link = (e.match(linkRe) || [])[1] || "";
    const summary = stripTags((e.match(summaryRe) || [])[1] || "");
    out.push({ title, link, summary });
  }
  return out;
}

function stripTags(s=""){ return s.replace(/<[^>]*>/g, ""); }
function escapeXml(s=""){ return s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;"); }
function escape(s=""){ return s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }

async function probeSources(query) {
  const q = encodeURIComponent(query);
  const out = { query, rssbridge: [], nitter: [] };

  for (const base of RSSBRIDGE_MIRRORS) {
    const url = `${base}/?action=display&bridge=Twitter&format=Atom&q=${q}`;
    const text = await fetchHtmlWithProxy(url, { headers: COMMON_HEADERS }, 7000);
    out.rssbridge.push({
      url,
      ok: !!text && (text.includes("<entry") || text.includes("<feed")),
      len: text ? text.length : 0
    });
  }

  for (const base of NITTER_MIRRORS) {
    const url = `${base}/search?f=tweets&q=${q}`;
    const html = await fetchHtmlWithProxy(url, { headers: COMMON_HEADERS }, 7000);
    const items = html ? extractFromNitter(html) : [];
    out.nitter.push({
      url,
      ok: items.length > 0,
      items: items.length,
      len: html ? html.length : 0
    });
  }

  return out;
}