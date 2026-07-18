const SOURCE = "https://api-public.odpt.org/api/v4/gtfs/realtime/ToeiBus";
const UPSTREAM_TIMEOUT_MS = 8_000;
const STALE_CACHE_SECONDS = 180;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
    }

    const cache = caches.default;
    const staleKey = new Request(new URL("/cached-feed", request.url), { method: "GET" });

    try {
      const response = await fetchWithTimeout(SOURCE, UPSTREAM_TIMEOUT_MS);
      if (!response.ok) throw new Error(`ODPT upstream HTTP ${response.status}`);

      const body = await response.arrayBuffer();
      if (!body.byteLength) throw new Error("ODPT upstream returned an empty feed");

      const headers = responseHeaders(response.headers, {
        "Cache-Control": "no-store",
        "X-Realtime-Source": "odpt-public",
        "X-Realtime-Stale": "false",
      });
      const clientResponse = new Response(body.slice(0), { status: 200, headers });

      const cachedHeaders = responseHeaders(response.headers, {
        "Cache-Control": `public, s-maxage=${STALE_CACHE_SECONDS}`,
        "X-Realtime-Source": "worker-cache",
        "X-Realtime-Stale": "true",
      });
      ctx.waitUntil(cache.put(staleKey, new Response(body, { status: 200, headers: cachedHeaders })));
      return clientResponse;
    } catch (error) {
      const cached = await cache.match(staleKey);
      if (cached) {
        const headers = responseHeaders(cached.headers, {
          "Cache-Control": "no-store",
          "X-Realtime-Source": "worker-cache",
          "X-Realtime-Stale": "true",
          "X-Realtime-Upstream-Error": String(error.message || error).slice(0, 180),
        });
        return new Response(cached.body, { status: 200, headers });
      }

      return new Response(`Realtime upstream unavailable: ${error.message || error}`, {
        status: 502,
        headers: responseHeaders(null, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        }),
      });
    }
  },
};

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/x-protobuf, application/octet-stream" },
      cf: { cacheTtl: 10, cacheEverything: true },
    });
  } finally {
    clearTimeout(timer);
  }
}

function responseHeaders(baseHeaders, additions = {}) {
  const headers = new Headers(baseHeaders || undefined);
  for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
  for (const [key, value] of Object.entries(additions)) headers.set(key, value);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/x-protobuf");
  return headers;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Expose-Headers": "X-Realtime-Source, X-Realtime-Stale, X-Realtime-Upstream-Error",
  };
}
