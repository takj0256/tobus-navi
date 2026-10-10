#!/usr/bin/env bash
# Windows Task Scheduler invokes this foreground process; cron need not stay alive.
set -euo pipefail
batch_root="${1:?usage: run_phase11_scheduled.sh BATCH_ROOT}"
exec >>"$batch_root/aggregation.log" 2>&1
exec 9>"$batch_root/aggregation.lock"
if ! flock -n 9; then
  echo "$(date -Is) scheduled aggregation busy; retry later"
  exit 75
fi
today="$(TZ=Asia/Tokyo date +%F)"
marker="$batch_root/aggregation-success-date"
refresh_gtfs() {
  # Release the aggregation lock before the independent timetable publication.
  flock -u 9
  if [[ -f "$batch_root/gtfs-refresh/enabled" ]]; then
    if ! bash "$batch_root/gtfs-refresh/run_gtfs_refresh.sh" "$batch_root/gtfs-refresh"; then
      echo "$(date -Is) GTFS refresh failed; aggregation result unchanged; see gtfs-refresh/refresh.log"
    fi
  fi
}
if [[ -f "$marker" ]] && [[ "$(<"$marker")" == "$today" ]]; then
  echo "$(date -Is) scheduled aggregation skipped: already succeeded $today"
  refresh_gtfs
  exit 0
fi
echo "$(date -Is) scheduled aggregation starting for $today"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# nvm may reference unset shell variables.
set +u
source "$NVM_DIR/nvm.sh"
set -u
cd "$batch_root/app"
export PHASE11_HISTORY_DIR="$batch_root/history"
export PHASE11_HISTORY_MODE=remote
if [[ -f "$batch_root/raw-processor/config.json" ]]; then export PHASE11_RAW_DIR="$batch_root/raw-processor"; fi
if bash ./tools/run_phase11_local_aggregation.sh; then
  printf '%s\n' "$today" > "$marker.tmp"
  mv "$marker.tmp" "$marker"
  echo "$(date -Is) scheduled aggregation succeeded for $today"
else
  code=$?
  echo "$(date -Is) scheduled aggregation failed (exit $code)"
  refresh_gtfs
  exit "$code"
fi
refresh_gtfs
