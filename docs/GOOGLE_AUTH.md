# MARUGO QR Google認証

QRのみの追加です。kotonohaの共通ID認証は変更していません。

接続先は `hjhkccbktkscwtgzxjfq`。Google OAuth callbackは
`https://hjhkccbktkscwtgzxjfq.supabase.co/auth/v1/callback`、QRへの戻り先は
`https://marugo-s.github.io/multiapp/?account=google` です。
SupabaseのGoogle設定と戻り先許可を確認した後、リポジトリ変数
`QR_GOOGLE_AUTH_ENABLED=true` を設定してPagesを再ビルドします。
未設定ではGoogleボタンを表示しません。Client SecretはSupabaseだけに保存してください。
Gmail・Drive等の追加権限は要求しません。

Google認証は既存のQR専用storage keyと明示的なPKCE交換を使用します。
URLのコード・トークンを除去してからQR管理画面を開き、QR公開リンク・スキャン履歴に送りません。
所属店舗・ロール・承認状態は既存のサーバー側account contextで確認します。
新規利用者は店舗選択と管理者承認が必要です。Google認証だけでは管理者になりません。
メール・パスワード、メール確認、パスワード再設定は従来どおり残します。

実ユーザーによるGoogle認証、既存アカウントとのUID継続、店舗データの読み書きは未検証です。
有効化前に承認済み・未承認・別店舗のアカウントで確認してください。
既存パスワード利用者は同じ確認済みメールアドレスのGoogleアカウントを選び、
既存UID・所属が継続するか確認してください。別メールのGoogleアカウントへの自動移管はしません。

検証: 型検査・ビルド、138 Nodeテスト、QR accountsのDeno型検査・認可テスト成功。
