# Phase 11 統計世代の可逆圧縮と共通化

状態（2026-10-18）：実装・可逆性・互換動作は検証済み。CPU受入条件が未達で、本番Worker/currentと定刻集計には**未適用**。一時反映した集計用コピーは退避版へ復元し、enabled印は作成していない。以下は有効化前の設計と手順であり、現在の本番はv1のまま。

## 目的と境界

生成済み統計の**保存表現だけ**を変える。重複する28日統計を加算・平均すると二重計上になるため行わない。実測/推定の区別、欠損品質、入力日、信頼度、サンプル数、生成時刻は変更しない。元観測のraw/daily/history、D1の旧統計退避、予測アルゴリズムは対象外。

2026-10-17のユーザー承認によるD33。旧世代の削除・自動GC・保持期間変更は含まない。最初の圧縮世代の追加時には旧世代も残るので、バケット総容量が即座に減るとは説明しない。

## 保存構造

```text
profiles-v1/current.json                         # 公開manifest、最後に切替
profiles-v1/generations/<生成ID>-packed-v2-hot/manifest.json
profiles-v1/blobs/gzip/<圧縮バイトのSHA256>.json.gz
profiles-v1/blobs/json/<表本文のSHA256>.json       # アプリ用の軽量参照コピー
profiles-v1/generations/<旧生成ID>/...            # 従来形式も保持
```

manifestは`version:2`、`format:phase11-profile-shards-v2`。統計と品質の集計値、`generated_at`、`source_dates`等は従来と同じ。既存世代の圧縮変換には`source_generation`も記録し、生成日時を変換実施日時に更新しない。古い世代の圧縮を当日集計成功と誤認しない。

各shard/weatherの論理`path`、`bytes`、`sha256`、`count`は、復元した従来JSONを表す。圧縮原本の所在は`storage.key`、圧縮サイズ/ハッシュは`storage.bytes/sha256`、展開サイズは`storage.decoded_bytes`。通常のAPI参照先は`read_storage.key`（identity表形式JSON）で、圧縮原本の展開本文とバイト一致を公開前に検証する。実在確認は各`<prefix>/<storage.key>`と`<prefix>/<read_storage.key>`で行い、v2に旧世代相対pathを連結しない。

圧縮前の本文は`{version:2,kind,columns,rows}`。列名を1回だけ保存し、各行の`generated_at`はmanifestに分離する。Workerが返すときに同じ列順・値で復元する。ほかの値を丸めたり消したりしない。gzip level6はPCで処理する。内容が完全一致する圧縮ブロックは同じSHAキーを使う。似ていても数値が異なるブロックは共有しない。変更されたシャードは全体を1ブロックとして新規保存し、差分チェーンは作らない。

Workerは旧v1とv2を読む。gzip直読試作ではコールド要求のCPU超過リスク（検証時最大33ms）があったため、本番向けは生成日時/列名を分離した軽量なidentity参照コピーを使い、gzipはPC検証・保管用とする。両方を含む総保存量で削減率を報告する。圧縮だけの91.7%削減を本番総量の削減率とは呼ばない。共有本文のキャッシュには生成日時を混ぜず、応答時に各manifestの日時を復元する。欠損/破損時のD1/Phase10フォールバックは従来通り。圧縮2MiB・展開/identity8MiB・5万行/ブロックの上限、SHA・サイズ・列/件数検査を適用し、過大展開を中断する。gzipの直接読込互換性は残すが本番生成には必ずread_storageを付ける。`Content-Encoding:gzip`は付けず、保存バイトを暗黙展開させない。

identity参照試作も120区間要求のコールド最大24ms、追加の遅延復元実験は最大21msで、10ms以内を確認できなかった。比較した旧v1も最大38msであり、新形式だけが原因とはしない。いずれも当該10要求はHTTP200/例外0だったが、無料枠CPU内の継続成功とは判定しない。[公式制限](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)は10ms、稀な超過には柔軟性がある一方、継続超過時には打切り得る（2026-10-18確認）。遅延復元実験は保存量も増え、採用コードから外した。次は参照索引/系統等での部分読込を別途設計し、コールドCPUだけでなくR2操作量・アップロード時間・無料枠を併せて検証する。無制限の再試行や有料化で回避しない。

## 生成と公開

- `PHASE11_PROFILE_STORAGE=packed-v2 node tools/aggregate_phase11_json.mjs ...`で生成する。未指定/`legacy`なら旧形式。
- 既存出力の変換は`node tools/pack_phase11_profiles.mjs INPUT_DIR OUTPUT_DIR`。入力は旧形式のcurrentと世代全ファイルが必要。同じ出力先も可。全ファイルの元SHA/サイズと復元バイト一致を検証してからmanifestを作る。
- 定刻runnerはバッチルートの`profile-storage-v2.enabled`がある場合だけ新形式を有効にする。コード配置と有効化は別作業。
- publisherは全ローカル復元検査→同SHAの遠隔既存本文照合/404だけ新規PUT→GET照合→世代manifest照合→currentを最後にPUT/GET照合、の順。401や本文不一致を欠損扱いして上書きしない。candidate_onlyは引き続き公開拒否。
- プログラムAPIの`publishPhase11Json(dir,{switchCurrent:false})`でcurrentを変えずに準備できる。`expectedCurrentGeneration`は切替直前の世代変更を検出する追加ガード。複数writerの排他の代用にはならない。
- 検証用Workerだけに`PROFILE_MANIFEST_GENERATION`を設定すると、currentではなくその不変manifestを参照する。本番では未設定、検証用WorkerにはCronを登録しない。

## 切替・切戻し・点検

反映前にWorkerの版/設定/ソースとcurrent本文、変更するバッチファイルを私的領域に退避する。集計コピー更新とcurrent切替はaggregation/rawの両flockを取得し、重複実行を避ける。v1互換readerを先に配信し、圧縮世代をstage、検証用WorkerのAPI値/CPUを確認してから切り替える。時刻表公開やメインPCタスクは変更しない。

不具合時は、退避済みの元currentとその元オブジェクトが一致することを確認し、集計ロック下で**元currentを先に**復元・GET検証する。その後に必要なら元Worker版へ戻す。旧readerをv2 currentへ向けない。次回生成の無効化はenabled印を退避し、必要なバッチファイルを退避版へ戻してSHA/構文検査する。新規共有blobは公開参照がないことが確認されるまで消さない。

日次点検はcurrent/manifest全文、記載されたstorageオブジェクト、復元値と各統計件数/信頼度、生成日時、入力日、rawゲートを従来通り確認する。APIの`r2-json`と世代ID、コールド/キャッシュ時のCPU・エラーは別々に確認する。PC計測や短時間の成功をCloudflare CPU上限/翌日定刻の継続成功と同一視しない。

旧世代の整理は今後の別作業。currentと切戻し用manifestから到達するblobを保護し、全manifestの参照集合を検証した上での限定GCが必要。R2 lifecycleでblobを日数一律削除すると、古いが共有中のデータを壊すので設定しない。
