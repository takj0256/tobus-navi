// 公開GTFS-RTエンドポイント。CORS制約がある環境では、同梱のCloudflare Workerを
// 公開し、そのURLへ置き換えてください。
export const REALTIME_ENDPOINT = "https://api-public.odpt.org/api/v4/gtfs/realtime/ToeiBus";
export const REALTIME_REFRESH_MS = 20_000;
