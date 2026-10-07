# 公開・運用メモ

## 対象

- GitHub: `MARUGO-s/multiapp`、Pages `/multiapp/`、`main` のGitHub Actionsでフロントを公開。
- Supabase: `Recipe-Management` / `hjhkccbktkscwtgzxjfq`。他アプリと共用。
- 追加領域: `kotonoha.meetings`、`kotonoha.settings`、`kotonoha.access_config`、`kotonoha.sessions`、`kotonoha.login_attempts`、service_role限定RPC `public.kotonoha_store` / `public.kotonoha_auth`、非公開バケット `kotonoha-audio`、Edge Function `kotonoha-api`。
- Authユーザー・設定・既存のOpenAIキーは変更しない。フロントにあるのは公開用publishable keyのみ。

## 更新

フロントは `main` に反映するとビルド・テスト後にPagesへ公開します。Supabaseの自動マイグレーションはしません。

2026-10-07のお披露目用共通QRログインは、未適用の `20261007100000_shared_qr_login.sql` だけを対象プロジェクトに適用し、`marugo-accounts` と `marugo-qr` を先に更新してからPagesを公開します。`kotonoha-api` のパスワードやログイン処理は変更不要です。共通セッションの期限・失効・パスワード認証由来を要求ごとに確認します。共通権限の停止はREADMEの `qr_shared_login_enabled=false` で行います。

AAC・複数録音対応はEdge Functionとフロントの更新のみで、DBマイグレーションは不要です。専用会議documentの `audioParts` に順序・保存パス・完了済み文字起こしを保持します。旧 `audio_path` は先頭音声を指し、既存単一録音にはフォールバックします。AACは保存前にM4Aへ変換するため、既存バケットのMIME制限・容量設定も変更しません。ロールバックする際は複数録音に対応した版を維持してください（旧版では先頭以外の録音を処理できません）。

```sh
supabase functions deploy kotonoha-api --project-ref hjhkccbktkscwtgzxjfq --no-verify-jwt
```

`verify_jwt=false` は会議データの公開を意味しません。ログインとプリフライトのみ未認証で利用できます。データ要求のBearerトークンは `kotonoha_auth` で専用セッションのハッシュ・有効期限・失効を検証します。全セッションに同じworkspace_idを付与し、既存Supabase Authトークンは受け付けません。

共通ログインの設定は `node scripts/configure-shared-login.mjs` を実行し、標準入力へ `loginId` / `password` のJSONを1行渡します（TTY入力は非表示）。パスワードをソース、コマンド引数、GitHubへ保存しないでください。設定時は会議録の既存セッションだけを失効させます。他アプリのAuthユーザー・セッションは変更しません。

初回の専用暗号化鍵のみ、`node scripts/init-cloud-secret.mjs` で作成できます。すでにある場合は変更しません。鍵をローテーションすると既存の暗号文を読めなくなるため、無断で変更しないでください。

## DB変更の注意

2026年9月28日の集計・タグ・比較の安定化は、`kotonoha-api` とフロントの更新のみです。DBマイグレーション・キー再設定は不要です。タグは既存の会議document、AIサマリー・タグ提案の用途区分は既存の使用料documentに保存します。APIを先に更新し、その後PRをmainへマージしてPagesの公開完了を確認します。ロールバックは該当変更のrevert PRと対応するAPIの再デプロイで行い、DBをリセットしません。

API使用料ページは `20260924000400_kotonoha_api_usage.sql` のみを適用してからEdge Function・フロントを公開します。会議録専用 `kotonoha.api_usage` とservice_role限定 `public.kotonoha_usage` RPCを追加します。他アプリのテーブル・Auth・Storageには触れません。マイグレーション前の料金は復元できません。`tests/cloud-usage-database.sql` は管理者権限でロールバック付きの所有者分離・重複防止・権限テストを行います。

カレンダー対応は `20260923000500_kotonoha_calendar.sql` のみを適用してからEdge Function・フロントを公開します。service_role限定 `public.kotonoha_calendar` を追加し、既存専用会議documentの `calendarOverrides` に1予定ずつ行ロックで保存します。共有の業務テーブル・Auth・Storageは変更しません。本文編集は従来のPATCHで保存し、予定とは独立しています。再生成時も手動変更を残します。

Gemini文字起こし対応は `20260924000100_kotonoha_gemini_transcription.sql` のみを適用してからEdge Function・フロントを公開します。会議録専用 `kotonoha.settings` に文字起こしモデルと暗号化Geminiキー列を追加し、service_role限定 `public.kotonoha_settings` RPCで操作します。既存のOpenAIキー、業務テーブル、Auth、Storageには触れません。`gemini-1.5-flash` は提供終了済みのため `gemini-3.5-transcribe` を使用します。

添付資料対応は `20260923000400_kotonoha_attachments.sql` のみを適用してからEdge Function・フロントを公開します。専用の非公開 `kotonoha-documents` バケット（各10 MB）とservice_role限定 `public.kotonoha_attachments` RPCを追加します。共用のStorageポリシー・Auth・業務テーブルは変更しません。資料のメタデータは既存専用会議documentの `attachments` / `attachmentPlan` に保存します。保存後の完了・変更は行ロックで排他制御し、同時追加でも個数・合計容量を超えません。

添付資料の保存専用化（AI解析に使わない）は `20260925000100_kotonoha_attachments_storage_only.sql` のみを適用してからEdge Function・フロントを公開します。専用RPC `public.kotonoha_attachments` を置き換え、資料の追加・解除で `minutesStale` を立てないようにするだけです。権限・バケット・共用のAuth/Storage/業務テーブルは変更しません。未適用でもEdge Functionは資料をAIへ送りませんが、資料の追加・解除後に「未反映」表示が出ます。

関連付けを解除した資料は `document.removedAttachments` とStorageに保持します。復元時は対象の会議・資料ID・パスを照合して管理者がメタデータを戻します（最大5ファイル・25 MB制限を再確認）。完全消去時は `attachments` と `removedAttachments` の**両方**の保存パスを確認し、明示した対象だけを消去します。バケット全体を削除しないでください。解析中の変更は禁止です。過去の資料非対応版へ戻すと添付資料を表示・ダウンロードできないため、ロールバックは添付資料対応版に限ります。

**`supabase db push` / `db reset` をこの共用プロジェクトで実行しないでください。** 他アプリの履歴とローカル履歴は一致しません。SQLをレビューし、会議録用の対象マイグレーション1件のみを明示的に適用します。初期マイグレーションは再実行用ではありません。

既存DBを変更しないことを、追加前後の定義ハッシュで照合しました（2026-09-23）。既存テーブル内の業務データは更新していません。

| 比較対象                                             | 件数 | MD5（定義比較用）                |
| ---------------------------------------------------- | ---: | -------------------------------- |
| publicの列定義                                       |  318 | b779f5e2187d7ec891d0f77dbb73ee88 |
| 既存public関数（kotonoha_store / kotonoha_auth除外） |   74 | 7c76ace151d6e5d4d7a6027a33012a95 |
| 既存Storageポリシー                                  |    5 | ba55e1dd66a64e922137bf55e02e6189 |

DB実動確認は `tests/cloud-database.sql` を使用します。専用領域にランダムなテスト所有者で書き込み、所有者分離・編集・削除・古いジョブの上書き拒否を確認後、トランザクションをROLLBACKします。Authユーザーや他アプリの行は作成しません。

共有認証のDB実動確認は `tests/shared-auth-database.sql` で行います。共通パスワード・セッションをトランザクション内で仮設定し、ログイン失敗制限・共有閲覧・失効・期限切れを検証後に必ずROLLBACKします。個別利用者ではなく、DBが生成した共通workspace_idで会議を保存します。共通化マイグレーションは会議レコードのみ移管し、個人APIキーは転用しません。

## 添付資料対応の検証（2026-09-23）

- `tests/cloud-attachments-database.sql` の専用テスト行で、資料未保存時の開始拒否・追加／解除・解析中変更拒否・容量／件数上限・別所有者拒否・service_role限定実行を確認しました。テスト行はその場で削除します。
- 他アプリのpublic関数・public列定義・Storageポリシーの定義ハッシュを追加前後で照合し、一致しました。既存バケットの公開設定・容量制限も不変です。追加したのは専用バケットと専用RPCだけです。
- `node scripts/check-cloud-attachments.mjs` は**実課金あり**の検証です。隠した標準入力に共通ログインのJSONを渡します。サーバー内の既存キーを使い、架空のPDF・DOCX・XLSX（合計4,154バイト）を原本とハッシュ照合、別セッションから共有閲覧、1件の実AI生成を確認します。確認後は作成した会議だけを論理削除し、検証資料は復元可能なまま保持します。
- 実際の `gpt-6-astra` で3資料全件の照合結果を取得。資料案10月1日／80万円と会議決定10月15日／60万円の差異、未決定のテレビ広告案、PDFページ・Excelシートの根拠を確認しました。実モデルでのSol・旧Office形式・大容量資料の網羅検証ではありません。
- Nodeテスト28件、クラウドHTTPテスト1件（音声＋資料／テキスト＋資料の入出力、私有パス非公開、再生成・解除等）、UIで新規添付・既存会議への追加・再生成・未反映表示の解消を確認します。通常テストでは実API課金は発生しません。

## カレンダー・本文編集の検証（2026-09-23）

- Node35件とクラウドHTTP1件が成功。日付・閏年・期間・曖昧な表現、旧議事録の互換表示、手動変更の永続化と再生成後の保持、別ログインでの本文・予定共有を確認。
- `node scripts/check-cloud-calendar.mjs` は**実課金あり（架空の会話1件）**。隠した標準入力に共通ログインのJSONを渡します。実際の `gpt-6-astra` で10月15日14–15時／本社会議室／佐藤、明日9月24日の期限、10月18日の未決定案、日付未定を分けて取得しました。中止した旧日程10月1日は登録されませんでした。
- 公開APIを通して2セッションで別々の予定を編集し、相互に消えないこと、元の根拠を保持すること、本文編集が共有されること、1件だけ変更解除できることを確認。検証会議だけを論理削除し、既存の実会議は変更していません。
- Supabase接続のSQL実行は `supabase_read_only_user` のため、書き込み型の `tests/cloud-calendar-database.sql` は権限拒否されました。権限は拡張せず、実際の保存経路である公開Edge APIの上記検証を実施しました。同SQLは管理者権限の検証用として残しています。
- 他アプリpublic関数 `7af59434191676da1f1a0fcff37af937`、public列定義 `900122c8d03a27b20423f3d6b61c45c4`、Storageポリシー `9c044294871791de09c995a1fc1230b3` の定義ハッシュが追加前後で一致。新RPCはanon/authenticated不可、service_roleのみ実行可。
- `node scripts/check-calendar-server.mjs` は架空のローカルデータだけのUI検証用サーバー（5192）です。終了時に作成した一時ディレクトリだけを削除します。実際のOpenAIは呼びません。

## Gemini文字起こしの修正（2026-09-24）

- `gemini-3.5-transcribe` を旧 `generateContent` と `candidates` 形式で呼び出していたため、応答を読めず `EMPTY_AUDIO` と誤判定していました。[公式仕様](https://ai.google.dev/gemini-api/docs/transcribe) に合わせ、`POST /v1beta/interactions`、`generation_config.transcription_config`、`steps` の `model_output` に修正しました。
- 応答形式の不一致・処理未完了・空の文字起こしを別のエラーとして扱います。`store: false` と処理後の一時ファイル削除要求を使用し、ファイル準備に失敗した場合も後片付けします。DBマイグレーション・キー再設定は不要です。
- Node45件、Edge Functionの型検査、クラウドHTTPテスト1件が成功。回帰テストは公式REST形式を使用し、思考や入力の混入、部分結果の誤採用、空応答の誤判定、エラー時のファイル後片付けを確認します。
- 本番で失敗していた会議1件を保存済み音声から再試行し、Geminiによる4分割すべての文字起こしを確認しました。途中のGoogle HTTP 429は1分以上待って未完了の1分割だけを再試行し、保存済み3分割を保持して回復しました。429自体を自動再試行する変更は含みません。

## Geminiの送信間隔・429自動再開（2026-09-24）

- 上記の手動再試行を改善し、ワークスペース全体でGemini文字起こしを直列化。各部分の完了後30秒以上間隔を空けます。一時的な429は約1・2・4・8・16分＋小さな揺らぎで、1部分につき最大5回再試行します。`Retry-After` / Google `RetryInfo` の方が長ければ優先します。日次上限・ゼロ利用枠が明示された場合は停止して案内します。利用制限の回避を保証するものではありません。
- 専用マイグレーション `20260924000300_kotonoha_gemini_throttle.sql` のみ適用。`kotonoha.gemini_throttle` とservice_role専用の `public.kotonoha_gemini_gate` を追加しました。Edge Functionは `kotonoha-api` だけを更新します。関連しないマイグレーションを一括適用しないでください。
- 待機時刻・理由・試行回数を会議documentに保存。Edge Function内では待たず終了し、会議一覧の再取得時に処理権を排他的に取り直します。通常の4分リースが切れても、保存済みの長い待機を処理中断と誤判定しません。画面を閉じた場合の次の部分の開始は、次回アプリを開くまで行われません。常駐ワーカー／cronではありません。
- 詳細画面に待機理由、残り秒数、完了部分数、自動再試行回数を表示。一覧には「自動再開待ち」と表示します。アプリ内ガイドとREADMEも更新しました。OpenAI側の429自動再試行を追加する変更ではありません。
- Node 49テスト、Edge HTTP結合テスト、フロントビルド、Edge型チェックを実行。65分・62.4MBの合成WAVを7分割しPCMハッシュ・時間の欠落／重複を確認。HTTPテストでは7部分の途中429、保存済み部分の保持、別セッションからの再開、同時ポーリング、2会議の共有待機、再試行上限、日次上限を確認しました。実際の1時間会議をGoogleに送って精度を検証したものではありません。
- 本番DBでは `tests/cloud-gemini-gate-database.sql` をservice_roleに切り替えて実行し、予約・共有待機・再開・古い処理権の拒否・権限・期限切れ回復を検証。テスト行は全てROLLBACKしました。他アプリpublic関数 `c946d1664d096aef53ab6ab6a89ace56`、public列 `3aaaa71524ba0adcf9aaa172a836045f`、Storageポリシー `9c044294871791de09c995a1fc1230b3` は追加前後で一致しています。
- ローカル画面検証は `node scripts/check-gemini-wait-server.mjs`（5194番）で実行できます。保存済み前半＋未完了後半の架空会議に対し、模擬429を1回発生させます。実APIキー・外部AI通信は使用しません。
- ロールバック時は自動待機中の会議がなくなってから旧関数に戻してください。旧版は保存済み待機時刻を認識しません。専用テーブル・RPCは残しても既存アプリには影響しません。

## 画面を閉じても処理を進める定期処理（2026-09-30）

- これまでクラウドの分割文字起こし・Geminiの待機明け再開・議事録結果の取得は、画面が `GET /meetings` を再取得した時だけ進みました（上記「常駐ワーカー／cronではありません」）。今回、同じ処理を `advanceMeetings()` に切り出し、`GET /meetings` と新しい内部API `POST /internal/tick` の両方から呼びます。一覧取得の動作は従来どおりです。
- `POST /internal/tick` は利用者セッションでは呼べません。ヘッダー `x-kotonoha-tick` をEdge Functionの環境変数 `KOTONOHA_TICK_SECRET`（32文字以上）とSHA-256後に定数時間で照合し、不一致は401、未設定・短すぎる場合は503で何もしません。会議の内容は返さず、`{"meetings":件数,"advanced":進んだ件数}` だけを返します。
- 1回の定期処理は処理中の会議を更新が古い順に最大10件だけ確認し、各会議で1部分の開始または1回の結果取得までに限ります。処理権は従来の `kotonoha_audio_upload('next')`（行ロック・`partReady`・runId）で排他的に取得し、共有ワークスペース全体の同時AI処理2件、Geminiの送信間隔・待機時刻も従来どおり守ります。画面の一覧取得と定期処理が同時に走っても同じ部分を二重に処理しません。
- 専用マイグレーション `20260930000100_kotonoha_background_tick.sql` は、service_role限定の `public.kotonoha_tick`（共有ワークスペースIDの取得のみ）、非公開の `kotonoha.tick_request()`、pg_cronのジョブ `kotonoha-tick`（毎分）だけを追加します。URLと合言葉はSupabase Vaultから実行時に読み、マイグレーションやリポジトリに秘密情報を含めません。pg_cron・pg_net・Vaultの値がない場合は通知だけで失敗せず、ジョブは何もしません。他アプリのテーブル・関数・Auth・Storage・既存のcronジョブは変更しません。
- 反映前（合言葉・Vault・マイグレーション未設定）の間は従来どおり、画面を開いている間だけ進みます。

### 初回設定（管理者が1回だけ実行）

1. 合言葉を作成します（64文字）。コマンド履歴やGitHubに残さないでください。

   ```sh
   openssl rand -hex 32
   ```

2. Edge Functionの環境変数に設定します。一時ファイル `tick.env` に `KOTONOHA_TICK_SECRET=<合言葉>` の1行を書き、設定後に削除します。

   ```sh
   supabase secrets set --env-file tick.env --project-ref hjhkccbktkscwtgzxjfq && rm tick.env
   ```

3. 定期処理に対応した `kotonoha-api` をデプロイします（従来と同じコマンド）。

   ```sh
   supabase functions deploy kotonoha-api --project-ref hjhkccbktkscwtgzxjfq --no-verify-jwt
   ```

4. ダッシュボードの Database → Extensions で `pg_cron` と `pg_net` が有効か確認し、無効なら有効にします（SQLでは `create extension if not exists pg_cron; create extension if not exists pg_net;`）。拡張機能はプロジェクト共通の機能追加で、既存アプリのデータは変更しません。
5. SQL EditorでVaultに2件登録します。合言葉は手順2と同じ値です。変更時は `vault.update_secret` を使います。

   ```sql
   select vault.create_secret('https://hjhkccbktkscwtgzxjfq.supabase.co/functions/v1/kotonoha-api/internal/tick', 'kotonoha_tick_url', 'kotonoha background tick URL');
   select vault.create_secret('<手順1の合言葉>', 'kotonoha_tick_secret', 'kotonoha background tick secret');
   ```

6. `supabase/migrations/20260930000100_kotonoha_background_tick.sql` だけをSQL Editorなどで適用します（`db push` / `db reset` は使わない）。手順4より先に適用した場合は、同じファイルを再実行すればジョブを1件だけ登録し直します。
7. 確認します。`net._http_response` の直近が `200` と `{"meetings":…}` なら動作しています。401は合言葉の不一致、503は環境変数未設定またはマイグレーション未適用です。

   ```sql
   select jobid, schedule, command, active from cron.job where jobname = 'kotonoha-tick';
   select status, return_message, start_time from cron.job_run_details
     where jobid = (select jobid from cron.job where jobname = 'kotonoha-tick') order by start_time desc limit 5;
   select status_code, content, created from net._http_response order by created desc limit 5;
   ```

- 停止・ロールバックは `select cron.unschedule('kotonoha-tick');` です。Edge Functionは定期処理がなくても従来どおり動きます。`cron.job_run_details` は1日1,440行増えるため、必要に応じて古い履歴を削除してください。
- 検証：Node 91テスト、`deno check`、既存クラウドHTTPテスト、`tests/cloud-tick.test.ts`（5件：合言葉の拒否、一覧取得なしで3分割が定期処理だけで完成、定期処理3本と一覧取得2本の同時実行で8部分を各1回だけ文字起こし・同時AI処理2件以内、待機時刻前は再開しない・3件目は2件完了まで開始しない、1件のAI結果取得の一時失敗が他の会議を止めない）。`bash scripts/check-tick-migration.sh` はローカルの使い捨てPostgreSQL（pg_cron入り、Vault/pg_netは模擬）で、拡張機能なしでも失敗しないこと、権限、ジョブの重複なし、Vault未設定・短い合言葉で送信しないこと、設定後にURLと合言葉ヘッダーで送信することを確認します。本番DB・Supabaseには接続していません。

## Google Meet録音Bot（アップロードトークン方式、2026-09-30）

- 画面の「Botを呼ぶ」から、Google MeetのURL（`https://meet.google.com/xxx-xxxx-xxx`）と会議名・開催日・参加者・詳しさを送ると、サーバーが会議を先に作成し（状態 `bot`）、Botの受付口（Webhook）へ参加依頼を送ります。
- Botには共通パスワードを渡しません。依頼ごとにランダムなアップロードトークン（`ktu_` ＋64桁の16進数）を作り、DBにはSHA-256だけを保存します。トークンは**その1会議**の「状況報告・取り込み計画・音声の送信・完了」だけに使え、ログインが必要な他のAPIでは使えません。有効期限は6時間で、完了（`complete`）時、または会議が処理中に進んだ時点で無効になります。
- 専用マイグレーション `20260930000200_kotonoha_meet_bot.sql` は、非公開テーブル `kotonoha.bot_requests`（依頼ID・会議ID・Meet URL・トークンのハッシュ・期限・使用日時）と service_role 限定のRPC `public.kotonoha_bot` だけを追加します。他アプリのテーブル・関数・Auth・Storage・cronは変更しません。
- 音声の取り込み・完了は既存の分割アップロード（`kotonoha_audio_upload('append')`・`kotonoha_attachments('complete')`）と同じ処理を共用します。完了後の文字起こし・議事録作成は既存の定期処理（`POST /internal/tick`）で進むため、Botも画面も開いておく必要はありません。

### 環境変数（Edge Function）

| 変数 | 必須 | 内容 |
|---|---|---|
| `MEETBOT_WEBHOOK_URL` | はい | 参加依頼を送るBotのURL。未設定の場合「Botを呼ぶ」は503と案内を返し、会議は作成しません。 |
| `MEETBOT_WEBHOOK_AUTHORIZATION` | 任意 | 設定するとWebhookに `Authorization: <値>` ヘッダーをそのまま付けます（Grok Bot のルーティンWebhookの「Authorization header」の値をそのまま入れる）。 |
| `MEETBOT_WEBHOOK_SECRET` | 推奨 | 設定するとWebhookにヘッダー `X-Meetbot-Secret: <値>` を付けます。Bot側で照合してください。 |
| `MEETBOT_API_BASE_URL` | いいえ | Botに伝えるAPIのURL。省略時は `SUPABASE_URL` + `/functions/v1/kotonoha-api`。 |

### API

ログインが必要（`Authorization: Bearer ktn_…`）:

- `POST /bot/requests` `{"meetUrl":"https://meet.google.com/abc-defg-hij","metadata":{"title":"定例","date":"2026-09-30","participants":"田中, 佐藤","template":"standard"}}` → 201 会議（`status:"bot"`, `bot:{requestId, meetUrl, state:"waiting", message, requestedAt, updatedAt, expiresAt}`）。Webhookが失敗（接続不可・10秒超過・2xx以外）した場合は仮の会議を削除しトークンを無効にして502。参加待ちの会議は5件まで（429）。
- `GET /meetings/:id/bot` → `{meetingId, requestId, meetUrl, state, phase, label, message, meetingStatus, requestedAt, updatedAt, expiresAt}`。`phase` は `waiting|joining|recording|uploading|processing|done|error`、`label` は「待機中／参加中／録音中／アップロード中／議事録作成中／完了／エラー」。Botの会議でなければ404。
- 会議一覧 `GET /meetings` の各会議にも同じ `bot` 情報が入ります。

Webhook（サーバー → Bot）: `POST $MEETBOT_WEBHOOK_URL`、`Content-Type: application/json`、`X-Meetbot-Secret`（設定時）

```json
{"event":"bot.join","requestId":"…","meetingId":"…","meetUrl":"https://meet.google.com/abc-defg-hij",
 "title":"定例","date":"2026-09-30","participants":"田中, 佐藤","template":"standard",
 "requestedAt":"2026-09-30T01:00:00.000Z","expiresAt":"2026-09-30T07:00:00.000Z",
 "apiBaseUrl":"https://hjhkccbktkscwtgzxjfq.supabase.co/functions/v1/kotonoha-api","uploadToken":"ktu_…"}
```

アップロードトークンが必要（`Authorization: Bearer ktu_…` または `X-Upload-Token: ktu_…`、URLの会議IDはトークンの会議と一致すること。不一致403、無効・期限切れ・完了済み401）:

- `POST /bot/meetings/:id/status` `{"state":"joining|recording|uploading|error","message":"任意・500文字まで"}` → 200 `{id, status, uploadedParts, plannedParts, bot}`
- `POST /bot/meetings/:id/uploads` → `POST /uploads` と同じ `sources` / `parts`（`metadata` は送っても無視し、依頼時の値を使用。テキスト・添付は不可）→ 201。状態が `uploading` になります。最初の部分を送る前なら再送で計画を置き換えられます。
- `POST /meetings/:id/parts?index=i` と同じ仕様の `POST /bot/meetings/:id/parts?index=i`（生のバイト列、順番どおり、サイズ一致）→ 200
- `POST /bot/meetings/:id/complete` → 202（処理開始）。この時点でトークンは無効になります。
- `GET /bot/meetings/:id` → `{id, status, uploadedParts, plannedParts, bot}`（送信が不確かな時の確認用）

### 反映手順（管理者）

1. `supabase/migrations/20260930000200_kotonoha_meet_bot.sql` だけをSQL Editorなどで適用します（`db push` / `db reset` は使わない）。
2. Botの受付URLと合言葉を設定します。一時ファイル `meetbot.env` に `MEETBOT_WEBHOOK_URL=https://…` と `MEETBOT_WEBHOOK_SECRET=<openssl rand -hex 32 の値>` を書き、設定後に削除します。

   ```sh
   supabase secrets set --env-file meetbot.env --project-ref hjhkccbktkscwtgzxjfq && rm meetbot.env
   ```

3. `kotonoha-api` をデプロイします。

   ```sh
   supabase functions deploy kotonoha-api --project-ref hjhkccbktkscwtgzxjfq --no-verify-jwt
   ```

4. 画面（GitHub Pages）は `main` へのマージで自動公開されます。手順1〜3を先に行ってください（未反映のまま公開すると「Botを呼ぶ」が「指定された機能が見つかりません」になります）。
5. 確認：「Botを呼ぶ」で会議が作られ、Bot側にWebhookが届くこと。`select id, meeting_id, expires_at, used_at from kotonoha.bot_requests order by created_at desc limit 5;` で期限と完了時の `used_at` を確認できます（トークン本体は保存されません）。

- ロールバック：旧版の `kotonoha-api` に戻すとBot用APIはなくなります（状態 `bot` の会議は「要確認」と表示され、削除できます）。テーブル・RPCは残しても既存機能に影響しません。
- 検証：`tests/bot.test.mjs`（URL検証・トークン形式・状態表示）、`tests/cloud-bot.test.ts`（実ハンドラーでのHTTP結合テスト6件）、`bash scripts/check-bot-migration.sh`（ローカルPostgreSQLで権限・ハッシュ保存・期限上限・トークンの範囲・完了後の無効化・Webhook失敗時の削除・件数上限）。本番DB・Supabase・実際のGoogle Meetには接続していません。

## 復旧

旧OEMの全Git履歴を `codex/backup-oem-before-kotonoha-20260923` に退避しています。置き換え前のコミットは `ec92fbfd9727024afac239a350cf955d075d59c8`。旧画面へ戻す場合は、この退避ブランチから内容を復元する新しいコミットを作成してください。共有DBはリセットしません。

会議の削除は `kotonoha.meetings.deleted_at` に削除日時を設定します。管理者は本人・会議IDを照合したうえで、その1行のみ `deleted_at = null` に戻して復元できます。完全消去は対象の会議ID・所有者ID・audio_path・document.audioPartsの全保存パスを照合し、対象音声と会議行のみを削除します。DBスキーマやバケット全体の削除は行わないでください。

ログインできない場合は、共通IDの入力、パスワード、試行回数制限を確認してください。共用Supabase Authのユーザー・パスワード・メール設定を変更してはいけません。
