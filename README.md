# 都バスナビ Phase 9

現在地周辺の都バス停留所を検索し、同じのりばを使う複数系統の時刻表、接近順、停留所間の推定位置、後続停留所への推定到着時刻を表示するPWAです。

## Phase 9の修正

Phase 8では、GTFS-RTの `current_stop_sequence` が配信遅延によって古い場合でも、その停留所の直前区間に車両を固定していました。また、配信時刻から現在までに1区間以上進んだ場合でも、現在区間を越えて補正できませんでした。

Phase 9では次のように修正しています。

- GPS座標を、`current_stop_sequence` 前後の複数区間へ投影して最も近い走行区間を選択
- `current_stop_sequence` より1〜3区間先にGPSがある場合も補正
- 配信遅延と最大30秒の先読みが1区間を超えた場合、次の区間へ順次進める
- 後続停留所までの所要時間を、現在区間の残り時間と各区間のGTFS時刻表から個別に累積
- GTFSで時刻が同一または欠損していても、後続停留所の到着時刻が逆転しないよう保護
- 停車情報が古い場合は、25秒の停車猶予後に次区間へ進行補正
- 車両詳細の現在位置表示を、補正後の「前停留所〜次停留所間」に統一
- Service Workerキャッシュを `tobus-navi-v10` へ更新

## 今回の想定例

石島停車中から、時刻表上で次の所要時間が設定されている場合：

```text
石島 → 扇橋一丁目：4分
扇橋一丁目 → 猿江一丁目：3分
```

猿江一丁目への到着予測は、各区間を累積して約7分になります。

配信時点では石島付近でも、GPS座標や配信遅延補正の結果、現在時刻では扇橋一丁目〜猿江一丁目間に進んでいると判断した場合は、その区間に車両を表示します。

## データ

Phase 6以降で生成済みの次のデータをそのまま使用できます。Phase 9の適用だけならGTFSの再生成は不要です。

- `data/transit-index.json`
- `data/routes/*.json`

GTFS自体を更新する場合：

```bash
./tools/update_gtfs.sh ~/Downloads/ToeiBus-GTFS.zip
```

## Ubuntuでローカル実行

```bash
python3 tools/serve.py
```

ブラウザで次を開きます。

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

## GitHubへ反映

```bash
git add .
git commit -m "Fix cumulative ETA and multi-segment realtime correction"
git push
```

## 調整値

`js/config.js` で次を調整できます。

- `REALTIME_ANTICIPATION_MAX_SECONDS`：先読み上限
- `REALTIME_SEGMENT_SEARCH_AHEAD`：GPSから検索する前方区間数
- `REALTIME_SEGMENT_SNAP_MAX_METERS`：区間へ吸着させる最大距離
- `REALTIME_STOPPED_HOLD_SECONDS`：停車情報を維持する秒数

## クレジット

データ提供元：東京都交通局・公共交通オープンデータ協議会（CC BY 4.0）

本アプリは東京都交通局の公式アプリではありません。
