import {
  isCloud,
  getSession,
  clearSession,
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
} from "./cloud";

// リトライ設定
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1秒

// ネットワークエラーかどうかを判定
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return error.message.includes('fetch') || 
           error.message.includes('network') ||
           error.message.includes('Failed to fetch');
  }
  return false;
}

// ユーザーフレンドリーなエラーメッセージ
function getUserFriendlyError(error: unknown, isCloudMode: boolean): string {
  if (isNetworkError(error)) {
    return isCloudMode 
      ? "ネットワーク接続エラーです。インターネット接続を確認してください。"
      : "ローカルサーバーに接続できません。npm run dev を実行しているか確認してください。";
  }
  
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    if (message.includes('timeout') || message.includes('timed out')) {
      return "処理がタイムアウトしました。もう一度お試しください。";
    }
    
    if (message.includes('auth') || message.includes('unauthorized')) {
      return "認証エラーです。再度ログインしてください。";
    }
    
    if (message.includes('permission') || message.includes('forbidden')) {
      return "アクセス権限がありません。";
    }
    
    if (message.includes('not found') || message.includes('404')) {
      return "要求されたリソースが見つかりません。";
    }
    
    if (message.includes('server') || message.includes('500')) {
      return "サーバーエラーが発生しました。しばらく待ってからもう一度お試しください。";
    }
  }
  
  return isCloudMode
    ? "エラーが発生しました。もう一度お試しください。"
    : "エラーが発生しました。ローカルサーバーを確認してください。";
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
  retryCount: number = 0,
): Promise<T> {
  let token = "";
  if (isCloud) {
    const session = getSession();
    if (!session)
      throw new Error("ログインが必要です。再度ログインしてください。");
    token = session.token;
  }
  const base = isCloud ? `${SUPABASE_URL}/functions/v1/kotonoha-api` : "/api";
  
  try {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        ...(options.body instanceof FormData || options.body instanceof Blob
          ? {}
          : { "Content-Type": "application/json" }),
        "X-Kotonoha": "1",
        ...(isCloud
          ? { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY }
          : {}),
        ...options.headers,
      },
    });
    
    if (response.status === 204) return undefined as T;
    if (isCloud && response.status === 401) {
      clearSession();
      throw new Error("ログインセッションが切れました。再度ログインしてください。");
    }
    
    let data;
    try {
      data = await response.json();
    } catch {
      if (!response.ok) {
        throw new Error(getUserFriendlyError(
          new Error(`HTTP ${response.status}`),
          isCloud
        ));
      }
      throw new Error(
        isCloud
          ? "サーバーからの応答を解析できません。"
          : "ローカルサーバーからの応答を解析できません。"
      );
    }
    
    if (!response.ok) {
      throw new Error(data.error || getUserFriendlyError(
        new Error(`HTTP ${response.status}: ${data.message || response.statusText}`),
        isCloud
      ));
    }
    
    return data as T;
  } catch (error) {
    // ネットワークエラーの場合はリトライ
    if (isNetworkError(error) && (options.method || "GET").toUpperCase() === "GET" && retryCount < MAX_RETRIES) {
      console.debug(`リトライ中... (${retryCount + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY * (retryCount + 1)); // 指数バックオフ
      return api<T>(path, options, retryCount + 1);
    }
    
    // リトライ回数を超えた場合やその他のエラー
    if (isNetworkError(error)) throw new Error(getUserFriendlyError(error, isCloud));
    throw error;
  }
}

export async function audioUrl(id: string, part = 0) {
  const path = `/meetings/${id}/audio?part=${part}`;
  if (!isCloud) return `/api${path}`;
  return (await api<{ url: string }>(path)).url;
}

export async function audioBlob(id: string, part = 0) {
  const url = await audioUrl(id, part);
  const failed = "音声を取得できませんでした。通信状況を確認して再度お試しください。";
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(failed);
  }
  if (!response.ok) throw new Error(failed);
  return response.blob();
}

export function download(
  name: string,
  content: BlobPart,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, "_");
  link.click();
  // Large audio files can take a moment before the browser starts reading them.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export { exportToICS, exportMultipleMeetings } from "./meeting-exports.mjs";
