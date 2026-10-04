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
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  }
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers });
  if (origin && origin !== "https://marugo-s.github.io")
    return response({ error: "この接続元は許可されていません。" }, 403);
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (req.method !== "GET")
    return response({ error: "このページは閲覧専用です。" }, 405);
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
      !["/marugo-directory/authorize", "/marugo-directory/users"].includes(path)
    )
      return response({ error: "見つかりません。" }, 404);
    if (path.endsWith("/authorize") && url !== CENTRAL)
      return response({ error: "見つかりません。" }, 404);
    const actor = await authorize(url, key, bearer);
    if (path.endsWith("/authorize"))
      return response({ authorized: true, actor });
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
