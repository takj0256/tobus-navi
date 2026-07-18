# 都バスナビ（PWA版MVP）

現在地または停留所名から、近くの都バス停留所・系統・行き先を表示し、都バス公式サイトへ移動するスマートフォン向けPWAです。

## 実装済み

- Geolocation APIによる現在地取得
- 位置情報が許可済みの場合のみ起動時に自動検索し、未許可時はボタン操作を待つ権限制御
- 半径200 / 300 / 500 / 1000mの停留所検索
- Haversine距離計算と距離順表示
- 同名停留所をstop_id・のりば単位で別表示
- 系統番号・行き先表示（GTFS原文は保持し、画面上だけ必要に応じて「行き」を補完）
- 停留所／駅名の手動検索
- 公式サイトを開く際に系統名・行き先をクリップボードへコピーし、同じタブで確実に遷移
- お気に入り保存（localStorage）
- Web App Manifest、Service Worker、オフラインキャッシュ
- GTFS/GTFS-JP ZIPをアプリ用JSONへ変換するPythonスクリプト

## 重要：現在はデモデータ

`data/stops.json` は画面確認用の少量デモデータです。位置・乗り場・行き先の正確性を保証しません。実運用前に、公共交通オープンデータセンターから取得した東京都交通局のGTFS-JPへ差し替えてください。

## ローカル起動

位置情報とService Workerは `file://` で正しく動作しないため、HTTPサーバー経由で開きます。

```bash
cd tobus-navi-pwa
python tools/serve.py
```

Chromeで次を開きます。

```text
http://127.0.0.1:8000
```

Android実機で試す場合は、GitHub PagesなどHTTPS環境へ公開するのが簡単です。

## 公式GTFS-JPを取り込む

1. 公共交通オープンデータセンターへ登録し、東京都交通局のバス関連情報（GTFS/GTFS-JP）を取得します。
2. ZIPのまま次を実行します。

```bash
python tools/convert_gtfs.py /path/to/toei_gtfs.zip \
  --output data/stops.json \
  --pretty
```

東京中心部などに絞ってJSONを小さくする例：

```bash
python tools/convert_gtfs.py /path/to/toei_gtfs.zip \
  --output data/stops.json \
  --center-lat 35.6812 \
  --center-lon 139.7671 \
  --radius-km 15 \
  --pretty
```

変換対象ファイル：

- `stops.txt`
- `routes.txt`
- `trips.txt`
- `stop_times.txt`

## 公式サイト遷移について

都バス公式サイトは検索・画面遷移型で、停留所・系統を必ず直接開ける固定URL仕様が確認できていません。そのため、現版では系統名と行き先をコピーし、公式の「系統から探す」画面を同じタブで開きます。ブラウザの「戻る」で本アプリへ戻れます。

直接URLが特定できた場合は、変換後JSONの各routeに次を追加すると、そのURLを優先して開きます。

```json
{
  "route_id": "...",
  "route_name": "都01",
  "headsign": "新橋駅前",
  "official_url": "https://tobus.jp/..."
}
```

`headsign` は変換時に変更せず保存し、画面では必要に応じて「新橋駅前行き」のように表示します。

## GitHub Pagesへ公開

1. このフォルダをGitHubリポジトリへpushします。
2. GitHubの `Settings` → `Pages` で `GitHub Actions` を選択します。
3. 同梱の `.github/workflows/pages.yml` が公開を行います。

PWAのインストールと位置情報利用にはHTTPSまたはlocalhostが必要です。

## テスト

```bash
python -m unittest discover -s tests -p "test_*.py" -v
npm run test:js
npm run check:js
```

JavaScriptテストはNode.js標準の `node:test` を使用しており、追加パッケージのインストールは不要です。

## データクレジット

公式GTFS-JPを使用する場合：

> データ提供元：東京都交通局・公共交通オープンデータ協議会（CC BY 4.0）

## 今後の主要課題

- 公式サイトの停留所・系統ディープリンク調査
- `calendar.txt` / `calendar_dates.txt` / 時刻表を使った現在時刻の運行判定
- 大規模データの地域分割・遅延ロード
- GTFS-RTによる「あと何停留所・何分」の自前表示
- GPS誤差や道路反対側を考慮した方面推定
