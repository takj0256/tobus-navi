#!/usr/bin/env bash
set -euo pipefail
batch_root="${1:?usage: run_phase11_raw_processor.sh BATCH_ROOT}"
exec >>"$batch_root/raw-processor.log" 2>&1
exec 8>"$batch_root/raw-processor.lock"
if ! flock -n 8; then echo "$(date -Is) raw processor busy; skipped"; exit 0; fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
source "$NVM_DIR/nvm.sh"
set -u
cd "$batch_root/app"
echo "$(date -Is) raw processor starting"
node node_modules/wrangler/bin/wrangler.js whoami >/dev/null
node tools/process_phase11_raw.mjs "$batch_root/raw-processor"
echo "$(date -Is) raw processor complete"
