# 都バスナビ Phase 4

現在地周辺の同名停留所を1枚にまとめ、上り・下りの各のりば、時刻表、走行中の車両位置、後続停留所への推定到着時刻を表示するPWAです。

## Phase 4の主要機能

- 同じ停留所名の複数のりばを1枚のカードに統合
- カード内で上り・下り・行き先別に表示
- GTFS-JPの `calendar.txt` / `calendar_dates.txt` / `stop_times.txt` を利用した時刻表
- GTFS-RT VehiclePositionのProtocol Buffersをブラウザ内で直接解析
- 選択停留所へ向かう車両の現在位置、何停留所前、推定到着分数を表示
- 車両選択後、その先の停留所ごとの推定到着時刻を一覧表示
- 約20秒ごとの自動更新
- 停留所・系統・行き先の検索サジェスト
- お気に入り・最近使った系統

## 推定到着時刻について

東京都交通局の公開GTFS-RTはVehiclePosition（車両位置）です。TripUpdateによる公式到着予測ではないため、本アプリでは次の方法で推定します。

1. リアルタイム車両の `trip_id` と静的GTFS-JPの便を照合
2. `current_stop_sequence` または `stop_id` から現在位置を決定
3. 現在時刻と当該停留所の予定時刻との差を遅れとして計算
4. その遅れを後続停留所の予定時刻へ加算

したがって、交通状況や折返し、臨時運行などにより実際と異なる場合があります。画面では必ず「推定」と表示します。

## 重要：Phase 3のデータは再生成が必要

Phase 4では旧 `data/stops.json` は使用しません。正式GTFS-JPから次を生成します。

- `data/transit-index.json`
- `data/routes/*.json`

```bash
./tools/update_gtfs.sh ~/Downloads/ToeiBus-GTFS.zip
```

または：

```bash
python3 tools/convert_gtfs.py \
  ~/Downloads/ToeiBus-GTFS.zip \
  --output-dir data

python3 tools/validate_dataset.py data/transit-index.json
```

## Ubuntuでローカル実行

```bash
python3 tools/serve.py
```

Chromeで開きます。

```text
http://127.0.0.1:8000
```

## テスト

```bash
npm run check:js
npm run test:js
python3 -m unittest discover -s tests -p "test_*.py" -v
python3 tools/validate_dataset.py data/transit-index.json
```

## リアルタイム情報

初期設定は公開エンドポイントです。

```text
https://api-public.odpt.org/api/v4/gtfs/realtime/ToeiBus
```

設定ファイル：

```text
js/config.js
```

Android ChromeやGitHub PagesからCORSエラーになる場合は、`worker/` のCloudflare Workerを公開し、そのURLを `REALTIME_ENDPOINT` に設定します。

## GitHubへ反映

```bash
git add .
git commit -m "Add grouped stops timetable and realtime tracking"
git push
```

GitHub ActionsはJavaScript・Pythonテストと正式データ検証に成功した場合だけ公開します。

## ライセンス表示

> データ提供元：東京都交通局・公共交通オープンデータ協議会（CC BY 4.0）

本アプリは東京都交通局の公式アプリではありません。
