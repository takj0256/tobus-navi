# 都バスナビ Phase 11

現在地周辺の都バス停留所を検索し、同じのりばを使う複数系統の時刻表、接近順、停留所間の推定位置、後続停留所への推定到着時刻を表示するPWAです。

## Phase 11の追加

Phase 10の停留所イベント推定を維持しながら、共有の週間運行プロファイルと異常時だけの外部交通補正を追加しました。

- 路線・方向・停留所区間・曜日区分・15分時間帯別の週間中央値
- 信頼度0.3未満は採用せず、GTFS時刻表へフォールバック
- 120秒または1.5倍以上の乖離を異常候補として検出
- 連続区間、複数車両、既存交通キャッシュにより異常を確定
- 300秒以上の重大異常は単独で確定
- 確定前に新規交通API照会を行わない
- 外部補正は異常区間と後続2区間だけへ減衰伝播
- Open-Meteoの現在気象を15分ごとに収集し、天候・気温帯別の所要時間倍率を学習
- 天候倍率は十分な件数と信頼度がある場合だけ遅延方向へ適用
- R2へ生イベントを毎分バッチ保存し、D1には集計済みデータだけを保存
- Workerや外部APIが未設定・停止中でもPhase 10方式を継続
- 選択した系統をOpenStreetMap上で表示する独立した路線マップを追加
- GTFS-RTの車両局番から水素FC・EV・既知のハイブリッドを識別表示
- Service Workerキャッシュを `tobus-navi-v14` へ更新

詳細は[`docs/週間交通プロファイル・異常時補正仕様書.md`](docs/週間交通プロファイル・異常時補正仕様書.md)を参照してください。

## Phase 10の基礎実装

Phase 9では、GTFS-RTの緯度・経度を生の車両GPSとみなし、停留所間へ投影していました。しかし、都営バスの公開フィードを実測すると、公開座標は全車両でGTFS-JPの停留所座標と一致し、停留所が切り替わるまで連続移動しませんでした。

Phase 10では公開データの実態に合わせ、次のように修正しています。

- 公開緯度・経度を生GPSとして使用せず、`stop_id` と `current_stop_sequence` の切替を停留所イベントとして処理
- 同じ車両の連続する停留所イベントから、停留所間の実測所要時間を学習
- 直近45分の先行車実績を優先し、時刻表所要時間と混合して混雑を補正
- 実績を端末内へ最大14日間保存し、同じ時間帯の履歴をフォールバックに利用
- 推定だけで次停留所を通過させず、進行率94%で次の公開イベントを待機
- 後続停留所までの所要時間を、現在区間の残り時間と各区間のGTFS時刻表から個別に累積
- 後続区間にも先行車の混雑実績を反映
- `current_status` が実際に配信された場合だけ停車中・接近中として使用
- 表示を「現在位置」ではなく「推定位置」と明記
- Phase 11が無効な場合もPhase 10の端末内履歴を継続利用

## 今回の想定例

石島停車中から、時刻表上で次の所要時間が設定されている場合：

```text
石島 → 扇橋一丁目：4分
扇橋一丁目 → 猿江一丁目：3分
```

猿江一丁目への到着予測は、各区間を累積して約7分になります。

石島の停留所イベントから2分経過し、石島→扇橋一丁目の推定所要時間が4分なら、石島〜扇橋一丁目間の約50%に表示します。直前のバスが同区間に6分かかっていれば進行率と到着予測を遅く補正します。

## データ

Phase 6以降で生成済みの次のデータをそのまま使用できます。現在の路線マップは停留所間を結ぶ概略表示です。

- `data/transit-index.json`
- `data/routes/*.json`

GTFS自体を更新する場合：

```bash
./tools/update_gtfs.sh ~/Downloads/ToeiBus-GTFS.zip
```

ZIPに `shapes.txt` が含まれていれば、変換時に道路沿いの経路座標も系統別データへ取り込み、路線マップで優先表示します。

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
npx wrangler deploy --dry-run --config worker/wrangler.toml
python3 -m py_compile tools/*.py tests/*.py
python3 -m unittest discover -s tests -p "test_*.py" -v
python3 tools/validate_dataset.py data/transit-index.json
```

## GitHubへ反映

```bash
git add .
git commit -m "Add weekly traffic profiles and anomaly corrections"
git push
```

## 調整値

`js/config.js` で次を調整できます。

- `REALTIME_INFERRED_PROGRESS_MAXIMUM`：公開イベント待ちで止める最大進行率
- `REALTIME_TRAFFIC_RECENT_WINDOW_MS`：直近実績として扱う期間
- `REALTIME_TRAFFIC_MAXIMUM_AGE_MS`：端末に保持する履歴の有効期間
- `REALTIME_TRAFFIC_MAX_SAMPLES`：1区間あたりの最大保存件数
- `PHASE11_API_ENDPOINT`：週間プロファイルAPIのURL
- `PHASE11_REFRESH_MS`：PWA側で共有推定値を更新する間隔

## クレジット

データ提供元：東京都交通局・公共交通オープンデータ協議会（CC BY 4.0）

気象データ： [Open-Meteo.com](https://open-meteo.com/)（CC BY 4.0）

地図データ： [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（ODbL）

本アプリは東京都交通局の公式アプリではありません。
