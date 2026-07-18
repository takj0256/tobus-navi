# テスト結果 Phase 5

## 自動テスト

- JavaScript単体テスト：27件成功
- Python単体テスト：11件成功
- JavaScript構文確認：成功
- Cloudflare Worker構文確認：成功
- Python構文確認：成功

## 追加確認項目

- 主取得先失敗後に予備取得先へ移行：成功
- 応答しない取得先をタイムアウトして予備取得先へ移行：成功
- GTFS-RTフィード経過時間と古さの判定：成功
- ローカルHTTP配信で `index.html` と `js/app.js` を取得：成功

## 未確認

実行環境のDNS制限により、ODPT公開GTFS-RTへの実ネットワーク接続は確認できなかった。Android実機または利用者のUbuntu環境で `python3 tools/check_realtime.py` を実行して確認する必要がある。
