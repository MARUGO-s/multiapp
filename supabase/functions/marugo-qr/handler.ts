import { AccountError, qrScope } from "../_shared/qr-account-auth.ts";
import { validVisitorId, visitorHash } from "../_shared/qr-visitor.mjs";
import {
  FileError,
  publicFile,
  prepareFile,
  completeFile,
  removeFile,
} from "./files.ts";
import {
  accessBrowser,
  accessDevice,
  QR_SOURCES,
} from "../_shared/qr-attribution.mjs";

const origins = new Set([
  "https://marugo-s.github.io",
  "http://127.0.0.1:5188",
  "http://localhost:5188",
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codePattern = /^[A-Za-z0-9_-]{12}$/;
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function normalizeTarget(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ApiError(400, "正しいURLを入力してください。");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiError(
      400,
      "http:// または https:// で始まるURLを入力してください。",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.length > 2048
  ) {
    throw new ApiError(
      400,
      "認証情報を含まない http/https のURLを入力してください。",
    );
  }
  if (
    url.hostname === "marugo-s.github.io" &&
    (["/multiapp/marugo", "/OEM/marugo"].includes(
      url.pathname.replace(/\/$/, ""),
    ) ||
      (["/multiapp", "/OEM"].includes(url.pathname.replace(/\/$/, "")) &&
        url.hash.length > 1))
  ) {
    throw new ApiError(
      400,
      "計測用URL自身には転送できません。元のサイトURLを入力してください。",
    );
  }
  return url.href;
}
async function body(req: Request): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "入力内容を確認してください。");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) {
      await reader.cancel();
      throw new ApiError(413, "入力内容が長すぎます。");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value;
  } catch {
    throw new ApiError(400, "入力内容を確認してください。");
  }
}
async function rpc(name: string, args: unknown) {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new ApiError(503, "接続の設定が完了していません。");
  const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.message === "NOT_FOUND") {
      throw new ApiError(404, "このQRコードは見つかりません。");
    }
    if (data.message === "INACTIVE") {
      throw new ApiError(410, "このQRコードは停止中です。");
    }
    if (data.message === "REQUEST_CONFLICT") {
      throw new ApiError(
        409,
        "入力内容が変わりました。もう一度作成してください。",
      );
    }
    if (data.message === "TRASHED") {
      throw new ApiError(
        409,
        "このQRコードはゴミ箱にあります。復元してから操作してください。",
      );
    }
    if (data.message === "NOT_TRASHED") {
      throw new ApiError(
        409,
        "完全削除はゴミ箱内のQRコードだけに実行できます。",
      );
    }
    if (data.message === "CONFIRM_REQUIRED") {
      throw new ApiError(400, "削除対象の確認が必要です。");
    }
    if (data.message === "FILE_QUOTA")
      throw new ApiError(
        409,
        "ファイルの保存容量（500MB）に達しました。不要なファイルQRを完全削除してください。",
      );
    if (
      data.message === "FILE_DELETING" ||
      data.message === "FILE_CLEANUP_REQUIRED"
    )
      throw new ApiError(
        409,
        "ファイルの削除処理中です。ゴミ箱で完全削除を再試行してください。",
      );
    throw new ApiError(
      503,
      "保存・計測結果を確認できませんでした。もう一度お試しください。",
    );
  }
  return data;
}
export async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization,apikey,content-type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  };
  if (origin && origins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers });
  if (origin && !origins.has(origin)) {
    return json({ error: "アクセス元が許可されていません。" }, 403);
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  try {
    const url = new URL(req.url);
    const prefix = "/marugo-qr";
    const index = url.pathname.indexOf(prefix);
    if (index < 0) return json({ error: "ページが見つかりません。" }, 404);
    const route = url.pathname.slice(index + prefix.length);
    const fileRoute = route.match(/^\/files\/([A-Za-z0-9_-]{12})$/);
    if (fileRoute && req.method === "GET")
      return json(await publicFile(fileRoute[1], rpc));
    if (route === "/scan") {
      if (req.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      const input = await body(req);
      if (
        typeof input.code !== "string" ||
        !codePattern.test(input.code) ||
        typeof input.eventId !== "string" ||
        !uuid.test(input.eventId)
      ) {
        throw new ApiError(400, "QRコードのURLが正しくありません。");
      }
      const source = input.source ?? "unknown";
      const referrer = input.referrerHost ?? null;
      if (
        typeof source !== "string" ||
        !QR_SOURCES.includes(source) ||
        (referrer !== null &&
          (typeof referrer !== "string" ||
            referrer.length > 253 ||
            !/^[a-z0-9.-]+$/i.test(referrer)))
      ) {
        throw new ApiError(400, "アクセス情報の形式が正しくありません。");
      }
      const agent = (req.headers.get("user-agent") || "").slice(0, 512);
      if (!validVisitorId(input.visitorId)) {
        throw new ApiError(400, "アクセス情報の形式が正しくありません。");
      }
      const device = accessDevice(agent);
      const data = await rpc("kotonoha_qr_scan_unique", {
        p_code: input.code,
        p_event: input.eventId,
        p_source: source,
        p_referrer_host:
          typeof referrer === "string" ? referrer.toLowerCase() : null,
        p_device: device,
        p_browser: accessBrowser(agent),
        p_user_agent: agent,
        p_visitor_hash: await visitorHash(input.code, input.visitorId, device),
      });
      return json({ targetUrl: normalizeTarget(data.targetUrl) });
    }
    // Auth verifies the JWT remotely; DB derives the allowed store, not the body.
    // Legacy shared credentials never authorize store management.
    const session = await qrScope(req, url);
    const args = { p_owner: session.workspaceId };
    if (route === "/uploads" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.id !== "string" || !uuid.test(input.id))
        throw new ApiError(400, "アップロードのIDが正しくありません。");
      return json(await prepareFile(input, session.workspaceId, rpc));
    }
    const uploadRoute = route.match(/^\/uploads\/([^/]+)(\/complete)?$/);
    if (uploadRoute && uuid.test(uploadRoute[1])) {
      if (uploadRoute[2] === "/complete" && req.method === "POST")
        return json(
          await completeFile(uploadRoute[1], session.workspaceId, rpc),
          201,
        );
      if (!uploadRoute[2] && req.method === "DELETE") {
        const input = await body(req);
        if (input.confirmId !== uploadRoute[1])
          throw new ApiError(400, "削除対象の確認が必要です。");
        await removeFile(uploadRoute[1], session.workspaceId, rpc, true);
        return json({ removed: true });
      }
    }
    const page = Number(url.searchParams.get("page") || 0);
    if (!Number.isInteger(page) || page < 0 || page > 100000) {
      throw new ApiError(400, "ページ指定が正しくありません。");
    }
    if (route === "/links" && req.method === "GET") {
      const view = url.searchParams.get("view") ?? "active";
      if (view !== "active" && view !== "trash") {
        throw new ApiError(400, "一覧の指定が正しくありません。");
      }
      return json(
        await rpc("kotonoha_qr", {
          ...args,
          p_operation: view === "trash" ? "trash_list" : "list",
          p_payload: { page },
        }),
      );
    }
    if (route === "/links" && req.method === "POST") {
      const input = await body(req);
      if (
        typeof input.id !== "string" ||
        !uuid.test(input.id) ||
        typeof input.title !== "string" ||
        !input.title.trim() ||
        input.title.trim().length > 120
      ) {
        throw new ApiError(400, "名前（120文字以内）とURLを入力してください。");
      }
      const code = btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(9))),
      )
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      return json(
        await rpc("kotonoha_qr", {
          ...args,
          p_operation: "create",
          p_id: input.id,
          p_payload: {
            code,
            title: input.title.trim(),
            targetUrl: normalizeTarget(input.targetUrl),
          },
        }),
        201,
      );
    }
    const match = route.match(
      /^\/links\/([^/]+)(\/history|\/analytics|\/trash|\/restore)?$/,
    );
    if (match && uuid.test(match[1])) {
      if (
        (match[2] === "/trash" || match[2] === "/restore") &&
        req.method === "POST"
      ) {
        return json(
          await rpc("kotonoha_qr_lifecycle", {
            ...args,
            p_operation: match[2] === "/trash" ? "trash" : "restore",
            p_id: match[1],
          }),
        );
      }
      if (!match[2] && req.method === "DELETE") {
        const input = await body(req);
        if (input.confirmId !== match[1]) {
          throw new ApiError(400, "削除対象の確認が必要です。");
        }
        await removeFile(match[1], session.workspaceId, rpc);
        return json(
          await rpc("kotonoha_qr_lifecycle", {
            ...args,
            p_operation: "purge",
            p_id: match[1],
            p_confirm_id: input.confirmId,
          }),
        );
      }
      if (match[2] === "/analytics" && req.method === "GET") {
        const days = Number(url.searchParams.get("days") ?? "30");
        const source = url.searchParams.get("source") ?? "all";
        if (![7, 30, 90].includes(days)) {
          throw new ApiError(
            400,
            "集計期間は7日・30日・90日から選んでください。",
          );
        }
        if (source !== "all" && !QR_SOURCES.includes(source)) {
          throw new ApiError(400, "流入経路の指定が正しくありません。");
        }
        return json(
          await rpc("kotonoha_qr_analytics", {
            p_owner: session.workspaceId,
            p_id: match[1],
            p_days: days,
            p_source: source,
          }),
        );
      }
      if (match[2] === "/history" && req.method === "GET") {
        return json(
          await rpc("kotonoha_qr_history", {
            p_owner: session.workspaceId,
            p_id: match[1],
            p_page: page,
          }),
        );
      }
      if (!match[2] && req.method === "PATCH") {
        const input = await body(req);
        if (typeof input.active !== "boolean") {
          throw new ApiError(400, "停止・再開の指定が正しくありません。");
        }
        return json(
          await rpc("kotonoha_qr", {
            ...args,
            p_operation: "active",
            p_id: match[1],
            p_payload: { active: input.active },
          }),
        );
      }
    }
    return json({ error: "ページが見つかりません。" }, 404);
  } catch (error) {
    if (
      error instanceof ApiError ||
      error instanceof FileError ||
      error instanceof AccountError
    ) {
      return json({ error: error.message }, error.status);
    }
    console.error(
      "QR request failed",
      error instanceof Error ? error.name : "unknown",
    );
    return json(
      {
        error: "通信結果を確認できませんでした。もう一度お試しください。",
      },
      503,
    );
  }
}
