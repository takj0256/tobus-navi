# UbuntuでPhase 8を既存リポジトリへ適用

## 1. ZIPを展開

```bash
cd ~/Downloads
rm -rf tobus-navi-pwa-phase8
unzip tobus-navi-pwa-phase8.zip
```

## 2. Gitリポジトリを確認

リポジトリが `~/tobus-navi` にある例です。

```bash
cd ~/tobus-navi
REPO="$(git rev-parse --show-toplevel)"
echo "$REPO"
```

`/`、空文字、`.git` が存在しない場所ならコピーしないでください。

## 3. 安全確認付きで上書き

```bash
SOURCE="$HOME/Downloads/tobus-navi-pwa-phase8"

if [[ -z "$REPO" || "$REPO" == "/" || ! -d "$REPO/.git" ]]; then
  echo "不正な更新先のため中止: $REPO" >&2
  exit 1
fi

rsync -av --no-group "$SOURCE/" "$REPO/"
```

## 4. GTFSデータを確認

Phase 6以降の正式データをそのまま利用できます。

```bash
cd "$REPO"
python3 tools/validate_dataset.py data/transit-index.json
```

データ自体を更新する場合のみ再生成します。

```bash
./tools/update_gtfs.sh ~/Downloads/ToeiBus-GTFS.zip
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

Chromeで `http://127.0.0.1:8000` を開きます。

## 7. GitHubへ反映

```bash
git status
git add .
git commit -m "Correct realtime position with segment travel times"
git push
```

公開後、AndroidのPWAを完全に終了して開き直してください。古い表示が残る場合はサイトデータを削除してください。
