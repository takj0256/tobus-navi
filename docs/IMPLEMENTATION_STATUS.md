# Phase 4 実装状況

## 完了

- 同名停留所のグループ表示
- のりば別・方面別の系統表示
- 正式GTFS-JPからの時刻表生成
- 曜日・例外運行日の判定
- 24時を超えるGTFS時刻への対応
- GTFS-RT VehiclePositionのバイナリ解析
- trip_id照合
- current_stop_sequence / stop_id / 緯度経度による現在停留所推定
- 遅れ量を用いた後続停留所ETA推定
- 車両選択と進捗一覧
- 自動更新
- GitHub Pages公開前検証

## 実環境で確認が必要

- ODPT公開GTFS-RTエンドポイントのAndroid ChromeからのCORS可否
- 都バス実データにおけるGTFS静的 `trip_id` とGTFS-RT `trip_id` の一致率
- `current_stop_sequence` の実データ充足率
- 実際の交通状況に対する推定到着誤差

## 制限

- 公開リアルタイムデータはVehiclePositionのため、推定到着時刻は公式TripUpdateではない
- 迂回、臨時便、運休、折返し変更を完全には反映できない
- 車両にtrip_idが含まれない場合は静的便と照合できない
- 位置情報だけで現在停留所を推定する場合は道路・交差点で誤差が生じる可能性がある
