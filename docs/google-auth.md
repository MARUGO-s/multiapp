# kotonoha / MARUGO QR 共通Googleログイン

Google本人確認は1つのPKCEクライアント（既存 `marugo-qr-auth` を保持）。
利用認可は別々。QRの店舗/管理者とkotonohaの承認管理者は相互に流用しない。
他アプリのセッション・レシピのSite URL・データは変更しない。

## 会議録

1. 共通ポータルでGoogleログイン。
2. 未連携なら、既存の共通ID・パスワードでkotonohaへログイン。
3. アプリ選択に戻り、「既存ログインと連携を申請」。
4. 指定管理者が本人を確認して承認。承認後はGoogleで開ける。

Google JWTだけでは会議を読めない。サーバー側承認確認後に既存形式の1時間セッションを発行。
全APIで承認状態を再確認。Google利用停止時は対象セッションも削除。
既存パスワードを知る利用者のログインは残るため、Google承認停止は共通IDのアクセス停止ではない。
必要な場合は共通パスワード変更と既存セッション失効を別途行う。

## 導入順序

1. 対象は `hjhkccbktkscwtgzxjfq` のみ。専用migrationを確認して適用。
   `db push/reset` や過去の所有者書き換えmigrationを再実行しない。
2. 所有者指定の管理者がGoogleログイン。AuthのUID・確認済みメール・Google identityを確認。
   管理者は初回ログイン、サポートメール、user_metadataから自動作成しない。
   所有者承認済みUIDを `kotonoha.google_members` に登録する。指定がない限り登録しない。
3. kotonoha-apiを新helper込みでデプロイ、custom authのため既存verify_jwt設定を保持。
4. Supabase Redirect URLsに正確な `https://marugo-s.github.io/multiapp/?account=google` を追加。
   レシピSite URLと既存URLを保持。秘密鍵の閲覧/再入力は不要。
5. Node・Deno・SQLの認可テスト、承認/取消し/既存ログインを確認。
6. PRのCI成功後マージ・Pages公開。`PORTAL_GOOGLE_AUTH_ENABLED=true` で共通UIを有効にする。
   未設定なら共通Google UIは非表示。QR単独の既存フラグは独立して維持。
7. 所有者の実ブラウザーでGoogle認証往復、同じ会議データ、QR店舗分離を確認。

## 検証

- Node: PKCE、URLからのコード消去、単回交換、暗黙トークン/回復偽装拒否。
- Deno: Authサーバーの本人確認、UID偽装拒否、入力上限、承認待ち403、管理者操作制限。
- SQL: service-only RPC、本人連携は有効な旧セッションが必要、承認前会議アクセス拒否、停止即反映、他アプリに権限なし。
- 実操作: 指定管理者の登録とGoogle往復を行うまで「利用開始確認済み」と扱わない。

方式の参照: [Supabase Google / PKCE](https://supabase.com/docs/guides/auth/social-login/auth-google)
