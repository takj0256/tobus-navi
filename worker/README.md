# 都バスGTFS-RT中継・Phase 11集計Worker

Android ChromeまたはGitHub PagesからODPT公開配信へ直接アクセスできない場合に使用します。
上流通信を8秒で打ち切り、成功したフィードを最大90秒間だけ障害時の予備として保持します。

Phase 11を有効化すると、毎分GTFS-RTを取得して停留所区間イベントをR2へバッチ保存し、集計済み週間プロファイル、異常状態、外部交通補正だけをD1へ保存します。R2・D1が未設定でも従来の中継機能は動作します。

## Phase 11リソース作成

最新Wranglerを利用する場合はNode.js 22以上を用意してください。

```bash
cd worker
npx wrangler login
npx wrangler d1 create tobus-phase11
npx wrangler r2 bucket create tobus-phase11-events
```

`wrangler.toml`の`[[d1_databases]]`と`[[r2_buckets]]`をコメント解除し、D1作成時に表示された`database_id`を設定します。

```bash
npx wrangler d1 migrations apply tobus-phase11 --remote
```

TomTomによる異常時補正を有効にする場合だけ、APIキーをSecretへ登録します。未登録時は週間実績とPhase 10履歴だけで推定します。

```bash
npx wrangler secret put TOMTOM_API_KEY
```

## 公開

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

表示されたURLを `js/config.js` の `REALTIME_PROXY_ENDPOINT` に設定します。

```js
export const REALTIME_PROXY_ENDPOINT = "https://your-worker.workers.dev";
```

`PHASE11_API_ENDPOINT`は既定で同じURLを使います。別Workerに分ける場合だけ`js/config.js`で変更してください。

## API

- `GET /`：従来のGTFS-RT中継
- `GET /health`：R2・D1設定状況
- `POST /api/v1/estimates`：複数区間の週間プロファイルと有効補正
- `GET /api/v1/profiles`：単一区間プロファイル
- `GET /api/v1/corrections`：単一区間補正

## 定期処理

- 毎分：停留所イベント収集、異常判定
- 毎時：毎分R2オブジェクトを時間バッチへ統合
- 毎日4時（日本時間）：直近28日の時間バッチから週間プロファイルを再生成

交通APIは異常確定後または300秒以上の重大異常時だけ呼びます。同一区間は10分キャッシュし、月間設定値の80%以降は重大異常のみ、95%以降は照会を停止します。

祝日を休日プロファイルへ分類するには、`wrangler.toml`の`HOLIDAY_DATE_KEYS`へ`YYYY-MM-DD`をカンマ区切りで設定します。日曜日は設定なしでも休日扱いです。

設定後はService Workerのキャッシュ名を上げ、GitHubへpushしてください。
