# 開発と運用の引継ぎ

更新日：2026-09-11。端末固有の絶対パス・接続先・認証情報は各PCのGit管理外設定に置く。
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

- 文書のみ：リンク先、記述の根拠、`git diff --check`、stage内容の機密チェック。
- JavaScriptロジック：Node 22系を基本に `npm run check:js` と `npm run test:js`。
- Python変換処理：対象の `tests/` と既存CI手順を参照。
- UI変更：必要な画面で表示・操作を確認。キャッシュ変更は `sw.js` と整合させる。
- 本番変更：現在のデプロイとローカルソースの一致を確認してから、対象の検証を行う。

## 集計と点検

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

`docs/local/`（Git管理外）にプロジェクトパス、SSHホスト別名、バッチ配置、ログパス、認証の保管場所、通知先を記録できる。
秘密そのものはそこにも不要に複製しない。共有が必要なら公開範囲を確認した別の私的な管理手段を使う。
