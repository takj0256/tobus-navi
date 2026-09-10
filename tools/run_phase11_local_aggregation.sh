#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
data_dir="$work_dir/daily-v2"
mkdir -p "$data_dir"
if [[ -x "$project_dir/node_modules/.bin/wrangler" ]]; then
  wrangler=("$project_dir/node_modules/.bin/wrangler")
else
  wrangler=(npx wrangler@latest)
fi

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
current_step="initialization"
mark_failed() {
  code=$?
  trap - ERR
  echo "Phase 11 JSON aggregation failed at $current_step (exit $code, started $started_at)" >&2
  exit "$code"
}
trap mark_failed ERR

# 大きな日次JSONの生成はCloudflare WorkerのCPU上限を避けるため、このPCで行う。
# 既に昨日分がある場合は何も変更せず、欠損時だけhourly/eventsから復元する。
yesterday_key="$(TZ=Asia/Tokyo date -d '1 day ago' +%F)"
probe_file="$work_dir/yesterday.json"
current_step="ensuring yesterday daily-v2"
if ! "${wrangler[@]}" r2 object get "tobus-phase11-events/daily-v2/$yesterday_key.json" \
    --remote --file "$probe_file" --config "$project_dir/worker/wrangler.toml" >/dev/null 2>&1; then
  rm -f "$probe_file"
  node "$project_dir/tools/recover_phase11_daily_from_r2.mjs" "$yesterday_key"
fi

downloaded=0
has_yesterday=0
current_step="downloading daily-v2 objects"
for days_ago in $(seq 1 28); do
  date_key="$(TZ=Asia/Tokyo date -d "$days_ago days ago" +%F)"
  if "${wrangler[@]}" r2 object get "tobus-phase11-events/daily-v2/$date_key.json" \
      --remote --file "$data_dir/$date_key.json" --config "$project_dir/worker/wrangler.toml" >/dev/null 2>&1; then
    downloaded=$((downloaded + 1))
    if (( days_ago == 1 )); then has_yesterday=1; fi
    printf 'downloaded daily-v2/%s.json\n' "$date_key"
  else
    rm -f "$data_dir/$date_key.json"
  fi
done
if (( downloaded == 0 )); then
  echo "R2からdaily-v2を取得できませんでした。Wranglerログインとバケットを確認してください。" >&2
  false
fi
if (( has_yesterday == 0 )); then
  echo "昨日分のdaily-v2が未生成のため集計を中止します。Workerの日次圧縮を確認してください。" >&2
  false
fi

output_dir="$work_dir/profiles-json"
current_step="calculating profile JSON"
node --max-old-space-size=4096 "$project_dir/tools/aggregate_phase11_json.mjs" "$data_dir" "$output_dir"
current_step="publishing profile JSON to R2"
node "$project_dir/tools/publish_phase11_json_to_r2.mjs" "$output_dir"
trap - ERR
echo "Phase 11 JSON aggregation complete ($downloaded source objects, no D1 writes)."
