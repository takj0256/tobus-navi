# Phase 11 適用手順（Ubuntu／WSL Ubuntu）

## 1. ZIPを展開

```bash
cd ~/Downloads
rm -rf tobus-navi-pwa-phase11
unzip tobus-navi-pwa-phase11.zip
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
SOURCE="$HOME/Downloads/tobus-navi-pwa-phase11"

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

- 公開座標を生GPSとして扱わず、報告停留所から次停留所までの推定区間へ表示される
- 同じ車両の停留所切替から区間所要時間が学習される
- 先行車が遅い区間で「やや遅め」または「混雑傾向」と表示される
- 石島イベントから猿江一丁目まで、各区間時間が累積される
- 後続停留所の予測時刻が同じ「現在付近」にならず、順に増える
- 公開イベントが来るまでは推定位置が次停留所を越えない

ローカル環境ではWorkerのR2・D1がないため、Phase 10フォールバックになることも正常です。

## 7. Phase 11 Workerを設定

共有週間プロファイルを使う場合だけ実施します。詳しい手順は`worker/README.md`を参照してください。

```bash
cd worker
npx wrangler login
npx wrangler d1 create tobus-phase11
npx wrangler r2 bucket create tobus-phase11-events
# wrangler.tomlへIDとバインディングを設定
npx wrangler d1 migrations apply tobus-phase11 --remote
npx wrangler secret put TOMTOM_API_KEY  # 外部補正を使う場合だけ
npx wrangler deploy
```

表示されたURLを`js/config.js`の`REALTIME_PROXY_ENDPOINT`へ設定します。

## 8. GitHubへ反映

```bash
git status
git add .
git commit -m "Add weekly traffic profiles and anomaly corrections"
git push
```

公開後に古い表示が残る場合は、AndroidのPWAを完全終了して再起動してください。キャッシュ名は `tobus-navi-v12` です。
