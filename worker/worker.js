const SOURCE = "https://api-public.odpt.org/api/v4/gtfs/realtime/ToeiBus";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
    }

    const response = await fetch(SOURCE, {
      cf: { cacheTtl: 10, cacheEverything: true },
      headers: { Accept: "application/x-protobuf, application/octet-stream" },
    });
    if (!response.ok) {
      return new Response(`ODPT upstream error: ${response.status}`, {
        status: 502,
        headers: corsHeaders(),
      });
    }

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
    headers.set("Cache-Control", "public, max-age=10");
    return new Response(response.body, { status: 200, headers });
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
