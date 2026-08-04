// Cloudflare Workerを公開した場合は、ここへURLを設定してください。
// 例: "https://tobus-realtime.example.workers.dev"
export const REALTIME_PROXY_ENDPOINT = "https://tobus-realtime-proxy.roboko3-tobus.workers.dev";
// Phase 11 APIは通常、リアルタイム中継Workerと同じURLで公開します。
export const PHASE11_API_ENDPOINT = REALTIME_PROXY_ENDPOINT;
export const PHASE11_TIMEOUT_MS = 5_000;
export const PHASE11_REFRESH_MS = 5 * 60_000;

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
export const REALTIME_INFERRED_PROGRESS_MAXIMUM = 0.94;
export const REALTIME_TRAFFIC_RECENT_WINDOW_MS = 45 * 60_000;
export const REALTIME_TRAFFIC_MAXIMUM_AGE_MS = 14 * 24 * 60 * 60_000;
export const REALTIME_TRAFFIC_MAX_SAMPLES = 48;
export const REALTIME_TRAFFIC_STORAGE_KEY = "tobus-navi-segment-history-v1";
