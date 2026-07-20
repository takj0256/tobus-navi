# 都バスナビ Phase 8

現在地周辺の停留所を検索し、同じのりばを使う複数系統の時刻表・接近順・停留所間の推定位置・後続停留所への推定到着時刻を表示するPWAです。

## Phase 8の変更

- GTFS-RTの車両位置を、前停留所から次停留所までのGTFS-JP所要時間に投影
- 車両位置データの配信時刻から現在までの経過時間を補正
- 表示位置を最大30秒先読み
- 短い区間では先読みを区間所要時間の25%以下に制限
- `STOPPED_AT`（停車中）では先読みしない
- `INCOMING_AT`（接近中）は次停留所直前の範囲に制限
- 連続する位置更新から進行速度を推定し、静的所要時間と合成
- 到着時刻を「約3〜4分」の範囲表示に変更
- 停留所列のバス記号を停留所間へ移動して表示
- 各車両カードに「配信遅延○秒＋先読み○秒で補正」を表示
- 更新周期を20秒から10秒へ短縮
- Cloudflare Workerの障害時キャッシュを最大180秒から90秒へ短縮
- Service Workerキャッシュを `tobus-navi-v9` に更新

## 補正方法

走行中の車両は、概ね次の順で位置と到着時刻を推定します。

1. GTFS-RTのGPS位置から、前停留所―次停留所間の進行率を求める
2. データ取得時刻から現在までの経過時間を加える
3. 最大30秒の先読みを加える
4. GTFS-JP時刻表の停留所間所要時間で進行率を更新する
5. 直近の複数位置がある場合は、観測速度と予定速度を合成する
6. 後続停留所は時刻表上の所要時間を順に加算する

道路形状や渋滞、信号待ちを完全には把握できないため、到着時刻は誤差範囲で表示します。これは東京都交通局の公式到着予測ではありません。

## データ

Phase 6以降で生成済みの次のデータをそのまま使用できます。Phase 8適用だけなら再生成は不要です。

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

発行されたURLを `js/config.js` の `REALTIME_PROXY_ENDPOINT` に設定します。

## GitHubへ反映

```bash
git add .
git commit -m "Correct realtime position with segment travel times"
git push
```

## クレジット

データ提供元：東京都交通局・公共交通オープンデータ協議会（CC BY 4.0）

本アプリは東京都交通局の公式アプリではありません。
