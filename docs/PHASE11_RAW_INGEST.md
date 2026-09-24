# 未加工入力先行保存とPC処理

2026-09-23。CPU上限超過による収集欠落への対策。既存の区間秒数・予測モデルの定義は変更しない。

## 境界

1. Worker毎分CronはGTFS-RTを取得し、復号せず `raw-v1/UTC日/時/分.pb` に保存して終了。1〜524,288 bytesのみ受け付ける。条件付きPUTで同じ予定分の最初の保存を保持する。失敗は成功扱いにしない。
2. Windowsの `Tobus Phase11 Raw Processor` が2分ごとにWSLを起動。公開から90秒経過した入力を昇順に処理。ローカルgzip保存・検証後、既存の復号・区間イベント生成を実行する。
3. 車両状態、カーソル、入力SHA-256、時間別出力待ちを一つのcheckpointへatomic renameで確定。R2 hourlyはevent_idで既存値と統合し再読込検証後に出力待ちを消す。失敗・再起動で二重加算しない。既存events/hourlyを削除しない。
4. 04:15の日次処理は同じflockを取り、昨日末までのrawを処理してからdaily-v2を作る。未処理やraw取得分の穴があればcurrent公開前に止める。日次JSONから先の集計・長期アーカイブ・R2世代公開は従来通り。

## 補正と鮮度

PCでの天気取得タイムアウトは15秒。従来のWorker用5秒では実測6.142秒の正常応答を打ち切ったため分離した。失敗時は既存の15分間隔で再試行し、成功時にエラーを解除する。取得失敗がバスの元観測保存を止めることはない。

5分以内の入力に限り、PCで天気更新・異常判定を行う。天気のfetched_atは実際の処理時刻。交通APIの秘密はWorker内に残し、PC専用256bitランダム認証値を使う `/internal/phase11/traffic` へ確定済み候補を送る。5分より古いイベントや不正座標は拒否。既存の月間交通予算・キャッシュ・D1補正を維持する。

遅延再生では現在天気・現在交通を過去へ捏造しない。5分超の入力は新規ライブ補正を行わず `replayed_without_live_enrichment` に記録する。既存の過去天気が2時間以内の場合だけ既存ルールで参照する。過去に収集されなかった入力を生成しない。

PCのD1操作はweather_current/anomaliesの単一行INSERTのみ。profilesへの書き込み・全件SELECT・DDL/DELETEは禁止。予約方式でUTC日あたり読み取り3,000要求・書き込み3,000要求を上限とし、不確実な失敗も予算を戻さない。これはアカウント全体の行予算ではない。超過時は補正のエラーを記録し、元観測保存は継続する。交通用Workerの既存D1使用量と分けて点検する。

## 保存量・停止時

R2 `raw-v1/` だけを3日で期限切れにする。他領域の既存ライフサイクルは保持する。最大512KiB×1,440分×3日＝約2.27GB（期限処理の遅延分は別）。導入前のバケット実測約3.85GB、上限入力仮定でも合計約6.12GB。毎分PUTは約43,200回/30日。PCのLIST/読取/時間別出力と既存利用も加算されるため無料を永久保証しない。

PCのgzipコピーは自動削除しない。PC停止が70時間を超えたら処理を止め、R2期限切れ前の復旧またはローカル保管からの再構築を要する。遅れてカーソル以前のrawが出現した場合も停止する。3日以上停止してローカルにもない入力は復元できない。Windowsログイン・AC接続は既存運用条件。ログ、rawコピー、checkpointのディスク容量を点検する。

## 配置・点検

2026-09-25：3種類のPC runnerは`phase11_auth.sh`で認証事前確認のみ最大3回（間隔2/4秒）試す。一時的なOAuth更新接続タイムアウトへの対策であり、長時間のネットワーク障害を保証付きで解消するものではない。切り戻す場合は両バッチロック下で退避した3runnerを戻す（未参照helperは残してよい）。raw欠損が復元できない日を無断で公開せず、当日日次不在が次回28日取得も止め得ることを報告する。

`tools/prepare_phase11_raw.mjs EXTERNAL_ROOT WORKER_URL` はGit外にmode 0600の専用認証値と旧状態・ライフサイクルを保存する。秘密値をログ・共有文書に出さない。実デプロイの最初のraw時刻を `config.json.start_at` にしてから定期処理を開始する。Workerは `COLLECTION_MODE=raw-v1`。ソース、Worker配信、batch/appコピー、Windowsタスクは別々に確認する。

- ローカル：`raw-processor.log`、`raw-processor/status.json`、`checkpoint.json`、`raw-processor.lock`。
- R2：最新rawの保存時刻・サイズ・分欠損、`state/processor-v1.json`のchecked_at、cursor、backlog、pending_hours、missing_capture_minutes_last_day、weather/anomaly_error。
- `state/latest.json`は旧Worker収集の最終状態。切替後の鮮度根拠にしない。
- Raw入力が保存されたこと、PC復号完了、hourly公開、daily/current公開を区別する。捕捉したエラーがあってもCLI終了0になり得るため、補正エラー欄も点検する。
- 通常CLIはflock付きrunner経由で起動する。同じrootを直接CLIで並行処理しない。

2026-09-24：PCストレージクライアントは401 GETについて、OAuth期限切れ/期限まで30秒以内の場合のみWranglerの通常更新とトークン再読込を1回試みる。更新後トークンが変わらなければ失敗のまま停止する。APIトークン・403・書込PUT・D1 POSTには適用しない。403や通信障害を権限変更で回避せず、次回成功と根本原因特定を区別する。修正版を戻す場合は両バッチロックを確保し、Git外に退避した旧storageクライアント1ファイルを戻して一致を確認する。

## 切り戻し

1. PC処理タスクを無効にし、実行中プロセス・ロックを確認して待つ。旧/新の同時hourly更新を避ける。
2. Workerを切替直前版へrollback（導入記録のversionを使用）。rawの追加は停止するが残るraw・checkpoint・gzipを削除しない。
3. 集計用コピーを日付付き退避版へ戻す。`PHASE11_RAW_DIR`による公開前ゲートも旧版へ戻る。過去のR2 currentを無条件に戻さない。
4. raw専用期限を止める必要があれば、その1ルールだけ無効化する。復旧データ保全と容量を再確認する。他のルールを消さない。

検証：疑似R2で取得失敗・サイズ超過・条件付き重複保存、順序再生、壊れた入力、401、公開途中失敗/再開、既存hourly保持、保持期間切れ、取得分欠損による日次拒否、認証なし交通要求拒否をテストする。本番では複数CronとPC公開を追跡し、ピークCPU・翌朝04:15は別途確認する。

参考：[R2料金](https://developers.cloudflare.com/r2/pricing/)、[R2条件付きPUT](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。
