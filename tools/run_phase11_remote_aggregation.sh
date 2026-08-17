#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compute_host="${PHASE11_COMPUTE_HOST:-yachiyo@100.70.107.59}"
compute_port="${PHASE11_COMPUTE_PORT:-2222}"
identity_file="${PHASE11_IDENTITY_FILE:-$HOME/.ssh/id_ed25519_lab}"
remote_dir="${PHASE11_REMOTE_DIR:-/home/yachiyo/tobus-phase11-batch}"
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
  target="$data_dir/$date_key.json"
  if "${wrangler[@]}" r2 object get "tobus-phase11-events/daily-v2/$date_key.json" \
      --remote --file "$target" --config "$project_dir/worker/wrangler.toml" >/dev/null 2>&1; then
    if [[ -s "$target" ]]; then
      downloaded=$((downloaded + 1))
      printf 'downloaded daily-v2/%s.json\n' "$date_key"
    else
      rm -f "$target"
    fi
  else
    rm -f "$target"
  fi
done
if (( downloaded == 0 )); then
  echo "R2からdaily-v2を取得できませんでした。Wranglerログインを確認してください。" >&2
  exit 1
fi

ssh_args=(-i "$identity_file" -p "$compute_port")
ssh "${ssh_args[@]}" "$compute_host" "mkdir -p '$remote_dir/daily-v2' '$remote_dir/app/js' '$remote_dir/app/tools'"
rsync -az --delete -e "ssh -i $identity_file -p $compute_port" \
  "$data_dir/" "$compute_host:$remote_dir/daily-v2/"
rsync -az -e "ssh -i $identity_file -p $compute_port" \
  "$project_dir/package.json" "$compute_host:$remote_dir/app/package.json"
rsync -az -e "ssh -i $identity_file -p $compute_port" \
  "$project_dir/js/phase11.js" "$compute_host:$remote_dir/app/js/phase11.js"
rsync -az -e "ssh -i $identity_file -p $compute_port" \
  "$project_dir/tools/phase11-local-model.js" "$project_dir/tools/aggregate_phase11_local.mjs" \
  "$compute_host:$remote_dir/app/tools/"

ssh "${ssh_args[@]}" "$compute_host" \
  "set -eu; . \"\$HOME/.nvm/nvm.sh\"; cd '$remote_dir/app'; node tools/aggregate_phase11_local.mjs ../daily-v2 ../profiles.sql"
scp -i "$identity_file" -P "$compute_port" "$compute_host:$remote_dir/profiles.sql" "$work_dir/profiles.sql"
"${wrangler[@]}" d1 execute tobus-phase11 --remote --yes --file "$work_dir/profiles.sql" \
  --config "$project_dir/worker/wrangler.toml"
echo "Phase 11 remote aggregation complete ($downloaded source objects on $compute_host)."
