// Cloudflare Workerを公開した場合は、ここへURLを設定してください。
// 例: "https://tobus-realtime.example.workers.dev"
export const REALTIME_PROXY_ENDPOINT = "";

export const REALTIME_SOURCES = [
  ...(REALTIME_PROXY_ENDPOINT ? [{
    id: "cloudflare-proxy",
    label: "リアルタイム中継",
    url: REALTIME_PROXY_ENDPOINT,
  }] : []),
  {
    id: "odpt-public",
    label: "ODPT公開配信",
    url: "https://api-public.odpt.org/api/v4/gtfs/realtime/ToeiBus",
  },
];

export const REALTIME_REFRESH_MS = 10_000;
export const REALTIME_TIMEOUT_MS = 10_000;
export const REALTIME_STALE_AFTER_MS = 90_000;
export const REALTIME_VEHICLE_MAX_AGE_MS = 5 * 60_000;
export const REALTIME_MAX_BACKOFF_MS = 2 * 60_000;
export const REALTIME_ANTICIPATION_MAX_SECONDS = 30;
export const REALTIME_ANTICIPATION_SEGMENT_RATIO = 0.25;
