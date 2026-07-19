# 都バスナビ Phase 7

現在地周辺の同名停留所をまとめ、同じのりばを使用する複数系統の接近順、停留所上の現在位置、時刻表、後続停留所への推定到着時刻を表示するPWAです。

## Phase 7の変更

- 同じ `stop_id`（同じのりば）を使用する複数系統を1つの運行情報画面へ統合
- 「こののりばの接近情報」から、系統をまたいで到着予定の早い順に車両を表示
- 接近カードへ系統番号と行き先を常時表示
- 系統ごとに、乗車停留所と手前の停留所を並べた「停留所上の現在位置」を追加
- バス記号をタップすると、その車両の先の停留所と推定到着時刻を表示
- これからの発車予定も複数系統を時刻順に統合
- 本日の全時刻表は系統・行き先別に開閉表示
- Phase 6のGTFSデータ形式をそのまま使用可能
- Service Workerキャッシュを `tobus-navi-v8` に更新

## データ更新について

Phase 6で生成済みの次のデータがあれば、Phase 7適用時の再生成は不要です。

- `data/transit-index.json`
- `data/routes/*.json`

GTFS自体を更新する場合は次を実行します。

```bash
./tools/update_gtfs.sh ~/Downloads/ToeiBus-GTFS.zip
```

## Ubuntuでローカル実行

```bash
python3 tools/serve.py
```

```text
http://127.0.0.1:8000
```

## テスト

```bash
npm run check:js
npm run test:js
python3 -m py_compile tools/*.py tests/*.py
python3 -m unittest discover -s tests -p "test_*.py" -v
python3 tools/validate_dataset.py data/transit-index.json
```

## リアルタイム配信の診断

```bash
python3 tools/check_realtime.py
```

Android Chromeから直接取得できない場合は、同梱のCloudflare Workerを利用できます。

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

発行されたURLを `js/config.js` に設定します。

```js
export const REALTIME_PROXY_ENDPOINT = "https://your-worker.workers.dev";
```

## GitHubへ反映

```bash
git add .
git commit -m "Integrate routes by platform and add stop-position tracking"
git push
```

## 推定到着について

到着時刻は静的GTFSの予定時刻とVehiclePositionの更新時刻との差を後続停留所へ反映した推定値です。交通状況などにより実際と異なる場合があります。

## クレジット

データ提供元：東京都交通局・公共交通オープンデータ協議会（CC BY 4.0）

本アプリは東京都交通局の公式アプリではありません。
