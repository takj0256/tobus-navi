# 都バスナビ Phase 5

現在地周辺の同名停留所を1枚にまとめ、上り・下り、次の発車、時刻表、走行中の車両、後続停留所への推定到着時刻を表示するPWAです。

## Phase 5の変更

- 本日の全時刻表を初期状態では閉じ、タップした時だけ生成・表示
- 「これからの発車予定」は常時表示
- GTFS-RT取得を10秒でタイムアウト
- 複数取得先の順次フォールバックに対応
- 同一通信の重複実行を防止
- 失敗回数に応じて40秒〜最大2分へ再試行間隔を調整
- オフライン時は更新を停止し、通信復旧時に即時再取得
- アプリがバックグラウンドの間は更新を停止し、復帰時に再取得
- 90秒以上古いフィードを警告表示
- 5分以上更新されていない車両を候補から除外
- 取得元と最終更新時刻を画面表示
- Cloudflare Workerに8秒タイムアウトと最大3分の障害時キャッシュを追加

## GTFSデータ

Phase 4以降の形式を使用します。

```bash
./tools/update_gtfs.sh ~/Downloads/ToeiBus-GTFS.zip
```

生成物：

- `data/transit-index.json`
- `data/routes/*.json`

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

Android Chromeから直接取得できない場合は、同梱のCloudflare Workerを公開します。

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

発行されたURLを `js/config.js` に設定します。

```js
export const REALTIME_PROXY_ENDPOINT = "https://your-worker.workers.dev";
```

Proxyを設定した場合はProxyを先に試し、失敗時にODPT公開配信へフォールバックします。

## GitHubへ反映

```bash
git add .
git commit -m "Make timetable collapsible and stabilize realtime updates"
git push
```

## 推定到着について

到着時刻は静的GTFSの予定時刻とVehiclePositionの更新時刻との差を後続停留所へ反映した推定値です。交通状況などにより実際と異なる場合があります。

## クレジット

データ提供元：東京都交通局・公共交通オープンデータ協議会（CC BY 4.0）

本アプリは東京都交通局の公式アプリではありません。
