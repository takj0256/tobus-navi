# 変更履歴

## Phase 4

- 同名停留所を `stop_name` 単位でグループ化
- 同じカード内に複数のりば・上り下りを表示
- 公式サイトへのコピー・遷移機能を廃止
- GTFS-JPの時刻表・運行日・停車順を系統別JSONへ変換
- GTFS-RT VehiclePositionのProtocol Buffersデコーダを追加
- 接近車両の現在位置、停留所数、推定到着分数を追加
- 選択車両の後続停留所への推定到着一覧を追加
- 約20秒ごとのリアルタイム自動更新を追加
- 公開エンドポイントのCORS対策用Cloudflare Workerを任意構成として追加
- データスキーマを4へ更新
- Service Workerキャッシュを `tobus-navi-v5` へ更新
