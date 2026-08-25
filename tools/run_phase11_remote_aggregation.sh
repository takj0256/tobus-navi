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

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
current_step="initialization"
mark_failed() {
  code=$?
  trap - ERR
  error_text="failed at $current_step (exit $code)"
  "${wrangler[@]}" d1 execute tobus-phase11 --remote --yes \
    --command="INSERT INTO job_status (job_name,status,started_at,completed_at,source_objects,profile_count,error) VALUES ('profile-aggregation','failed','$started_at','$(date -u +%Y-%m-%dT%H:%M:%SZ)',0,0,'$error_text') ON CONFLICT(job_name) DO UPDATE SET status='failed',started_at=excluded.started_at,completed_at=excluded.completed_at,error=excluded.error" \
    --config "$project_dir/worker/wrangler.toml" >/dev/null 2>&1 || true
  echo "Phase 11 aggregation $error_text" >&2
  exit "$code"
}
trap mark_failed ERR

current_step="recording running status"
"${wrangler[@]}" d1 execute tobus-phase11 --remote --yes \
  --command="INSERT INTO job_status (job_name,status,started_at,completed_at,source_objects,profile_count,error) VALUES ('profile-aggregation','running','$started_at',NULL,0,0,NULL) ON CONFLICT(job_name) DO UPDATE SET status='running',started_at=excluded.started_at,completed_at=NULL,source_objects=0,profile_count=0,error=NULL" \
  --config "$project_dir/worker/wrangler.toml" >/dev/null

downloaded=0
has_yesterday=0
current_step="downloading daily-v2 objects"
for days_ago in $(seq 1 28); do
  date_key="$(TZ=Asia/Tokyo date -d "$days_ago days ago" +%F)"
  target="$data_dir/$date_key.json"
  if "${wrangler[@]}" r2 object get "tobus-phase11-events/daily-v2/$date_key.json" \
      --remote --file "$target" --config "$project_dir/worker/wrangler.toml" >/dev/null 2>&1; then
    if [[ -s "$target" ]]; then
      downloaded=$((downloaded + 1))
      if (( days_ago == 1 )); then has_yesterday=1; fi
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
  false
fi
if (( has_yesterday == 0 )); then
  echo "昨日分のdaily-v2が未生成のため集計を中止します。Workerの日次圧縮を確認してください。" >&2
  false
fi

current_step="syncing inputs to compute host"
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
current_step="copying calculated profiles"
scp -i "$identity_file" -P "$compute_port" "$compute_host:$remote_dir/profiles.sql" "$work_dir/profiles.sql"
current_step="uploading profiles to D1"
"${wrangler[@]}" d1 execute tobus-phase11 --remote --yes --file "$work_dir/profiles.sql" \
  --config "$project_dir/worker/wrangler.toml"
trap - ERR
echo "Phase 11 remote aggregation complete ($downloaded source objects on $compute_host)."
