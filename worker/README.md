# 都バスGTFS-RT中継・Phase 11収集Worker

Android ChromeまたはGitHub PagesからODPT公開配信へ直接アクセスできない場合に使用します。
上流通信を8秒で打ち切り、成功したフィードを最大90秒間だけ障害時の予備として保持します。

Phase 11を有効化すると、毎分GTFS-RTを取得して停留所区間イベントをR2へバッチ保存します。重い週間統計はWSL上で日次実行し、集計済みプロファイルだけをD1へ保存します。R2・D1が未設定でも従来の中継機能は動作します。

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

- 毎分Cron：停留所イベント収集、異常判定、R2日次圧縮
- 15分ごと：Open-Meteoから東京中心点の気温・降水・降雪を取得
- 毎分：完了済みの分イベントを古い時間から回収し、最大6時間ずつ時間バッチへ統合
- 毎分：完了済みの東京日付があれば、遅れて到着した時間バッチも既存日次データへ追記

Cloudflare Workers FreeのCPU上限内へ収めるため、直近28日分の中央値、四分位、MAD、
信頼度、天候倍率の再計算は個人PCへ分離します。WSLで次を1日1回実行してください。

```bash
cd ~/bityk/bus/tobus-navi-pwa-integrated
source ~/.nvm/nvm.sh
nvm use 22
./tools/run_phase11_local_aggregation.sh
```

統計計算をTailscale接続したサブPCへ任せる場合は、メインPCで次を実行できます。
R2取得とD1反映だけをメインPC、統計計算だけをサブPCで行います。

```bash
./tools/run_phase11_remote_aggregation.sh
```

メインPCを停止しても自動集計を続ける場合は、常時稼働するサブPCへプロジェクトと
Wrangler認証を用意し、サブPC自身で `run_phase11_local_aggregation.sh` を実行します。
Cron登録前に、同じLinuxユーザーで `npx wrangler@latest whoami` とR2の読み取りが
非対話で成功することを確認してください。集計は前日分の `daily-v2` がない場合に中止し、
D1の `job_status` を `failed` へ更新します。古い `complete` を本日の成功と誤認しません。

PCを常時起動する必要はありません。実行できなかった日はD1の直近結果がそのまま使われ、
次回の実行時にR2の過去28日分から再計算されます。自動化する場合は、例えば毎日4時15分に
次をcrontabへ登録します（登録したPCが起動中のときだけ実行されます）。

```cron
15 4 * * * cd /home/roboko3/bityk/bus/tobus-navi-pwa-integrated && /bin/bash -lc 'source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && ./tools/run_phase11_local_aggregation.sh >> /tmp/tobus-phase11-aggregation.log 2>&1'
```

集計状態は次のコマンドで確認できます。`status=complete`かつ`error`が空なら正常です。

```bash
npx wrangler d1 execute tobus-phase11 --remote \
  --command="SELECT * FROM job_status WHERE job_name='profile-aggregation'"
```

CodexやメインPCが停止中でも5時のメールを送る場合は、サブPCの
`~/.config/tobus-phase11/mail.env`（権限600）へGmailのアプリパスワードを設定します。
通常のGoogleパスワードは使用しません。

```dotenv
PHASE11_GMAIL_USER=your-account@gmail.com
PHASE11_GMAIL_APP_PASSWORD=Googleで発行した16文字のアプリパスワード
PHASE11_REPORT_TO=tatatakakaka1009@gmail.com
```

送信前の確認は `python3 tools/send_phase11_daily_report.py --dry-run`、実送信は
`python3 tools/send_phase11_daily_report.py` です。毎日5時のCron例は次の通りです。

```cron
0 5 * * * /usr/bin/flock -n /home/yachiyo/tobus-phase11-batch/report.lock /bin/bash -lc 'source /home/yachiyo/.nvm/nvm.sh && nvm use 22 >/dev/null && source /home/yachiyo/.config/tobus-phase11/mail.env && cd /home/yachiyo/tobus-phase11-batch/app && python3 tools/send_phase11_daily_report.py >> /home/yachiyo/tobus-phase11-batch/report.log 2>&1'
```

交通APIは異常確定後または300秒以上の重大異常時だけ呼びます。同一区間は10分キャッシュし、月間設定値の80%以降は重大異常のみ、95%以降は照会を停止します。

祝日を休日プロファイルへ分類するには、`wrangler.toml`の`HOLIDAY_DATE_KEYS`へ`YYYY-MM-DD`をカンマ区切りで設定します。日曜日は設定なしでも休日扱いです。

天候補正は`WEATHER_ENABLED=true`の場合に収集します。雨・強雨・雪と、cold/cool/mild/warm/hotの気温帯を区別します。路線別は最低20件、全体フォールバックは最低100件を必要とし、信頼度0.6未満はETAへ適用しません。無料Open-Meteo APIは非商用の評価・プロトタイプ用途を前提とするため、商用運用時は利用条件を再確認してください。

設定後はService Workerのキャッシュ名を上げ、GitHubへpushしてください。
