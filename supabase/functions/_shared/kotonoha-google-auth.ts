import { qrIdentity, AccountError, uuidPattern } from "./qr-account-auth.ts";
import { createToken, hashToken, validTokenFormat } from "./session.mjs";

const errors: Record<string, [number, string]> = {
  GOOGLE_REQUIRED: [403, "Googleアカウントの本人確認が必要です。"],
  LEGACY_REQUIRED: [
    403,
    "これまでのkotonohaのID・パスワードでログインしてから連携を申請してください。",
  ],
  APPROVAL_REQUIRED: [
    403,
    "会議録の利用承認待ち、または利用停止中です。管理者にご確認ください。",
  ],
  ADMIN_REQUIRED: [403, "会議録の承認管理者だけが操作できます。"],
  ADMIN_PROTECTED: [
    409,
    "自分自身や管理者の権限は、この画面では変更できません。",
  ],
  MEMBER_NOT_FOUND: [404, "利用申請が見つかりません。"],
  INVALID_ACTION: [400, "操作内容を確認してください。"],
};
export async function googleAuthRoute(
  req: Request,
  route: string,
  rpc: (name: string, args: any) => PromiseLike<{ data: any; error: any }>,
) {
  try {
    const actor = await qrIdentity(req); // Auth server verifies signature, expiry and confirmed email.
    let operation: string,
      target: string | null = null,
      payload: Record<string, string> = {};
    let token: string | undefined;
    if (route === "/auth/google/context" && req.method === "GET")
      operation = "context";
    else if (route === "/auth/google/request" && req.method === "POST") {
      const proof = req.headers.get("x-kotonoha");
      if (!validTokenFormat(proof))
        throw new AccountError(403, errors.LEGACY_REQUIRED[1]);
      operation = "request";
      payload = { legacyHash: await hashToken(proof!) };
    } else if (route === "/auth/google/login" && req.method === "POST") {
      operation = "login";
      token = createToken();
      payload = { tokenHash: await hashToken(token) };
    } else if (route === "/auth/google/members" && req.method === "GET")
      operation = "members";
    else if (
      route.startsWith("/auth/google/members/") &&
      req.method === "POST"
    ) {
      target = route.slice("/auth/google/members/".length);
      if (!uuidPattern.test(target))
        throw new AccountError(400, "アカウントIDを確認してください。");
      const reader = req.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 1024) {
              await reader.cancel();
              throw new AccountError(413, "入力が大きすぎます。");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      let body;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new AccountError(400, "入力内容を確認してください。");
      }
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        !["approve", "suspend"].includes(body.action)
      )
        throw new AccountError(400, "操作内容を確認してください。");
      operation = "update";
      payload = { action: body.action };
    } else throw new AccountError(405, "この操作には対応していません。");
    const { data, error } = await rpc("kotonoha_google_auth", {
      p_operation: operation,
      p_actor: actor,
      p_target: target,
      p_payload: payload,
    });
    if (error || !data)
      throw new AccountError(
        503,
        "会議録の連携設定・承認状態を確認できませんでした。",
      );
    if (data.error) {
      const [status, message] = errors[data.error] ?? [
        503,
        "連携の結果を確認できませんでした。",
      ];
      throw new AccountError(status, message);
    }
    return token
      ? { token, expiresAt: data.expiresAt, googleUserId: actor }
      : data;
  } catch (error) {
    if (error instanceof AccountError)
      throw Object.assign(error, { publicMessage: error.status === 401 ? "Googleでログインしてから、もう一度お試しください。" : error.message });
    throw Object.assign(new Error("Google login verification failed"), {
      status: 503,
      publicMessage:
        "本人確認・保存結果を確認できませんでした。状態を更新してから再試行してください。",
    });
  }
}
