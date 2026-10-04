# MARUGO 登録ユーザー管理

専用入口: https://marugo-s.github.io/multiapp/?admin=users

## 今回の範囲

検索、アプリ/利用状態の絞り込み、接続先別100件のページ送り、取得時刻、未接続/失敗表示。
kotonohaのGoogle連携とMARUGO QRの既存申請について、個別・最大20件の承認、再承認、停止に対応。
既存の利用者は自動変更しない。管理者が対象・理由を確認して実行した場合だけ、そのアプリの既存所属を更新する。
レシピ/SNS/グルメ/LINE/M-talk/Journalの承認操作は未対応。新たな承認制は導入していない。
アカウント削除は提供しない。全体閲覧権限と承認操作権限は別。

## 承認操作の使い方

1. 専用管理者のGoogleアカウントでログインする。
2. アプリや利用状態「承認待ち」で絞り込み、対象を選択する。
3. 「承認・再承認」または「承認取り消し・申請を停止」を押す。
4. 氏名・メール・所属・影響範囲を確認し、操作理由を入力して実行する。
5. 各対象の結果を確認する。履歴は「この管理画面での操作履歴」から取得する。

申請の入口は各アプリの既存登録画面。kotonohaは従来の共通IDでの本人確認後にGoogle連携を申請、QRは有効店舗を選んで登録する。
この管理画面自体は一般利用者向けの申請フォームではない。
kotonohaの停止はGoogle由来セッションを即時削除するが、共通IDのログインは止めない。
QRの停止は既存のサーバー側所属判定で管理操作を拒否する。公開QRや保存データは削除しない。
管理者本人・各アプリの管理者・中央管理者は操作対象外。役割・所属店舗の変更はしない。

「結果未確認」は通信が途切れただけで保存済みの可能性がある。同じ画面の再確認ボタンは同じ操作番号を再送するため、二重更新しない。
表示後に状態が変わった場合は更新を拒否し、再読込・再確認を求める。一括処理は1件ごとのトランザクションで、全件一括ロールバックではない。

| 接続先 | 表示対象 | 注意 |
| --- | --- | --- |
| hjhk / Recipe-Management | kotonoha Google連携、QR店舗メンバー、レシピプロフィール/旧ID | kotonohaの共通ID利用者は個人特定不可 |
| ycs / gourmet | SNSプロフィール/所属、グルメ店舗所有者 | 登録ありと承認済みを同一視しない |
| hocbn / LINE | LINE Bot登録者、M-talk、Journal AI機能許可 | Journalの店舗・ルーム・Bot資格は別判定。管理共通ID利用者は含まない |
| mzism / management | 未接続表示のみ | 接続権限未確認のため件数を0にしない |

Auth登録があっても対応するアプリ記録がないものは「Authのみ・アプリ未特定」と表示。
同じメールアドレスでも接続先とUIDを分ける。検索で並べて確認できるがアカウントの自動統合はしない。
レコード件数は実人数ではない。最終ログインは各Supabaseプロジェクト全体の記録であり、アプリ利用実績とは限らない。
M-talkの「承認・有効」も個別ルーム閲覧を保証しない。

## 構成と認可

```text
管理者のGoogleログイン（既存PKCE / account=google）
  → ?admin=users の専用画面
  → 各接続先の marugo-directory
      → hjhk の中央認証 /authorize を毎回確認
          → Auth /user で署名・期限を確認
          → 検証済みJWTのissuer/audience/subject/roleとOAuth AMRを確認
          → 確認済メール + Google identity + private UID allowlist + 非停止
      → 自プロジェクトのservice_role専用RPCで必要列だけ取得
      → 各接続先に閲覧監査（本文・検索文字列なし）
```

秘密鍵は各Edge Functionの既存環境内に留め、別プロジェクトに複製しない。
中央認証に送るのは本人のアクセストークンだけ。送信先はコード内の固定HTTPS、redirect拒否。
中央障害・不正応答・失効・一般ユーザーは拒否し、一覧へフォールバックしない。
Google identityを持つだけのパスワードログインは拒否（OAuth AMR必須）。
メールやユーザーメタデータ、レシピ管理者ロールだけで全体管理者にはしない。
管理者UIDは運用者が本人を確認してDBから個別に登録する。自己昇格・初回ユーザー自動昇格はない。

DBは追加専用のprivate schema `marugo_directory` を利用。
新テーブルはRLS全拒否。ビューはsecurity_invokerで、schema/table/functionともanon/authenticated権限を剥奪。
公開RPCは固定search_path、service_roleのみ。RPCのp_actorはEdgeで検証したUIDだけを渡す。
RPC単体はservice_roleを信頼するため、ブラウザへservice_roleを絶対に置かない。
検索はSQL文字列の組立てなし。1応答100件、検索160文字、offset最大50000、接続先ごと毎分120回の閲覧制限。
Auth原本・パスワード・秘密の質問・回答・アクセストークン・画像・業務データは返さない。
レスポンスno-store/private。ユーザー一覧はブラウザの永続ストレージへ保存しない。

## 適用手順

1. hjhkだけ: `supabase/migrations/20261004150619_marugo_directory.sql`
2. gourmetだけ: `supabase/external-migrations/gourmet/20261004150633_marugo_directory.sql`
3. hocbnだけ: `supabase/external-migrations/line/20261004150637_marugo_directory.sql`
4. 同じ `supabase/functions/marugo-directory/` を3プロジェクトに明示デプロイ。
5. 独自認可のためverify_jwt=false。無認証401・一般ユーザー403を必ず確認。

外部プロジェクト用migrationは通常のmigrationフォルダーに置かない。db push/resetは使用しない。
管理者登録はmigrationに個人UID/メールを埋め込まず、確認済の対象UIDを運用DMLで指定する。
Google identity未連携のUIDを事前指定しても、本人のGoogleログインが完了するまで認可はfalse。
解除はadmins.enabled=false。次の全API読込から拒否される。既に人が閲覧した情報を回収する機能ではない。
承認操作は中央admins.can_manage_access=trueも必須。毎回のGoogle認証に加え、更新RPCでも同じprivate registryを再確認する。
承認操作は中央プロジェクトのPOST /changeだけ。他の接続先は変更を拒否する。RPCはservice_role専用、actorは検証済みUIDのみ。
対象の最新状態のハッシュ、アプリ既存の管理用ロック、行ロックを使い、競合時はSTALE_STATEを返す。操作番号と内容を固定し、再送は保存済み結果を返す。
1リクエスト1件、理由1〜500文字、本文8192バイト以下、管理者ごと毎分60件まで。自己昇格/管理者変更は不可。
監査は各接続先のread_auditに保存。日時・中央actor UID・アプリ条件・取得件数のみ。
中央change_auditには操作番号、対象、変更前後、理由、操作者を保存。操作履歴UIでは安全な固定列だけ返す。自動削除は未実装。

承認追加の適用: hjhkだけに `supabase/migrations/20261004152843_directory_approvals.sql` を個別適用し、中央marugo-directoryを更新。
他の2接続先は既存v2の読み取り専用APIのまま利用できる。中央 /authorize のcanManage追加は後方互換。
指定済み管理者のwrite capabilityは運用DMLで個別設定し、migrationに個人情報を埋め込まない。

## 検証と残る作業

- Node: 専用ルーティング、固定OAuth戻り先、他アプリ認証への非干渉。
- Deno: 未認証/共有ID/偽・期限切れJWT/他プロジェクト/非OAuth/一般利用者/取消後を拒否。
- Deno: 中央障害、秘密エラーメッセージ非露出、検索・ページ上限、actor改ざん防止、write capability、変更API入力制限。
- DB: service_role限定、ビュー列allowlist、集計/検索/ページングを実DBで検証。テスト閲覧監査はROLLBACK。
- UI: PC/スマートフォン表示、Googleログイン入口、未許可画面、既存ポータル導線。
- 実際の管理者Googleログイン後の一覧表示は本人の操作が必要。初回OAuth完了まで確認済みとしない。
- 貸借管理は対象プロジェクトへの権限を得てから個別調査・追加。
- `tests/directory-approvals-database.sql`: 承認、再送、競合拒否、管理者保護、Googleセッション失効、アプリ間非干渉。架空ユーザーを含め全変更ROLLBACK。
- 承認追加のNodeテスト147件、Deno認可テスト、実DBトランザクション検証に合格。実利用者の承認状態はテストでは変更しない。

2026-10-05 初回確認: Node 145件、Deno認可テスト、3接続先の実DB検証に合格。
本番3 APIは未認証・不正JWTで401。Advisorの今回追加分はprivate tableの
[RLS有効・ポリシーなし](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
INFOのみ（ブラウザ全拒否の意図した設定）。既存アプリ側の警告は本作業では変更しない。

根拠: [Supabase Database Functions](https://supabase.com/docs/guides/database/functions) /
[Auth server-side advanced guide](https://supabase.com/docs/guides/auth/server-side/advanced-guide)。
