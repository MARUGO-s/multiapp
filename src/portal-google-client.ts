import {
  qrAuth,
  qrAccessToken,
  AccountResultUnconfirmedError,
} from "./qr-account-client";
import {
  CLOUD_API,
  SUPABASE_PUBLISHABLE_KEY,
  getSession,
  saveSession,
  signOut,
  type SharedSession,
} from "./cloud";
export type GoogleMember = {
  user_id: string;
  status: "pending" | "active" | "suspended";
  role: "member" | "admin";
  email?: string;
};
export async function googleApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await qrAccessToken();
  let response: Response, data: any;
  try {
    response = await fetch(`${CLOUD_API}/auth/google${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
        ...(path === "/request" && getSession()
          ? { "x-kotonoha": getSession()!.token }
          : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    data = await response.json();
  } catch {
    if (options.method === "POST") throw new AccountResultUnconfirmedError();
    throw new Error(
      "会議録の承認状態を確認できませんでした。画面を更新してください。",
    );
  }
  if (!response.ok && response.status >= 500 && options.method === "POST")
    throw new AccountResultUnconfirmedError();
  if (!response.ok)
    throw new Error(data.error || "会議録の利用許可を確認できませんでした。");
  return data;
}
export async function openGoogleKotonoha() {
  // Never synthesize a workspace/session from the browser identity or metadata.
  const data = await googleApi<SharedSession>("/login", { method: "POST" });
  const { data: current } = await qrAuth.auth.getSession();
  if (!current.session || current.session.user.id !== data.googleUserId)
    throw new Error(
      "ログインアカウントが変わりました。もう一度お試しください。",
    );
  saveSession(data);
}
export async function signOutGoogleAccount() {
  if (getSession()?.googleUserId) await signOut();
  const { error } = await qrAuth.auth.signOut({ scope: "local" });
  if (error)
    throw new Error("ログアウトできませんでした。もう一度お試しください。");
}
