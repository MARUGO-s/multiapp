const code = location.hash.slice(1);
const source =
  { q: "qr", b: "button", l: "link" }[
    new URLSearchParams(location.search).get("s")
  ] || "unknown";
let referrerHost = null;
try {
  const referrer = new URL(document.referrer);
  if (
    ["http:", "https:"].includes(referrer.protocol) &&
    /^[a-z0-9.-]+$/i.test(referrer.hostname)
  )
    referrerHost = referrer.hostname;
} catch {
  /* Missing/blocked referrers remain unknown; never send the path/query. */
}
// One event per page navigation; retries reuse this ID even if the first response
// was lost after committing. Do not put it in persistent/session storage:
// opening the same printed QR again is a new access and should be counted.
const eventId = crypto.randomUUID();
// Separate, expiring IDs for each QR; never reuse Auth IDs or track across QRs.
// Storage denial must not prevent forwarding or manufacture a unique visitor.
function browserVisitorId() {
  if (!/^[A-Za-z0-9_-]{12}$/.test(code)) return null;
  try {
    const key = `marugo-qr-visitor:v1:${code}`;
    const now = Date.now();
    const lifetime = 180 * 24 * 60 * 60 * 1000;
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (
      saved &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        saved.id,
      ) &&
      Number.isFinite(saved.expiresAt) &&
      saved.expiresAt > now &&
      saved.expiresAt <= now + lifetime
    )
      return saved.id;
    const value = { id: crypto.randomUUID(), expiresAt: now + lifetime };
    const encoded = JSON.stringify(value);
    localStorage.setItem(key, encoded);
    return localStorage.getItem(key) === encoded ? value.id : null;
  } catch {
    return null;
  }
}
const visitorId = browserVisitorId();
const status = document.querySelector("#status");
const retry = document.querySelector("#retry");
const heading = document.querySelector("#heading");
const endpoint =
  "https://hjhkccbktkscwtgzxjfq.supabase.co/functions/v1/marugo-qr/scan";
let busy = false;

export async function scan() {
  if (busy) return;
  if (!/^[A-Za-z0-9_-]{12}$/.test(code)) {
    heading.textContent = "QRコードのURLを確認してください";
    status.textContent =
      "リンクが正しくありません。QRコードをもう一度読み込んでください。";
    return;
  }
  busy = true;
  retry.hidden = true;
  status.textContent = "アクセスを記録しています。少しお待ちください。";
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, eventId, source, referrerHost, visitorId }),
      signal: AbortSignal.timeout(15000),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    const data = await response.json();
    if (!response.ok) {
      heading.textContent =
        response.status === 410
          ? "このQRコードは停止中です"
          : "サイトへ移動できませんでした";
      status.textContent = data.error || "通信結果を確認できませんでした。";
      retry.hidden =
        response.status === 404 ||
        response.status === 410 ||
        response.status === 400;
      return;
    }
    const target = new URL(data.targetUrl);
    if (
      !["https:", "http:"].includes(target.protocol) ||
      target.username ||
      target.password
    ) {
      throw new Error("Invalid destination");
    }
    location.replace(target.href);
  } catch {
    heading.textContent = "サイトへ移動できませんでした";
    status.textContent =
      "通信結果を確認できませんでした。接続を確認して、もう一度お試しください。";
    retry.hidden = false;
  } finally {
    busy = false;
  }
}
retry.addEventListener("click", scan);
void scan();
