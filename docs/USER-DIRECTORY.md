# MARUGO 登録ユーザー管理

専用入口: https://marugo-s.github.io/multiapp/?admin=users

## 今回の範囲

閲覧専用。検索、アプリ/利用状態の絞り込み、接続先別100件のページ送り、取得時刻、未接続/失敗表示。
既存のアプリ権限、データ、認証設定、ログイン方法は変更しない。
承認・停止・削除操作は未実装。アプリ管理権限と全アプリ一覧の閲覧権限は別。

| 接続先 | 表示対象 | 注意 |
| --- | --- | --- |
| hjhk / Recipe-Management | kotonoha Google連携、QR店舗メンバー、レシピプロフィール/旧ID | 琴ノ葉の共通ID利用者は個人特定不可 |
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
監査は各接続先のread_auditに保存。日時・中央actor UID・アプリ条件・取得件数のみ。監査の閲覧UIや自動削除は未実装。

## 検証と残る作業

- Node: 専用ルーティング、固定OAuth戻り先、他アプリ認証への非干渉。
- Deno: 未認証/共有ID/偽・期限切れJWT/他プロジェクト/非OAuth/一般利用者/取消後を拒否。
- Deno: 中央障害、秘密エラーメッセージ非露出、readonly、検索・ページ上限、actor改ざん防止。
- DB: service_role限定、ビュー列allowlist、集計/検索/ページングを実DBで検証。テスト閲覧監査はROLLBACK。
- UI: PC/スマートフォン表示、Googleログイン入口、未許可画面、既存ポータル導線。
- 実際の管理者Googleログイン後の一覧表示は本人の操作が必要。初回OAuth完了まで確認済みとしない。
- 貸借管理は対象プロジェクトへの権限を得てから個別調査・追加。

2026-10-05 初回確認: Node 145件、Deno認可テスト、3接続先の実DB検証に合格。
本番3 APIは未認証・不正JWTで401。Advisorの今回追加分はprivate tableの
[RLS有効・ポリシーなし](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
INFOのみ（ブラウザ全拒否の意図した設定）。既存アプリ側の警告は本作業では変更しない。

根拠: [Supabase Database Functions](https://supabase.com/docs/guides/database/functions) /
[Auth server-side advanced guide](https://supabase.com/docs/guides/auth/server-side/advanced-guide)。
