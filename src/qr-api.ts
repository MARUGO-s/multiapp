import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./cloud";
import { buildTrackingUrl } from "./qr-routing.mjs";
import { createContext, useContext, useMemo } from "react";
import { qrCredentials } from "./qr-account-client";
import { scopedQrPath } from "./qr-account-routing.mjs";

export const QrScopeContext = createContext<{
  storeId: string;
  userId: string;
  credentialKey?: string;
} | null>(null);
export function useQrApi() {
  const scope = useContext(QrScopeContext);
  return useMemo(
    () =>
      <T>(path: string, options: RequestInit = {}) =>
        qrApi<T>(path, options, scope),
    [scope],
  );
}

export type QrLink = {
  id: string;
  code: string;
  title: string;
  target_url: string;
  scan_count: number;
  active: boolean;
  created_at: string;
  last_accessed_at: string | null;
  deleted_at: string | null;
};
export type QrHistory = {
  events: {
    id: number;
    accessed_at: string;
    user_agent: string | null;
    source: string;
    referrer_host: string | null;
    device: string;
    browser: string;
  }[];
  total: number;
};
export type QrAnalyticsData = {
  linkId: string;
  days: number;
  startDate: string;
  endDate: string;
  daily: {
    date: string;
    count: number;
    uniqueCount: number;
    unknownCount: number;
    botCount: number;
  }[];
  periodTotal: number;
  periodUnique: number;
  totalUnique: number;
  identifiedAccesses: number;
  unknownAccesses: number;
  botAccesses: number;
  total: number;
  generatedAt: string;
  source: string;
  sources: { key: string; count: number; uniqueCount: number }[];
  devices: { key: string; count: number; uniqueCount: number }[];
  browsers: { key: string; count: number; uniqueCount: number }[];
  referrers: { key: string; count: number; uniqueCount: number }[];
};
export function trackingUrl(
  code: string,
  source: "qr" | "button" | "link" | "unknown" = "unknown",
) {
  return buildTrackingUrl(
    import.meta.env.BASE_URL,
    location.origin,
    code,
    source,
  );
}
export async function qrApi<T>(
  path: string,
  options: RequestInit = {},
  scope: {
    storeId: string;
    userId: string;
    credentialKey?: string;
  } | null = null,
): Promise<T> {
  if (!scope) throw new Error("ログインが必要です。");
  const credentials = await qrCredentials();
  if ((scope.credentialKey || scope.userId) !== credentials.identityKey)
    throw new Error(
      "ログイン情報が変わりました。所属店舗を確認し直してください。",
    );
  const response = await fetch(
    `${SUPABASE_URL}/functions/v1/marugo-qr${scopedQrPath(path, scope.storeId)}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${credentials.token}`,
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (response.status === 401) {
    throw new Error("ログインの有効期限が切れました。");
  }
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "通信結果を確認できませんでした。");
  }
  return data as T;
}
