# 都バスナビ（正式データ対応・Phase 3）

現在地、停留所名、系統番号、行き先から、都バス停留所と系統を探して公式サイトへ移動するPWAです。

## 今回追加した機能

- デモボタン、デモ表示、デモデータを正式版コードから撤去
- `meta.demo: true` のデータを起動時に拒否
- 停留所・系統・行き先の検索サジェスト
- サジェストのタップ選択
- キーボードの上下キー、Enter、Escによる候補操作
- 最近使った系統を最大8件保存・表示
- お気に入りを停留所内の系統一覧で優先表示
- 最近使った系統を停留所内の系統一覧で優先表示
- GTFSデータ生成日時の表示
- 正式データの公開前検証
- `data/stops.json` をネットワーク優先で更新し、取得後はオフラインでも利用

## 重要：正式GTFSデータは同梱していません

この配布物にはデモの `data/stops.json` を含めていません。
既にGitHubリポジトリに正式な `data/stops.json` がある場合は、そのファイルを保持したまま今回の更新を上書きしてください。

Ubuntuで新しく生成する場合：

```bash
python3 tools/convert_gtfs.py \
  ~/Downloads/ToeiBus-GTFS.zip \
  --output data/stops.json \
  --pretty
```

生成したデータを検証します。

```bash
python3 tools/validate_dataset.py data/stops.json
```

## 既存のGitHubリポジトリへ適用

このZIPを展開し、現在のリポジトリへコピーします。配布物に `data/stops.json` は含まれないため、既存の正式データは削除されません。

```bash
unzip tobus-navi-pwa-phase3.zip
rsync -av \
  tobus-navi-pwa-phase3/ \
  ~/path/to/tobus-navi/

cd ~/path/to/tobus-navi
```

正式データが残っていることを確認します。

```bash
python3 tools/validate_dataset.py data/stops.json
```

## Ubuntuでローカル実行

```bash
cd ~/path/to/tobus-navi
python3 tools/serve.py
```

Chromeで開きます。

```text
http://127.0.0.1:8000
```

## テスト

```bash
npm run test:js
npm run check:js
python3 -m unittest discover -s tests -p "test_*.py" -v
python3 tools/validate_dataset.py data/stops.json
```

JavaScriptテストはNode.js標準の `node:test` を使用するため、npmパッケージの追加インストールは不要です。

## GitHubへ反映

```bash
git status
git add .
git commit -m "Add production search suggestions and recent routes"
git push
```

GitHub Actionsは次をすべて通過した場合のみGitHub Pagesへ公開します。

1. JavaScript単体テスト
2. JavaScript構文確認
3. Python単体テスト
4. 正式停留所データ検証
5. GitHub Pagesへのデプロイ

## 検索サジェスト

入力中に最大8件まで候補を表示します。

- 停留所名
- 系統番号
- 行き先

同じ停留所名、系統番号、行き先は候補内で重複させません。停留所名のよみがながGTFSに含まれている場合、ひらがな入力からも候補を表示します。

## 公式サイト遷移について

固定ディープリンクが未確定のため、現在は系統名と行き先をコピーして、都バス公式の系統検索画面を同じタブで開きます。検証済みURLをJSONの `official_url` に追加した場合は、そのURLを優先します。

## データクレジット

> データ提供元：東京都交通局・公共交通オープンデータ協議会（CC BY 4.0）

## 次の開発候補

- `calendar.txt`、`calendar_dates.txt`、`stop_times.txt`による現在運行中の系統判定
- 停留所・系統の公式ディープリンク解析
- 地図UI
- GTFS-RTによる「あと何停留所・何分」の表示
- GPS誤差と道路反対側を考慮した方面推定
