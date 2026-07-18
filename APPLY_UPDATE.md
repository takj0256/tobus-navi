# UbuntuでPhase 6を既存リポジトリへ適用

## 1. ZIPを展開

```bash
cd ~/Downloads
rm -rf tobus-navi-pwa-phase6
unzip tobus-navi-pwa-phase6.zip
```

## 2. Gitリポジトリへ移動

```bash
cd ~/tobus-navi
REPO="$(git rev-parse --show-toplevel)"
printf '更新先: %s\n' "$REPO"
```

`/` または空欄ならコピーしないでください。

## 3. 安全確認付きで上書き

```bash
SOURCE="$HOME/Downloads/tobus-navi-pwa-phase6"

if [[ -z "$REPO" || "$REPO" == "/" || ! -d "$REPO/.git" ]]; then
  echo "危険または不正な更新先のため中止: $REPO" >&2
  exit 1
fi

rsync -av --no-group "$SOURCE/" "$REPO/"
```

## 4. GTFSを必ず再生成

Phase 6では `parent_station` を使うschema version 5へ変更したため、以前の `transit-index.json` は使用できません。

```bash
cd "$REPO"
./tools/update_gtfs.sh ~/Downloads/ToeiBus-GTFS.zip
```

Windows側のダウンロードフォルダにある場合：

```bash
./tools/update_gtfs.sh /mnt/c/Users/Windowsユーザー名/Downloads/ToeiBus-GTFS.zip
```

## 5. テスト

```bash
npm run check:js
npm run test:js
python3 -m py_compile tools/*.py tests/*.py
python3 -m unittest discover -s tests -p "test_*.py" -v
python3 tools/validate_dataset.py data/transit-index.json
```

## 6. ローカル確認

```bash
python3 tools/serve.py
```

```text
http://127.0.0.1:8000
```

確認項目：

- 「錦糸町駅前」が1枚のカードで表示される
- カード表面に代表行き先が表示される
- 複数のりばは閉じた状態で表示される
- 開くと1番、2番などののりばと系統が表示される

## 7. GitHubへ反映

```bash
git status
git add .
git commit -m "Group platforms under parent stops and add collapsible stop cards"
git push
```
