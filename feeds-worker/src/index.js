if (path.endsWith(".json")) {
  const xml = await env.FEEDS.get(path.replace(".json", ".xml"));
  const list = extractTweets(xml);
  return new Response(JSON.stringify(list), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*", // ✅ allows Next.js app to fetch
    },
  });
}
