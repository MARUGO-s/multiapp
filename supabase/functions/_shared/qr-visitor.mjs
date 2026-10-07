const visitorPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validVisitorId(value) {
  return (
    value == null || (typeof value === "string" && visitorPattern.test(value))
  );
}
// High-entropy, per-QR browser IDs only. No IP, fingerprint or Auth identity.
export async function visitorHash(code, visitorId, device) {
  if (visitorId == null || device === "bot") return null;
  const bytes = new TextEncoder().encode(
    `marugo-qr-visitor:v1:${code}:${visitorId.toLowerCase()}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
