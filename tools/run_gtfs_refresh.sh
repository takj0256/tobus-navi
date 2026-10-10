#!/usr/bin/env bash
# Separate publication checkout, never the developer's working tree.
set -euo pipefail
root="${1:?usage: run_gtfs_refresh.sh PRIVATE_GTFS_ROOT}"
exec >>"$root/refresh.log" 2>&1
exec 8>"$root/refresh.lock"
flock -n 8 || exit 75
echo "$(date -Is) GTFS refresh starting"
checkout="$root/publish"
cd "$checkout"
[[ "$(git branch --show-current)" == main ]] || { echo 'not main'; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'publication checkout dirty; preserve and inspect'; exit 1; }
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=20'
git fetch origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || {
  # Only accept remote fast-forward; never overwrite an unshared local commit.
  git merge-base --is-ancestor HEAD origin/main || { echo 'unshared/diverged commit; inspect'; exit 1; }
  git merge --ff-only origin/main
}
today="$(TZ=Asia/Tokyo date +%F)"
if [[ -f "$root/success-date" && "$(<"$root/success-date")" == "$today" ]]; then
  echo "$(date -Is) GTFS already published today"; exit 0
fi
# Baseline advances only after the validated data is successfully shared.
[[ ! -f "$root/audit-baseline.json" ]] || cp "$root/audit-baseline.json" "$root/audit-pending.json"
python3 tools/refresh_gtfs.py --output data --audit-baseline "$root/audit-pending.json" --status-file "$root/status.json"
git diff --check
python3 tools/validate_dataset.py data/transit-index.json
git add -- data/transit-index.json data/routes data/gtfs-status.json data/gtfs-retention.json
if ! git diff --cached --quiet; then
  git -c user.name='Tobus GTFS Refresh' -c user.email='gtfs-refresh@users.noreply.github.com' commit -m "data: validate official GTFS $today"
  git push origin HEAD:main
fi
[[ ! -f "$root/audit-pending.json" ]] || mv "$root/audit-pending.json" "$root/audit-baseline.json"
printf '%s\n' "$today" > "$root/success-date.tmp"
mv "$root/success-date.tmp" "$root/success-date"
echo "$(date -Is) GTFS shared; Pages deployment must be checked separately"
