# 変更履歴

## 0.4.0 — 2026-07-19

- 正式版移行に伴い、デモボタン・デモ表示・デモデータを撤去
- `meta.demo: true` または停留所0件のデータを起動時に拒否
- 停留所名・系統番号・行き先の検索サジェストを追加
- 停留所名のよみがなによるサジェストを追加
- 候補のタップ、上下キー、Enter、Esc操作に対応
- 最近使った系統を最大8件保存して再表示
- お気に入りと最近使った系統を停留所内で優先表示
- GTFSデータ生成日時を画面とAboutに表示
- 正式データ検証スクリプト `tools/validate_dataset.py` を追加
- GitHub Pages公開前に正式データ検証を追加
- `data/stops.json` をService Workerのネットワーク優先対象へ変更
- Service Workerキャッシュを `tobus-navi-v4` に更新
- JavaScriptテストを28件、Pythonテストを7件へ拡充

## 0.3.0 — 2026-07-18

- GTFSの `trip_headsign` は原文のまま保持し、画面表示時だけ必要に応じて「行き」を補完
- 行き先表示処理を `js/display.js` に分離
- 同名でも `stop_id`・のりばが異なる停留所を別項目として保持するテストを追加
- GitHub Pages公開前のJavaScript・Python自動テストを追加
