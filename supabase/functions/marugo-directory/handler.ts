// Each deployment uses ONLY its own project's server key.
// Remote sources validate the central Google identity + current registry on EVERY read.
export const CENTRAL = "https://hjhkccbktkscwtgzxjfq.supabase.co";
const SOURCES = new Set([
  CENTRAL,
  "https://ycsqfajidusuibqljjwr.supabase.co",
  "https://hocbnifuactbvmyjraxy.supabase.co",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class Failure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function rpc(url: string, key: string, name: string, args: unknown) {
  const r = await fetch(url + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(12000),
    redirect: "error",
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    const known: Record<string, [number, string]> = {
      ADMIN_REQUIRED: [403, "承認操作の管理者権限がありません。"],
      STALE_STATE: [
        409,
        "状態が変更されています。再読込して確認し直してください。",
      ],
      REQUEST_CONFLICT: [409, "操作番号が重複しています。再読込してください。"],
      ACTION_FORBIDDEN: [409, "この利用者には指定の操作を実行できません。"],
      MEMBER_NOT_FOUND: [404, "対象の申請・所属が見つかりません。"],
      INVALID_INPUT: [400, "操作内容を確認してください。"],
      UNSUPPORTED_APP: [400, "このアプリの承認はまだ対応していません。"],
    };
    if (known[detail.message]) {
      const [status, message] = known[detail.message];
      throw new Failure(status, message);
    }
    if (detail.message === "RATE_LIMIT")
      throw new Failure(
        429,
        "アクセスが集中しています。1分ほど待って再読込してください。",
      );
    throw new Failure(
      503,
      "登録情報を取得できません。時間をおいて再読込してください。",
    );
  }
  return r.json();
}
async function authorize(
  url: string,
  key: string,
  bearer: string,
): Promise<string> {
  if (url !== CENTRAL) {
    const r = await fetch(
      CENTRAL + "/functions/v1/marugo-directory/authorize",
      {
        headers: { Authorization: bearer },
        signal: AbortSignal.timeout(12000),
        redirect: "error",
      },
    );
    if (!r.ok)
      throw new Failure(
        r.status === 401 ? 401 : r.status === 403 ? 403 : 503,
        r.status === 403
          ? "全アプリ管理者のGoogleログインが必要です。"
          : "管理者認証を確認できません。",
      );
    const d = await r.json();
    if (
      d.authorized !== true ||
      typeof d.actor !== "string" ||
      !uuid.test(d.actor)
    )
      throw new Failure(503, "管理者認証を確認できません。");
    return d.actor;
  }
  const r = await fetch(CENTRAL + "/auth/v1/user", {
    headers: { apikey: key, Authorization: bearer },
    signal: AbortSignal.timeout(12000),
    redirect: "error",
  });
  if (!r.ok)
    throw new Failure(
      r.status >= 500 ? 503 : 401,
      "Googleでログインし直してください。",
    );
  const user = await r.json();
  // Parse claims only AFTER Auth has verified the exact token. Never trust metadata roles.
  let claims;
  try {
    const part = bearer
      .slice(7)
      .split(".")[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")));
  } catch {
    throw new Failure(401, "Googleでログインし直してください。");
  }
  if (
    !uuid.test(user.id ?? "") ||
    claims.sub !== user.id ||
    claims.iss !== CENTRAL + "/auth/v1" ||
    claims.aud !== "authenticated" ||
    claims.role !== "authenticated" ||
    !Array.isArray(claims.amr) ||
    !claims.amr.some((x: { method?: string }) => x.method === "oauth") ||
    !user.email_confirmed_at ||
    !user.identities?.some((i: { provider: string }) => i.provider === "google")
  )
    throw new Failure(403, "このページにはGoogleでの本人確認が必要です。");
  const allowed = await rpc(url, key, "marugo_directory_authorized", {
    p_actor: user.id,
  });
  if (allowed !== true)
    throw new Failure(
      403,
      "このアカウントには全アプリ管理ページの閲覧権限がありません。",
    );
  return user.id;
}
export async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, private",
    Pragma: "no-cache",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin === "https://marugo-s.github.io") {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set(
      "Access-Control-Allow-Headers",
      "authorization, apikey, content-type",
    );
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers });
  if (origin && origin !== "https://marugo-s.github.io")
    return response({ error: "この接続元は許可されていません。" }, 403);
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (req.method !== "GET" && req.method !== "POST")
    return response({ error: "許可されていない操作です。" }, 405);
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SOURCES.has(url) || !key)
    return response({ error: "管理ページは設定準備中です。" }, 503);
  const bearer = req.headers.get("authorization") ?? "";
  if (
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer) ||
    bearer.length > 12000
  )
    return response({ error: "Googleでログインしてください。" }, 401);
  try {
    const u = new URL(req.url);
    const path = u.pathname.replace(/^\/functions\/v1/, "");
    if (
      ![
        "/marugo-directory/authorize",
        "/marugo-directory/users",
        "/marugo-directory/change",
        "/marugo-directory/history",
      ].includes(path)
    )
      return response({ error: "見つかりません。" }, 404);
    const changing = path.endsWith("/change");
    if (req.method !== (changing ? "POST" : "GET"))
      return response({ error: "許可されていない操作です。" }, 405);
    if (
      (path.endsWith("/authorize") || changing || path.endsWith("/history")) &&
      url !== CENTRAL
    )
      return response({ error: "見つかりません。" }, 404);
    const actor = await authorize(url, key, bearer);
    if (path.endsWith("/authorize")) {
      const canManage = await rpc(
        url,
        key,
        "marugo_directory_manage_authorized",
        { p_actor: actor },
      );
      return response({
        authorized: true,
        actor,
        canManage: canManage === true,
      });
    }
    if (changing) {
      if (
        (await rpc(url, key, "marugo_directory_manage_authorized", {
          p_actor: actor,
        })) !== true
      )
        throw new Failure(403, "承認操作の管理者権限がありません。");
      if (!req.headers.get("content-type")?.startsWith("application/json"))
        throw new Failure(400, "JSON形式で送信してください。");
      // Bound streamed bytes too; a missing/false Content-Length cannot bypass this limit.
      const reader = req.body?.getReader();
      if (!reader) throw new Failure(400, "操作内容がありません。");
      let raw = "",
        size = 0;
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          throw new Failure(413, "操作内容が大きすぎます。");
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new Failure(400, "操作内容を確認してください。");
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (k) =>
            !["requestId", "key", "action", "version", "reason"].includes(k),
        ) ||
        typeof body.requestId !== "string" ||
        !uuid.test(body.requestId) ||
        typeof body.key !== "string" ||
        !/^(kotonoha|qr):[0-9a-f-]{36}$/.test(body.key) ||
        !uuid.test(body.key.split(":")[1]) ||
        !["approve", "suspend"].includes(body.action) ||
        typeof body.version !== "string" ||
        !/^[0-9a-f]{32}$/.test(body.version) ||
        typeof body.reason !== "string" ||
        body.reason.trim().length < 1 ||
        body.reason.length > 500
      )
        throw new Failure(400, "対象・理由・操作内容を確認してください。");
      return response(
        await rpc(url, key, "marugo_directory_change", {
          p_actor: actor,
          p_request: body.requestId,
          p_key: body.key,
          p_action: body.action,
          p_version: body.version,
          p_reason: body.reason.trim(),
        }),
      );
    }
    if (path.endsWith("/history")) {
      const offset = u.searchParams.get("offset") ?? "0";
      if (!/^\d{1,5}$/.test(offset) || Number(offset) > 50000)
        throw new Failure(400, "履歴の検索条件を確認してください。");
      return response(
        await rpc(url, key, "marugo_directory_history", {
          p_actor: actor,
          p_offset: Number(offset),
        }),
      );
    }
    const app = u.searchParams.get("app") ?? "";
    const search = (u.searchParams.get("q") ?? "").trim();
    const status = u.searchParams.get("status") ?? "";
    const offset = u.searchParams.get("offset") ?? "0";
    if (
      !/^(|recipe|kotonoha|qr|sns|gourmet|chat|report|journal|unassigned)$/.test(
        app,
      ) ||
      !/^(|registered|active|pending|suspended|denied|deleted|unknown|unlinked|legacy|granted)$/.test(
        status,
      ) ||
      search.length > 160 ||
      !/^\d{1,5}$/.test(offset) ||
      Number(offset) > 50000
    )
      return response({ error: "検索条件を確認してください。" }, 400);
    const data = await rpc(url, key, "marugo_directory_page", {
      p_actor: actor,
      p_app: app,
      p_search: search,
      p_status: status,
      p_offset: Number(offset),
    });
    if (
      !Array.isArray(data.rows) ||
      data.rows.length > 100 ||
      typeof data.total !== "number"
    )
      throw new Failure(503, "登録情報を確認できませんでした。");
    return response(data);
  } catch (e) {
    return response(
      {
        error:
          e instanceof Failure
            ? e.message
            : "接続を確認できません。再読込してください。",
      },
      e instanceof Failure ? e.status : 503,
    );
  }
}
