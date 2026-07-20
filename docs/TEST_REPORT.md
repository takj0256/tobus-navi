# テスト結果 Phase 8

実行日：2026-07-20

## 自動テスト

- JavaScript構文確認：成功
- JavaScript単体テスト：41件成功、失敗0件
- Python構文確認：成功
- Python単体テスト：14件成功、失敗0件
- Service Worker構文確認：成功
- Cloudflare Worker構文確認：成功
- ローカルHTTP配信：成功（`http://127.0.0.1:8000`）
- `index.html` のローカル参照ファイル：欠落なし
- Service WorkerのAPP_SHELL参照：欠落なし

## Phase 8追加テスト

- 配信遅延＋最大30秒先読みで位置が前進する
- 先読みありの到着予測が、先読みなしより約30秒早くなる
- 短区間では先読みを区間所要時間の25%へ制限する
- 停車中は先読みを適用しない
- 複数回の位置観測を車両別に保持する
- 観測履歴から進行速度を推定できる
- 到着時刻を誤差範囲で表示できる
- 停留所間進行率をレーン上のマーカー位置へ反映する

## 実機確認が必要な項目

- ODPT公開GTFS-RTへの実通信
- Android Chrome上のCORS挙動
- 実際のバス位置と補正位置の差
- 最大30秒先読みが路線・時間帯ごとに過剰でないか
- 10秒更新時の電池消費と通信量
- Cloudflare Worker障害時キャッシュの動作

## データ検証について

配布ZIPには利用者の正式GTFS生成物 `data/transit-index.json` と `data/routes/*.json` を含めていないため、正式データ検証は適用先リポジトリで次を実行してください。

```bash
python3 tools/validate_dataset.py data/transit-index.json
```
