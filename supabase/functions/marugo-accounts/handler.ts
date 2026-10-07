import {
  AccountError,
  accountRpc,
  qrIdentity,
  qrSharedTokenHash,
  sharedAccountRpc,
  uuidPattern,
} from "../_shared/qr-account-auth.ts";
const origins = new Set([
  "https://marugo-s.github.io",
  "http://localhost:5188",
  "http://127.0.0.1:5188",
]);
async function body(req: Request) {
  const reader = req.body?.getReader();
  if (!reader) throw new AccountError(400, "入力内容を確認してください。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) {
      await reader.cancel();
      throw new AccountError(413, "入力内容が長すぎます。");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value;
  } catch {
    throw new AccountError(400, "入力内容を確認してください。");
  }
}
export async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization,apikey,content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
  if (origin && origins.has(origin))
    headers["Access-Control-Allow-Origin"] = origin;
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers });
  if (origin && !origins.has(origin))
    return json({ error: "アクセス元が許可されていません。" }, 403);
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  try {
    const url = new URL(req.url);
    const match = url.pathname.match(/\/marugo-accounts(\/.*)?$/);
    if (!match) return json({ error: "ページが見つかりません。" }, 404);
    const route = match[1] || "";
    if (route === "/stores" && req.method === "GET")
      return json(await accountRpc("stores_public"));
    const sharedHash = await qrSharedTokenHash(req);
    const actor = sharedHash ? null : await qrIdentity(req);
    const authorizedRpc = (
      operation: string,
      store: string | null = null,
      target: string | null = null,
      payload: unknown = {},
    ) =>
      sharedHash
        ? sharedAccountRpc(operation, sharedHash, store, target, payload)
        : accountRpc(operation, actor, store, target, payload);
    if (route === "/context" && req.method === "GET")
      return json(await authorizedRpc("context"));
    if (route === "/register" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.storeId !== "string" || !uuidPattern.test(input.storeId))
        throw new AccountError(400, "所属店舗を選んでください。");
      return json(await authorizedRpc("register", input.storeId));
    }
    if (route === "/members" && req.method === "GET") {
      const page = Number(url.searchParams.get("page") || 0);
      const store = url.searchParams.get("storeId");
      if (
        !Number.isInteger(page) ||
        page < 0 ||
        page > 100000 ||
        (store !== null && !uuidPattern.test(store))
      )
        throw new AccountError(400, "一覧の指定が正しくありません。");
      return json(await authorizedRpc("members", store, null, { page }));
    }
    const target = route.match(/^\/members\/([^/]+)$/);
    if (target && req.method === "POST") {
      const input = await body(req);
      if (
        !uuidPattern.test(target[1]) ||
        ![
          "approve",
          "suspend",
          "grant_admin",
          "revoke_admin",
          "assign_store",
        ].includes(input.action) ||
        (input.action === "assign_store" &&
          (typeof input.storeId !== "string" ||
            !uuidPattern.test(input.storeId)))
      )
        throw new AccountError(400, "操作内容を確認してください。");
      return json(
        await authorizedRpc(
          "update_member",
          input.action === "assign_store" ? input.storeId : null,
          target[1],
          { action: input.action },
        ),
      );
    }
    return json({ error: "ページが見つかりません。" }, 404);
  } catch (error) {
    if (error instanceof AccountError)
      return json({ error: error.message }, error.status);
    console.error(
      "QR account request failed",
      error instanceof Error ? error.name : "unknown",
    );
    return json(
      { error: "通信結果を確認できませんでした。もう一度お試しください。" },
      503,
    );
  }
}
