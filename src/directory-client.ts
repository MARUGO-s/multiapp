import { qrAuth } from "./qr-account-client";
import { SUPABASE_URL } from "./cloud";
export const directorySources = [
  {
    id: "core",
    name: "会議録・QR・レシピ",
    ref: "hjhkccbktkscwtgzxjfq",
    apps: ["kotonoha", "qr", "recipe"],
    note: "kotonohaのGoogle連携、QRの店舗所属、レシピのプロフィール・旧IDを表示します。kotonohaの共通ID利用者は個人特定できません。",
  },
  {
    id: "social",
    name: "SNS・グルメ",
    ref: "ycsqfajidusuibqljjwr",
    apps: ["sns", "gourmet"],
    note: "SNSのプロフィール・所属とグルメの店舗データ所有者を表示します。「登録あり」は承認済みという意味ではありません。",
  },
  {
    id: "line",
    name: "LINE・M-talk・Journal",
    ref: "hocbnifuactbvmyjraxy",
    apps: ["report", "chat", "journal"],
    note: "LINE Bot登録者、M-talkの利用状態、Journal AIの機能許可を表示します。Journalの共通IDと店舗・ルームごとの権限は別管理です。",
  },
];
export const directoryApps: Record<string, string> = {
  kotonoha: "kotonoha",
  qr: "MARUGO QR",
  recipe: "ajisai / レシピ",
  sns: "Instatic TalksX / SNS",
  gourmet: "mimiyori / グルメ",
  report: "hibinowa / LINE",
  chat: "musubi / M-talk",
  journal: "shiori / Journal",
  unassigned: "Authのみ・アプリ未特定",
};
export const directoryStatuses: Record<string, string> = {
  registered: "登録あり",
  active: "承認・有効",
  pending: "承認待ち",
  suspended: "停止中",
  denied: "承認拒否",
  deleted: "利用解除",
  unknown: "未確認",
  unlinked: "アプリ未特定",
  legacy: "共通・旧ID",
  granted: "機能許可あり",
};
export type DirectoryRow = {
  control?: {
    version: string;
    actions: ("approve" | "suspend")[];
    reason: string;
    status: string;
    scope: string;
  } | null;
  key: string;
  app_id: string;
  user_id: string;
  email: string | null;
  name: string;
  status: string;
  role: string;
  affiliation: string;
  created_at: string | null;
  last_sign_in_at: string | null;
  email_verified: boolean;
  provider: string;
  identity_kind: string;
};
export type DirectoryPage = {
  rows: DirectoryRow[];
  total: number;
  nextOffset: number | null;
  asOf: string;
};
export class DirectoryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request<T>(
  url: string,
  operation?: { body: unknown; actor: string },
): Promise<T> {
  const { data, error } = await qrAuth.auth.getSession();
  if (error || !data.session)
    throw new DirectoryError(401, "Googleでログインしてください。");
  if (operation && data.session.user.id !== operation.actor)
    throw new DirectoryError(
      403,
      "アカウントが変わりました。操作を中止しました。",
    );
  let r: Response;
  try {
    r = await fetch(url, {
      method: operation ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + data.session.access_token,
        ...(operation ? { "Content-Type": "application/json" } : {}),
      },
      body: operation ? JSON.stringify(operation.body) : undefined,
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
  } catch {
    throw new DirectoryError(503, "接続を確認できません。再読込してください。");
  }
  const body = await r.json().catch(() => null);
  if (!r.ok || !body)
    throw new DirectoryError(
      r.status,
      body?.error || "取得結果を確認できませんでした。",
    );
  return body;
}
export async function checkDirectoryAdmin() {
  const result = await request<{
    authorized: boolean;
    actor: string;
    canManage: boolean;
  }>(SUPABASE_URL + "/functions/v1/marugo-directory/authorize");
  if (result.authorized !== true)
    throw new DirectoryError(403, "管理者の閲覧権限が必要です。");
  return result;
}
export type DirectoryChange = {
  requestId: string;
  key: string;
  action: "approve" | "suspend";
  version: string;
  reason: string;
};
export function changeDirectoryAccess(actor: string, body: DirectoryChange) {
  return request<{
    ok: boolean;
    key: string;
    status: string;
    requestId: string;
  }>(SUPABASE_URL + "/functions/v1/marugo-directory/change", { body, actor });
}
export type DirectoryHistory = {
  rows: {
    id: number;
    actor_id: string;
    target_key: string;
    action: string;
    reason: string;
    created_at: string;
    before_status: string;
    after_status: string;
  }[];
  nextOffset: number | null;
};
export function getDirectoryHistory(offset = 0) {
  return request<DirectoryHistory>(
    SUPABASE_URL + "/functions/v1/marugo-directory/history?offset=" + offset,
  );
}
export function getDirectoryPage(
  source: (typeof directorySources)[number],
  filters: { app: string; q: string; status: string },
  offset = 0,
) {
  if (!directorySources.some((s) => s.ref === source.ref))
    throw new Error("不明な接続先です。");
  const params = new URLSearchParams({ ...filters, offset: String(offset) });
  return request<DirectoryPage>(
    "https://" +
      source.ref +
      ".supabase.co/functions/v1/marugo-directory/users?" +
      params,
  );
}
