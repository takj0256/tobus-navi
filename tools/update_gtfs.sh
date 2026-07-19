#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-$HOME/Downloads/ToeiBus-GTFS.zip}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f "$SOURCE" && ! -d "$SOURCE" ]]; then
  echo "GTFS入力が見つかりません: $SOURCE" >&2
  echo "使用例: ./tools/update_gtfs.sh ~/Downloads/ToeiBus-GTFS.zip" >&2
  exit 1
fi

python3 tools/convert_gtfs.py "$SOURCE" --output-dir data
python3 tools/validate_dataset.py data/transit-index.json

echo "GTFS更新が完了しました。Phase 7で利用できるschema version 5データを生成しました。sw.js は v8 に更新済みです。確認後にgit pushしてください。"
