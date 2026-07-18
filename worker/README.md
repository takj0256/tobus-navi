# 任意：GTFS-RT CORSプロキシ

GitHub Pagesから公開エンドポイントへ直接アクセスできない場合だけ使用します。

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

発行されたURLを `js/config.js` の `REALTIME_ENDPOINT` に設定します。

```js
export const REALTIME_ENDPOINT = "https://tobus-realtime-proxy.<account>.workers.dev";
```

公開ODPTエンドポイントを中継するだけで、アクセストークンは使用しません。
