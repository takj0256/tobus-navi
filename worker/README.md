# 都バスGTFS-RT中継Worker

Android ChromeまたはGitHub PagesからODPT公開配信へ直接アクセスできない場合に使用します。
上流通信を8秒で打ち切り、成功したフィードを最大90秒間だけ障害時の予備として保持します。

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

設定後はService Workerのキャッシュ名を上げ、GitHubへpushしてください。
