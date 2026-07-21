# Phase 9 適用手順（Ubuntu／WSL Ubuntu）

## 1. ZIPを展開

```bash
cd ~/Downloads
rm -rf tobus-navi-pwa-phase9
unzip tobus-navi-pwa-phase9.zip
```

## 2. Gitリポジトリへ移動

保存先が `~/tobus-navi` の場合：

```bash
cd ~/tobus-navi
REPO="$(git rev-parse --show-toplevel)"
echo "$REPO"
```

`/` または空欄の場合は、以降のコピーを実行しないでください。

## 3. 更新ファイルを上書き

```bash
SOURCE="$HOME/Downloads/tobus-navi-pwa-phase9"

if [[ -z "$REPO" || "$REPO" == "/" || ! -d "$REPO/.git" ]]; then
  echo "不正な更新先のため中止: $REPO" >&2
  exit 1
fi

rsync -av --no-group "$SOURCE/" "$REPO/"
```

このZIPには正式GTFSデータを含めていません。既存の `data/transit-index.json` と `data/routes/` はそのまま残ります。

## 4. データ確認

```bash
cd "$REPO"
python3 tools/validate_dataset.py data/transit-index.json
```

Phase 6以降のデータ形式なら、GTFS再変換は不要です。

## 5. テスト

```bash
npm run check:js
npm run test:js
python3 -m py_compile tools/*.py tests/*.py
python3 -m unittest discover -s tests -p "test_*.py" -v
```

## 6. ローカル確認

```bash
python3 tools/serve.py
```

```text
http://127.0.0.1:8000
```

確認点：

- GPSが `current_stop_sequence` より先にある場合、実際に近い後続区間へ表示される
- 石島停車中から猿江一丁目まで、各区間時間が累積される
- 後続停留所の予測時刻が同じ「現在付近」にならず、順に増える
- 配信遅延が1区間を超える場合、次の区間まで進行補正される

## 7. GitHubへ反映

```bash
git status
git add .
git commit -m "Fix cumulative ETA and multi-segment realtime correction"
git push
```

公開後に古い表示が残る場合は、AndroidのPWAを完全終了して再起動してください。キャッシュ名は `tobus-navi-v10` です。
