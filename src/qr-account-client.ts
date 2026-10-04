import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./cloud";
import { isAccountNavigation } from "./qr-account-routing.mjs";

// One native identity client for QR + portal. Existing storage is preserved.
// Separate from kotonoha's authorization bridge and other apps' Auth keys.
export const qrAuth = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storageKey: "marugo-qr-auth",
    flowType: "pkce",
    detectSessionInUrl: false,
  },
});
export type QrStore = { id: string; name: string; legacy?: boolean };
export type QrMember = {
  user_id: string;
  store_id: string | null;
  status: "pending" | "active" | "suspended";
  role: "member" | "admin";
  email?: string;
  email_verified?: boolean;
  store_name?: string;
};
export type QrAccountContext = {
  member: QrMember | null;
  stores: QrStore[];
  email: string;
};
export const qrGoogleAuthEnabled =
  import.meta.env.VITE_QR_GOOGLE_AUTH_ENABLED === "true";
export const portalGoogleAuthEnabled =
  import.meta.env.VITE_PORTAL_GOOGLE_AUTH_ENABLED === "true";
export function accountRedirect(mode: "confirm" | "recovery" | "google") {
  const url = new URL(import.meta.env.BASE_URL, location.origin);
  url.searchParams.set("account", mode);
  return url.href;
}
export async function signInQrWithGoogle() {
  if (!qrGoogleAuthEnabled && !portalGoogleAuthEnabled)
    throw new Error("Googleログインは設定準備中です。");
  const { data, error } = await qrAuth.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: accountRedirect("google"),
      skipBrowserRedirect: true,
    },
  });
  if (error || !data.url)
    throw new Error(
      "Googleログインを開始できませんでした。時間をおいてもう一度お試しください。",
    );
  location.assign(data.url);
}
let callback: Promise<{ recovery: boolean; message: string }> | undefined;
export function finishAccountCallback() {
  if (callback) return callback;
  callback = (async () => {
    if (!isAccountNavigation(location.search, location.hash))
      return { recovery: false, message: "" };
    const url = new URL(location.href);
    const google = url.searchParams.get("account") === "google";
    const code = url.searchParams.get("code");
    const hasError =
      url.searchParams.has("error") || /(?:^#|&)error=/.test(url.hash);
    // Erase tokens/codes before rendering anything; no telemetry or redirect requests.
    for (const key of [
      "account",
      "code",
      "error",
      "error_code",
      "error_description",
      "token_hash",
      "access_token",
      "refresh_token",
      "type",
    ])
      url.searchParams.delete(key);
    url.hash = "";
    history.replaceState(null, "", url.pathname + url.search);
    if (!code || hasError)
      throw new Error(
        google
          ? "Googleログインが完了しませんでした。もう一度お試しください。"
          : "確認リンクが無効または期限切れです。メール送信をやり直してください。",
      );
    let recovery = false;
    const {
      data: { subscription },
    } = qrAuth.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") recovery = true;
    });
    const { data, error } = await qrAuth.auth
      .exchangeCodeForSession(code)
      .finally(() => subscription.unsubscribe());
    if (error || !data.session)
      throw new Error(
        google
          ? "Googleログインを確認できませんでした。ログインを開始した同じブラウザーで、もう一度お試しください。"
          : "確認リンクを利用できませんでした。メールを送信した同じ端末・ブラウザーで開くか、送信をやり直してください。",
      );
    return {
      recovery,
      message: google
        ? "Googleアカウントでログインしました。会議録・QRの利用許可はそれぞれ確認します。"
        : "メールアドレスを確認しました。",
    };
  })();
  return callback;
}
export async function qrAccessToken() {
  const { data, error } = await qrAuth.auth.getSession();
  if (error || !data.session)
    throw new Error("QR管理にはメールアドレスでログインしてください。");
  return data.session.access_token;
}
export function completeAccountRecovery() {
  callback = Promise.resolve({ recovery: false, message: "" });
}
export class AccountResultUnconfirmedError extends Error {
  constructor() {
    super(
      "保存結果を確認できませんでした。処理済みの可能性があります。もう一度実行する前に、一覧や承認状態を更新して確認してください。",
    );
  }
}
export async function accountApi<T>(
  path: string,
  options: RequestInit = {},
  publicRequest = false,
): Promise<T> {
  const token = publicRequest ? null : await qrAccessToken();
  let response: Response;
  let data: any;
  const writing = options.method && options.method !== "GET";
  try {
    response = await fetch(
      `${SUPABASE_URL}/functions/v1/marugo-accounts${path}`,
      {
        ...options,
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_PUBLISHABLE_KEY,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    data = await response.json();
  } catch {
    if (writing) throw new AccountResultUnconfirmedError();
    throw new Error(
      "情報を取得できませんでした。接続を確認し、画面を更新してください。",
    );
  }
  if (!response.ok && response.status >= 500 && writing)
    throw new AccountResultUnconfirmedError();
  if (!response.ok)
    throw new Error(data.error || "通信結果を確認できませんでした。");
  return data as T;
}
