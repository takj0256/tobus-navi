# 都バスナビ Phase 6

現在地周辺の同名停留所を1枚にまとめ、のりば、行き先、次の発車、時刻表、走行中の車両、後続停留所への推定到着時刻を表示するPWAです。

## Phase 6の変更

- GTFSの `parent_station` を利用し、「錦糸町駅前」などの親停留所名でのりばを統合
- 子停留所名が `1`、`2` のような番号だけでも「1番のりば」として表示
- 停留所カードの表面に代表的な行き先を常時表示
- 複数のりばは初期状態で閉じ、「のりば・系統を表示」で展開
- 展開後は `├ 1番のりば`、`└ 2番のりば` のような階層表示
- お気に入り変更後も開いていた停留所カードの状態を維持
- データ形式をschema version 5へ更新

## 重要：GTFSの再生成

Phase 6は停留所の親子関係を利用するため、Phase 5以前のデータは使用できません。更新適用後に必ず再生成してください。

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
git commit -m "Group platforms under parent stops and add collapsible stop cards"
git push
```

## 推定到着について

到着時刻は静的GTFSの予定時刻とVehiclePositionの更新時刻との差を後続停留所へ反映した推定値です。交通状況などにより実際と異なる場合があります。

## クレジット

データ提供元：東京都交通局・公共交通オープンデータ協議会（CC BY 4.0）

本アプリは東京都交通局の公式アプリではありません。
