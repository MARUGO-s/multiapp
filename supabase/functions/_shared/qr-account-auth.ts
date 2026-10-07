import { hashToken, validTokenFormat } from "./session.mjs";

export class AccountError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type QrIdentity =
  | { kind: "account"; userId: string }
  | { kind: "shared"; workspaceId: string };
function config() {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key)
    throw new AccountError(503, "接続の設定が完了していません。");
  return { base, key };
}
export async function qrIdentity(req: Request): Promise<QrIdentity> {
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (token && validTokenFormat(token)) {
    const { base, key } = config();
    const response = await fetch(`${base}/rest/v1/rpc/kotonoha_auth`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_operation: "session",
        p_payload: { tokenHash: await hashToken(token) },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const session = await response.json();
    if (!response.ok || !session?.workspaceId || session.error)
      throw new AccountError(401, "ログインの有効期限が切れています。再度ログインしてください。");
    return { kind: "shared", workspaceId: session.workspaceId };
  }
  if (
    !token ||
    token.length > 8192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    throw new AccountError(
      401,
      "QR管理にはメールアドレスでのログインが必要です。",
    );
  const { base, key } = config();
  const response = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status >= 500)
    throw new AccountError(503, "ログイン情報を確認できませんでした。");
  if (!response.ok)
    throw new AccountError(
      401,
      "ログインの有効期限が切れました。再度ログインしてください。",
    );
  const user = await response.json();
  if (!uuidPattern.test(user.id) || !user.email_confirmed_at)
    throw new AccountError(403, "メールアドレスの本人確認が必要です。");
  return { kind: "account", userId: user.id };
}
const messages: Record<string, [number, string]> = {
  UNVERIFIED: [403, "メールアドレスの本人確認が必要です。"],
  ACCOUNT_PENDING_OR_SUSPENDED: [
    403,
    "所属店舗の承認待ち、または利用停止中です。管理者へご確認ください。",
  ],
  STORE_FORBIDDEN: [403, "この店舗のデータを操作する権限がありません。"],
  ADMIN_REQUIRED: [403, "全店舗管理者だけが操作できます。"],
  INVALID_STORE: [400, "有効な所属店舗を選択してください。"],
  SHARED_QR_FORBIDDEN: [403, "共通IDのQR利用が許可されていません。"],
  MEMBER_NOT_FOUND: [404, "登録アカウントが見つかりません。"],
  SELF_PROTECTED: [
    409,
    "自分自身の権限・所属・利用状態は、この画面では変更できません。",
  ],
  LAST_ADMIN: [409, "最後の有効な管理者は取り消し・停止できません。"],
  STORE_REQUIRED: [409, "管理者を取り消す前に所属店舗を設定してください。"],
  APPROVE_FIRST: [409, "所属申請を承認してから管理者を付与してください。"],
  INVALID_ACTION: [400, "操作内容を確認してください。"],
};
export async function accountRpc(
  operation: string,
  actor: string | null = null,
  store: string | null = null,
  target: string | null = null,
  payload: unknown = {},
) {
  const { base, key } = config();
  const response = await fetch(`${base}/rest/v1/rpc/marugo_qr_accounts`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_operation: operation,
      p_actor: actor,
      p_store: store,
      p_target: target,
      p_payload: payload,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) {
    const [status, message] = messages[result.message] ?? [
      503,
      "保存・権限の確認結果を取得できませんでした。もう一度お試しください。",
    ];
    throw new AccountError(status, message);
  }
  return result;
}
export async function qrScope(req: Request, url: URL) {
  const identity = await qrIdentity(req);
  const store = url.searchParams.get("storeId");
  if (store !== null && !uuidPattern.test(store))
    throw new AccountError(400, "店舗IDが正しくありません。");
  if (identity.kind === "shared")
    return await sharedAccountRpc("scope", identity.workspaceId, store);
  return await accountRpc("scope", identity.userId, store);
}

export async function sharedAccountRpc(
  operation: string,
  workspaceId: string,
  store: string | null = null,
) {
  const { base, key } = config();
  const response = await fetch(`${base}/rest/v1/rpc/marugo_qr_shared`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_operation: operation,
      p_workspace: workspaceId,
      p_store: store,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) {
    const [status, message] = messages[result.message] ?? [
      503,
      "保存・権限の確認結果を取得できませんでした。もう一度お試しください。",
    ];
    throw new AccountError(status, message);
  }
  return result;
}
