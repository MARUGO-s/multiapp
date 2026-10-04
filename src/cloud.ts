// Public configuration. Authorization is enforced on the server, not by this key.
export const SUPABASE_URL = "https://hjhkccbktkscwtgzxjfq.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_TY46n8sbGaESoL7RAzoYbg_i-d8Cwqr";
export const isCloud =
  import.meta.env.PROD || import.meta.env.VITE_STORAGE_MODE === "supabase";
export const CLOUD_API = `${SUPABASE_URL}/functions/v1/kotonoha-api`;
const SESSION_KEY = "kotonoha-shared-session";
export const SESSION_EVENT = "kotonoha-session-change";
export type SharedSession = {
  token: string;
  expiresAt: string;
  googleUserId?: string;
};

export function getSession(): SharedSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (
      typeof value?.token === "string" &&
      /^ktn_[0-9a-f]{64}$/.test(value.token) &&
      typeof value.expiresAt === "string" &&
      Date.parse(value.expiresAt) > Date.now()
    )
      return value;
  } catch {
    /* Missing/corrupt storage is an unauthenticated session. */
  }
  return null;
}
export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new Event(SESSION_EVENT));
}
export function saveSession(data: SharedSession) {
  if (
    !/^ktn_[0-9a-f]{64}$/.test(data.token) ||
    !(Date.parse(data.expiresAt) > Date.now())
  )
    throw new Error("ログイン情報を確認できませんでした。");
  localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  window.dispatchEvent(new Event(SESSION_EVENT));
}
export async function signIn(loginId: string, password: string) {
  const response = await fetch(`${CLOUD_API}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify({ loginId, password }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "ログインできませんでした。");
  saveSession(data);
}
export async function signOut() {
  const session = getSession();
  if (session) {
    const response = await fetch(`${CLOUD_API}/auth/logout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
      },
    });
    if (!response.ok && response.status !== 401)
      throw new Error("ログアウトできませんでした。");
  }
  clearSession();
}
