# Android実機でのリアルタイム確認

1. GitHub Pagesへ公開後、Android Chromeでアプリを開く。
2. 系統を選び、「接近中のバス」が表示されるか確認する。
3. 画面を30秒程度表示し、最終更新時刻が更新されるか確認する。
4. 画面を別アプリへ切り替えて戻り、直後に再取得されるか確認する。
5. 機内モードを一度有効にし、時刻表は残るが車両位置がオフライン表示になることを確認する。
6. 機内モードを解除し、自動的に再取得されることを確認する。

## 直接取得できない場合

UbuntuでHTTP応答とCORSヘッダーを確認できます。

```bash
python3 tools/check_realtime.py
```

Android側で「ネットワークまたはCORSエラー」と表示される場合は、`worker/` をCloudflare Workersへ公開し、`js/config.js` の `REALTIME_PROXY_ENDPOINT` にURLを設定してください。
