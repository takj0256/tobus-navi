#!/usr/bin/env bash
set -euo pipefail
batch_root="${1:?usage: run_phase11_history_maintenance.sh BATCH_ROOT}"
exec >>"$batch_root/history-maintenance.log" 2>&1
exec 9>"$batch_root/aggregation.lock"
flock -n -E 75 9 || exit 75
echo "$(date -Is) history maintenance starting"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
source "$NVM_DIR/nvm.sh"
set -u
cd "$batch_root/app"
./node_modules/.bin/wrangler whoami >/dev/null
# Small historical backfill; current 28 dates are archived by the daily runner.
node tools/archive_phase11_history.mjs backfill 3 "$batch_root/history"
node tools/export_phase11_legacy.mjs "$batch_root/legacy-export"
echo "$(date -Is) history maintenance complete"
