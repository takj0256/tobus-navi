# 変更履歴

## 0.3.0 — 2026-07-18

- 0.2.0を基盤に、Claude版の有用な改善点を統合
- GTFSの `trip_headsign` は原文のまま保持し、画面表示時だけ必要に応じて「行き」を補完
- 行き先表示処理を `js/display.js` に分離し、単体テスト可能な構成へ変更
- 同名でも `stop_id`・のりばが異なる停留所を別項目として保持するテストを追加
- JavaScript単体テストを19件へ拡充
- Service Workerキャッシュ名を `tobus-navi-v3` に更新し、`display.js` をキャッシュ対象に追加
- GitHub Pages公開前のJavaScript・Python自動テストは継続

## 0.2.0 — 2026-07-18

- 位置情報が未許可の初回起動では、自動的に権限プロンプトを表示しないよう変更
- 位置情報が許可済みの場合のみ、起動時に周辺検索を自動実行
- 公式サイト遷移を同一タブの `window.location.assign()` に変更し、ポップアップブロックを回避
- 停留所単位では意味が曖昧な `direction_label` をデータとUIから削除
- GTFSの `trip_headsign` を加工せず原文のまま保持
- 手動検索の正規化を修正し、「新宿駅」で「新宿駅西口」も検索可能に変更
- Node.js標準テストを13件追加
- GitHub Pages公開ワークフローにPython・JavaScriptテストを追加
- Service Workerキャッシュ名を `tobus-navi-v2` に更新
