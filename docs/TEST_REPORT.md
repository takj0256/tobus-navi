# テスト結果

実施日：2026-07-19

## 自動テスト

- JavaScript単体テスト：28件成功
  - Haversine距離
  - 半径検索と距離順
  - 停留所・系統・行き先検索
  - 同名別のりば保持
  - 正式データ受付、デモデータ拒否、空データ拒否
  - 行き先表示
  - 公式URLフォールバック
  - サジェスト索引の重複排除
  - 停留所名・よみがな・系統・行き先候補
  - 候補数上限
- Python単体テスト：7件成功
  - GTFSディレクトリ入力
  - GTFS ZIP入力
  - 地域半径フィルタ
  - Haversine距離
  - 正式データ検証
  - デモデータ拒否
  - 空データ拒否
- JavaScript構文確認：成功
- Python構文確認：成功
- ローカルHTTP配信確認：成功
- Service Worker参照ファイル確認：成功

## 正式データについて

配布ZIPには `data/stops.json` を含めていないため、配布物単体では正式データ検証を実行していません。既存GitHubリポジトリの正式な `data/stops.json` を保持して更新を適用し、次を実行してください。

```bash
python3 tools/validate_dataset.py data/stops.json
```

## 実機で再確認が必要な項目

- Android Chromeでのサジェスト表示とタップ
- ソフトウェアキーボード表示時の候補リスト位置
- 位置情報権限状態別の動作
- PWA更新後のService Worker切り替え
- 都バス公式サイトへの遷移
