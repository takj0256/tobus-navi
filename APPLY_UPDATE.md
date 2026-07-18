# UbuntuでPhase 5を既存リポジトリへ適用

## 1. ZIPを展開

```bash
cd ~/Downloads
rm -rf tobus-navi-pwa-phase5
unzip tobus-navi-pwa-phase5.zip
```

## 2. Gitリポジトリへ移動

実際の保存場所へ移動します。

```bash
cd ~/tobus-navi
```

場所が不明なら次で探します。

```bash
find ~ -type d -name .git 2>/dev/null
```

更新先を確認します。

```bash
REPO="$(git rev-parse --show-toplevel)"
printf '更新先: %s\n' "$REPO"
```

`/` または空欄ならコピーしないでください。

## 3. 安全確認付きで上書き

```bash
REPO="$(git rev-parse --show-toplevel)"
SOURCE="$HOME/Downloads/tobus-navi-pwa-phase5"

if [[ -z "$REPO" || "$REPO" == "/" || ! -d "$REPO/.git" ]]; then
  echo "危険または不正な更新先のため中止: $REPO" >&2
  exit 1
fi

rsync -av --no-group "$SOURCE/" "$REPO/"
```

既存の `data/transit-index.json` と `data/routes/` は削除されません。

## 4. テスト

```bash
cd "$REPO"
npm run check:js
npm run test:js
python3 -m py_compile tools/*.py tests/*.py
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

## 6. リアルタイム診断

```bash
python3 tools/check_realtime.py
```

## 7. GitHubへ反映

```bash
git status
git add .
git commit -m "Make timetable collapsible and stabilize realtime updates"
git push
```
