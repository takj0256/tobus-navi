# 開発と運用の引継ぎ

更新日：2026-09-18。端末固有の絶対パス・接続先・認証情報は各PCのGit管理外設定に置く。
以下のコマンドはリポジトリのルートで実行する。

## 開始と終了

入口は [../AGENTS.md](../AGENTS.md)。開始時は次を確認する。

```bash
hostname
pwd
git status --short --branch
git fetch origin
git log --oneline --left-right HEAD...origin/main
```

mainがクリーンで独自コミットがない場合だけ `git merge --ff-only origin/main`。
Gitの履歴を読んだ後、共有文書4ファイルを読む。未追跡ファイルも所有者と用途を確認する。
作業終了時は `git diff --check`、関連ファイルだけをstage、差分確認、commit、push。
相手PCの取り込み後に `git rev-parse HEAD` を比較する。必要ならファイル内容も照合する。

mainへのpushは `.github/workflows/pages.yml` を起動する。共有文書も公開され得るため、個人情報を入れない。
Workerのデプロイ、D1のマイグレーション、集計用コピーの更新はGit pushとは別操作。

## 検証

2026-09-30の補完/ETA原本再生デモは[PHASE11_DUAL_ML_DEMO.md](PHASE11_DUAL_ML_DEMO.md)。新規出力先を指定し、保存済みrawのみをローカルで読む。本番モデル・集計用コピーへ同期せず、推定候補は実測と別保管する。デモを戻すにはローカル閲覧サーバーを停止すればよく、本番rollbackは不要。

小型NNデモの学習・起動・評価手順は[PHASE11_ML_DEMO.md](PHASE11_ML_DEMO.md)。ローカルのdaily-v2を読み、新規出力フォルダーへ学習重みと静的デモを生成する。本番公開器/集計コピーへ移さない。今回の成果物はGit管理外で、ソース共有とモデル配布は別。

- 文書のみ：リンク先、記述の根拠、`git diff --check`、stage内容の機密チェック。
- JavaScriptロジック：Node 22系を基本に `npm run check:js` と `npm run test:js`。
- Python変換処理：対象の `tests/` と既存CI手順を参照。
- UI変更：必要な画面で表示・操作を確認。キャッシュ変更は `sw.js` と整合させる。
- 本番変更：現在のデプロイとローカルソースの一致を確認してから、対象の検証を行う。

## 集計と点検

2026-10-05：D27で公開器は各論理GET/PUT前に最新のWrangler認証情報を読む。長い処理中に通常rawタスクが認証更新しても開始時の古い値を保持しない。401の恒久エラー停止は維持し、PUTを無条件に再送しない。401停止後は通常whoamiで確認し、同世代の全文照合付き再開だけを検討する。token値をログ/文書に出さない。D26と同じ公開器1ファイルの退避/反映/rollback手順で扱う。

2026-10-05：D26の公開再開はexportされたpublishPhase11Jsonを`resumeExisting:true, concurrency:1, retryAttempts:3`で呼ぶ。通常CLIは従来動作。ローカル生成済みフォルダーを保全し、当日対象/28入力、currentの新規退避とmanifest全文一致、原本処理の鮮度/backlog/pending0、共有aggregation.lockを確認する。既存シャードは全文一致を確認して再利用し、404のみPUT。不一致・401・通信失敗時にチェックを外さず停止する。uploadedObjectsとreusedObjectsを別報告。currentの切替/検証前に成功日マーカーを更新しない。集計用コピーの公開器だけを両flock下で退避・同期し、戻す場合は旧公開器を戻す。既存世代や原本を削除しない。

2026-10-05：D25でサブPCのPhase 11タスク3件のWSL Actionを`--exec /usr/bin/env RES_OPTIONS=use-vc /bin/bash ...`に変更。スケジュール・principal・settingsは保持、旧XMLをGit外退避。環境変数は子プロセスのみで、PC/WSL全体のDNS設定変更ではない。切り戻しは退避XMLの元ActionだけをSet-ScheduledTaskで復元し、他設定を維持する。タスクを登録スクリプトで再登録すると既定Actionへ戻り得るため、ホスト側のprefixを再確認する。進行中の旧環境プロセスには反映されず、次の通常raw/日次で実環境と結果を確認する。TCP DNSでも転送低下は別問題として点検する。

2026-10-05：日次復元のR2 PUTのみD24でUTF-8本文サイズに応じ120〜600秒/最大3試行とする。本文サイズ・上限・試行数をログに残す。GET・他の公開器は従来設定を維持。送信速度・再送・送信待ちを確認し、単にWSL停止や無料枠超過と判定しない。反映時は両flock下で日次復元スクリプトを退避し、新policy helperと一組でコピー・構文/cmpを検証。戻す場合は両ロック下で日次復元スクリプトだけを退避版へ戻す（未参照helperは残してよい）。checkpoint/日次/currentを無条件に巻き戻さない。通信低下の根因と翌日定刻成功は別途検証する。

2026-10-04：遅延原本の非後退検証（D23）をPC処理へ追加。Late raw停止時は予定分・captured_at・本文feed/車両時刻・現在checkpointを照合し、真に古い観測は再構築対象として残す。遅延キーをseenへ手動追加したりカーソルを巻き戻したりしない。正しく取り込めた遅延原本はlate_input_reconciliations、日次/世代ではlate_capture_minutesとして記録する。両flock下で実行用ファイルとcheckpoint/status/予算をGit外へ退避して反映し、復旧後はbacklog/pending0・実DB天気・hourly整合・日次世代を検証する。出力や状態が進んだ後は古いcheckpointだけを戻さず、コードの対象限定rollbackと永続outboxの検証から判断する。集計用worker.jsは収集器の非後退2行だけを旧ランタイムへ適用し、未同期のraw-capture依存を持つWorker全体の置換はしない。Worker/PWAの配信とは別操作。

2026-10-03：PC raw処理のD1要求予算は合計3,000書込み/UTC日のまま、非天気を合計2,872で止め、128をweather_current用に確保する（D22）。既存の予算ファイルは消去・リセットしない。09:00 JST以降の通常タスクでD1 observed_atとweather_error解除を確認する。上限に達して異常検知保存が停止することと、原本/hourly/統計公開の失敗を混同しない。反映は共有flock下で直前のprocess_phase11_raw.mjsをGit外へ退避し、この1ファイルのみを同期する。悪化時は両ロック取得後に退避ファイルを戻し、構文・ハッシュを確認する。Worker/PWAデプロイやR2 current変更は不要。

2026-10-02：D21の残存観測公開を集計用コピーに反映。raw configで`available-observations-v1`を選択し、日次監査後に欠損を記録して公開する。欠損日の有効な時間帯を利用し、空白枠は他日の同じ区間/曜日区分/15分枠の実測から予測。過去28日のdaily 404も監査・復元対象。手順/ロールバックは[PHASE11_RAW_INGEST.md](PHASE11_RAW_INGEST.md)。通信・未処理・未保存による停止は残り、公開成功と収集の完全性を分けて時報に記載する。

2026-09-30：raw再試行対策をWorker版`cfd90427-ccdb-4ac8-9af9-e5862d05625a`へ反映した。ソース`baab4d5`、151テスト再成功、保存ログ設定と短時間raw保存を確認。旧版`7a813fd2-4214-408a-beb9-cea4ff96e192`と設定をGit外に退避済み。悪化時はこの旧版へWorker rollbackしobservability設定も退避値に戻す。集計用コピー/PWAの更新とR2 current操作は実施していない。短時間成功とピーク/翌日成功を区別し、過去ログAPI403を未解決として扱う。

2026-09-29のraw取得耐障害化はソースとテストのみ。反映時は直前Worker版・設定を退避し、`worker/worker.js`だけでなく新しい`worker/raw-capture.js`と`worker/wrangler.toml`を一組として検証・配信する。実行用コピー同期は別に記録する。配信後はrawメタデータ、構造化ログの保存・閲覧、CPU/例外数、ピーク時と翌日04:15を確認する。悪化時は退避した直前Worker版へrollbackし、保存ログ設定も旧設定と照合する。R2原本/currentの削除・欠損許可変更はロールバックに含めない。

未加工入力先行保存へ切り替えた環境では[PHASE11_RAW_INGEST.md](PHASE11_RAW_INGEST.md)を優先する。Worker raw、PC処理、時間別、日次、統計公開を別々に点検し、旧state/latest.jsonを最新収集状態と誤認しない。PC専用タスクは2分間隔、04:15前には処理待ちを検査する。

2026-09-22のWorker版は`7d44d902-7ce2-4d6f-bb43-9d3b26d68204`。天気取得とD1保存が成功したとき古いweather_errorを解除する。従来版のエラー文字列だけで現在の失敗を断定せず、weather.fetched_at・weather_attempted_at・D1 observed_atを突き合わせる。この変更だけを戻す場合はWorkerを`418fcc06-66a1-4888-aa4d-ce1407141af7`へrollbackする。CPU軽量化と統計世代は維持する。

2026-09-21から、日次ファイルに加えてJST時間帯別の観測件数を点検する。不具合時は原因の根拠を収集して最小修正・テスト・復旧確認へ進む。Worker CPU上限超過はD1書き込み上限と別問題。`workersInvocationsAdaptive`のstatus/CPU分位値と保存時間帯を照合する。認証401が調査時に出たら通常のWrangler認証更新を行い、過去欠落の原因と混同しない。

CPU暫定修正版はversion `418fcc06-66a1-4888-aa4d-ce1407141af7`。悪化時の直前版は`2988b9fd-f685-4cd4-bc9a-18ef23989944`で、Workerのrollbackを使う（R2世代を戻す操作とは別）。暫定修正版もCron全体24〜30msを実測したため、ピーク時の継続収集を未検証のまま「完治」と報告しない。[CPU障害記録](PHASE11_CPU_INCIDENT.md)参照。

- 予定集計：04:15 Asia/Tokyo。サブPCのcrontabを実際に確認する。
- 予定点検：05:00 Asia/Tokyo。現在の実行ホスト・登録状況は STATUS.md を参照する。
- 集計は開発checkoutとは別の `tobus-phase11-batch/app` コピーを使用する構成。checkoutだけ更新してもバッチには反映されない。
- ログはバッチルートの `aggregation.log`、ロックは同じ場所の `aggregation.lock`。ファイルの存在だけでは保持中と判定しない。
- DB名は `tobus-phase11`、Worker bindingは `DB` と `EVENT_BUCKET`。実設定は `worker/wrangler.toml`。
- 実装の状態テーブルは `job_status`、対象キーは `profile-aggregation`。`aggregation_job_status` を無条件で問い合わせず実スキーマを確認する。
- D1で件数・平均/最大信頼度・最大サンプル数、ジョブ開始/完了日時、R2で昨日と直近28日の日次データを確認する。
- 04:15以降の完了時刻、対象日、ログとDBの一致を確認する。古いcompleteは当日の成功ではない。
- 接続不能は点検不能。ping成功とSSH失敗だけでWSL停止・集計失敗を確定しない。
- `/health` は基本応答とbindingの有無しか示さない。DB・R2の読み書きや日次集計成功の証明にはならない。
- 欠損日と認証のため未確認の日を分ける。日時はJSTを基本にし、UTCとの換算を明示する。

## Phase 11統計JSON（日次生成・公開）

D1へ書き込まず、取得済みの28日分 `daily-v2` から統計JSONを生成する。

```bash
node --max-old-space-size=4096 tools/aggregate_phase11_json.mjs INPUT_DAILY_DIR OUTPUT_DIR
```

出力は `generations/<生成ID>/profiles/<曜日区分>/<15分枠>.json`、`weather-profiles.json`、`manifest.json` と、参照候補の `current.json`。
manifestには入力日、件数、平均・最大信頼度、最大sample_count、各シャードのサイズとSHA-256を含む。

04:15の`tools/run_phase11_local_aggregation.sh`は、直近28日の取得とJSON生成後、`tools/publish_phase11_json_to_r2.mjs`でR2の`profiles-v1/generations/<生成ID>/`へ公開する。各シャードのサイズとSHA-256をローカル検証し、世代manifestのアップロードと再読込が成功した後に限り、`profiles-v1/current.json`を最後に更新する。途中失敗ではcurrentを切り替えず、旧generationも自動削除しない。この経路はD1へ書き込まない。

昨日分の存在確認は、R2の明示的な404だけを欠損として復元へ進む。OAuth更新失敗、タイムアウト、DNS、その他の認証・通信エラーは最大5回再試行し、それでも失敗した場合は欠損と断定せず集計を停止する。復元処理の直接R2 APIアクセスもネットワーク例外とHTTP 408/425/429/5xxを再試行し、401等の恒久4xxは即時停止する。

R2公開は既定3並列。ネットワーク例外と一時HTTPエラー（408、425、429、5xx）は、各要求の120秒タイムアウトと最大8回の指数バックオフで再試行する。401等の恒久4xxは再試行しない。必要時は`PHASE11_R2_CONCURRENCY`で1～12の範囲に調整できるが、接続不安定時にむやみに増やさない。

点検時は`profiles-v1/current.json`の`generated_at`、`source_dates`、件数・信頼度統計を日次成功の一次根拠にする。D1の`job_status`は旧方式の最終実行記録として扱い、新しい当日成功の根拠にしない。R2公開の成功、Workerコードの実装、Workerデプロイ、本番APIでの利用開始を区別する。

WorkerのR2参照コードは2026-09-11に本番反映済み。`profiles-v1/current.json`を5分、選択した世代内シャードとweather JSONを24時間キャッシュし、同一isolate内では最大8 JSONを再利用する。current・generation・generated_at・シャードパス・JSON形式の検証に失敗した場合だけD1へフォールバックする。補正と現在天気はD1を継続利用する。

本番反映時はWorkerを先にデプロイし、`/api/v1/estimates`で次を確認する。

- `profile_generation`がR2 `current.json`と一致する。
- `sources.profiles`と`weather_profiles`が通常時`r2-json`、`corrections`が`d1`になる。
- R2取得を意図的に壊す試験は本番で行わず、テストでD1フォールバックを確認する。本番の自然障害時はログとAPIの`sources`で判定する。
- Pages反映後、接近車両・次発・将来停留所の遅延見込みを実画面で確認し、古い位置情報では「確認中」になることを確認する。
- `sw.js`のキャッシュ名更新と配信ファイルの一致を確認する。

遅延表示はGTFS-JP時刻と推定到着範囲の比較であり、公式の遅延情報ではない。推定幅全体が90秒以上遅い場合だけ遅れ見込みとし、幅が10分を超える場合やリアルタイム位置が古い場合は断定しない。

## 既知の注意と復旧順

Cloudflare D1は変更行数を消費し、まとめてSQL送信しても行数は減らない。料金・上限は変更時に公式情報を確認する。
全件投入の無料枠超過は STATUS.md の未解決問題。再実行前に書き込み量を評価する。

1. WSL/SSHと集計プロセス・ロックの保持状態を確認する。
2. 非対話環境でCloudflare認証を確認する。トークンは秘密情報管理機能等から渡し、値をログに出さない。
3. R2の日次データの存在、元イベントから復元できる範囲を確認する。
4. 必要な修正・復元の後、書き込み予算と整合性を確認して、許可された再集計を行う。
5. ログとDB、公開APIを照合して成功を判定する。

認証切れではfailed状態のDB書き込み自体も失敗し得る。ローカルログを必ず併読する。
Gmail接続は端末・タスクごとに確認する。SMTPスクリプトの存在だけで送信可能と判断しない。

## 端末固有設定

### 2026-09-27 承認済み欠損日の公開

9/24〜26の指定9分だけ、ユーザー承認に基づき残存観測を公開する。日次JSONと世代manifest/currentの`data_quality`に欠損日時と補間0件を記録し、「完全な観測」と扱わない。未承認の分欠損・未処理・未保存は従来どおり公開を停止する。通常runnerのロックと成功日重複防止を維持し、詳細は[未加工入力保存の運用](PHASE11_RAW_INGEST.md)を参照。今回の手動復旧成功と、次回04:15の自動成功は区別する。

### 長期履歴とD1段階移行（2026-09-18）

04:15集計はJSON生成前に取得済み28日分をローカル/R2長期アーカイブへ保存する。保存失敗時は公開前に停止する。04:40の`Tobus Phase11 History Maintenance`は同じaggregation.lockを取得して古い履歴を1回3日、D1旧統計を最大5,000件/UTC日ずつ移す。ローカルのindex・移行stateを消すと重複や予算リセットの原因になるため保持する。

Windows登録は既存の登録スクリプトに`-Maintenance`を付ける。ログイン・AC接続が必要。ログはバッチルートの`history-maintenance.log`、履歴は`history/`、D1移行状態は`legacy-export/`。`.writer-lock`残存時はプロセスを確認してから復旧する。日次成功と履歴保守成功は別に点検する。詳細・残課題は[長期履歴設計](PHASE11_LONG_HISTORY.md)を参照。

### 2026-09-15 日次集計の起動方式

04:15 JSTの起動はWindows Task Schedulerの`Tobus Phase11 Aggregation`を使用する。WSL cronだけでは、ディストリビューション終了中に起動できない。`tools/register_phase11_windows_task.ps1`にローカルのBatchRoot・LinuxUserを指定して登録する（WindowsタイムゾーンはTokyo Standard Time）。登録前の同名タスクはローカルにXML保存する。別PCのタスクは変更しない。

タスクはWSL内の`tools/run_phase11_scheduled.sh BATCH_ROOT`をフォアグラウンド実行する。共有flock、成功日のローカル記録、終了コード伝播により重複と失敗隠蔽を防ぐ。成功記録はR2公開・検証完了後だけ更新する。既存の当日成功記録があれば通常の再起動はスキップする。明示的な再集計は、ロック取得の上で従来の集計スクリプトを使う。成功記録だけを遠隔R2の正常性の証明には使わない。

設定はWakeToRun、StartWhenAvailable、同時実行IgnoreNew、最大2時間、失敗時10分間隔で2回再試行。ログインが必要（ロックは可）。サインアウト中のS4U登録はサブPCで権限不足となったため採用していない。電源断、復帰不可、ログインなしでは実行保証できない。数日停止した場合、復帰時の対象は直前28日で、過去の欠損日をすべて自動復元する設計ではない。

Windows電源設定のAC時スリープ解除タイマーは「有効」にする。サブPCでは「重要のみ」から変更済み。バッテリー時は無効のままとしたため、AC接続で運用する。

28日分のダウンロードは各日最大5回再試行する。404欠損は即停止、その他の取得失敗は再試行を使い切った時点で停止し、不完全な統計を公開しない。過去日欠損の復元は元データを確認して別途実施する。昨日分だけは従来どおり復元を試みる。

移行時は既存cronをバックアップして該当行だけ撤去し、旧`Refresh WSL Ubuntu`はバックアップ後に無効化する。サブPCでは登録タスク経由の手動起動で復旧確認する。翌日の定刻起動とスリープ復帰は別途確認が必要。

`docs/local/`（Git管理外）にプロジェクトパス、SSHホスト別名、バッチ配置、ログパス、認証の保管場所、通知先を記録できる。
秘密そのものはそこにも不要に複製しない。共有が必要なら公開範囲を確認した別の私的な管理手段を使う。
