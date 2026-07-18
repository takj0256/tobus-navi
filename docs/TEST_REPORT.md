# テスト結果

実施日：2026-07-18

## 自動テスト

- Python単体テスト：4件成功
  - GTFSディレクトリ入力
  - GTFS ZIP入力
  - 地域半径フィルタ
  - Haversine距離計算
  - GTFS headsignの原文保持、schema version 2、direction_label廃止の確認を既存テスト内に追加
- JavaScript単体テスト：19件成功
  - Haversine距離と距離表示
  - 半径検索と距離順ソート
  - 同名でもstop_id・のりばが異なる停留所を別項目として保持
  - 停留所名の完全一致・部分一致順位
  - 「新宿駅」から「新宿駅西口」を検索
  - 全角英数字・空白の正規化
  - 系統番号・行き先検索
  - 公式URLの優先順位とフォールバック
  - 行き先表示時の「行き」補完と、既存接尾辞の保持
- JavaScript構文確認：`app.js`, `data.js`, `display.js`, `geo.js`, `official.js`, `sw.js` 成功
- Python構文確認：`convert_gtfs.py`, `serve.py` 成功
- HTML参照ファイル・Service Workerキャッシュ対象の存在確認：成功

## 統合版で確認した内容

- 未許可状態では起動直後に位置情報プロンプトを出さない
- 許可済みの場合のみ起動時に自動検索する
- 拒否済みの場合はブラウザ設定または手動検索を案内する
- 公式サイトは `window.location.assign()` で同じタブに遷移し、ポップアップブロックを回避する
- `direction_label` をデータ・UIから削除する
- GTFSの `trip_headsign` は保存時に加工せず、UI表示時だけ必要に応じて「行き」を補う
- 同名停留所でも別のりば・別stop_idなら検索結果から失われない
- GitHub Pages公開前にJavaScript・Pythonテストを自動実行する

未実施：Android実機でのGPS権限状態別動作、PWAインストール、クリップボード許可、都バス公式サイト遷移確認。
