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

downloaded=0
for days_ago in $(seq 0 27); do
  date_key="$(TZ=Asia/Tokyo date -d "$days_ago days ago" +%F)"
  if "${wrangler[@]}" r2 object get "tobus-phase11-events/daily-v2/$date_key.json" \
      --remote --file "$data_dir/$date_key.json" --config "$project_dir/worker/wrangler.toml" >/dev/null 2>&1; then
    downloaded=$((downloaded + 1))
    printf 'downloaded daily-v2/%s.json\n' "$date_key"
  else
    rm -f "$data_dir/$date_key.json"
  fi
done
if (( downloaded == 0 )); then
  echo "R2からdaily-v2を取得できませんでした。Wranglerログインとバケットを確認してください。" >&2
  exit 1
fi

sql_file="$work_dir/profiles.sql"
node "$project_dir/tools/aggregate_phase11_local.mjs" "$data_dir" "$sql_file"
"${wrangler[@]}" d1 execute tobus-phase11 --remote --yes --file "$sql_file" \
  --config "$project_dir/worker/wrangler.toml"
echo "Phase 11 local aggregation complete ($downloaded source objects)."
