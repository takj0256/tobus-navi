# UbuntuでPhase 4を既存リポジトリへ適用

## 1. 現在のGitリポジトリを確認

```bash
cd /実際の/tobus-navi
REPO="$(git rev-parse --show-toplevel)"
printf '更新先: %s\n' "$REPO"
```

`/` と表示された場合は中止してください。

## 2. ZIPを展開して上書き

```bash
cd ~/Downloads
rm -rf tobus-navi-pwa-phase4
unzip tobus-navi-pwa-phase4.zip

REPO="$(cd /実際の/tobus-navi && git rev-parse --show-toplevel)"
if [[ -z "$REPO" || "$REPO" == "/" ]]; then
  echo "危険な更新先のため中止: $REPO" >&2
  exit 1
fi

rsync -av --no-group \
  ~/Downloads/tobus-navi-pwa-phase4/ \
  "$REPO/"
```

## 3. 正式GTFSをPhase 4形式で再生成

旧 `data/stops.json` だけでは時刻表・車両追跡を利用できません。

```bash
cd "$REPO"
./tools/update_gtfs.sh ~/Downloads/ToeiBus-GTFS.zip
```

## 4. テスト

```bash
npm run check:js
npm run test:js
python3 -m unittest discover -s tests -p "test_*.py" -v
python3 tools/validate_dataset.py data/transit-index.json
```

## 5. ローカル確認

```bash
python3 tools/serve.py
```

```text
http://127.0.0.1:8000
```

## 6. GitHubへ反映

```bash
git status
git add .
git commit -m "Add grouped stops timetable and realtime tracking"
git push
```
