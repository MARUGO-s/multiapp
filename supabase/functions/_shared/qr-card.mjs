const CODE = /^[A-Za-z0-9_-]{12}$/;
const SOURCE = { q: "q", b: "b", l: "l" };
const PUBLIC_ORIGIN = "https://marugo-waltz.com";

export function escapeCardText(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 180)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function cardDestination(code, source = "b") {
  if (!CODE.test(code)) throw new Error("Invalid QR code");
  const marker = SOURCE[source] || "l";
  return `${PUBLIC_ORIGIN}/?s=${marker}#${code}`;
}

export function htmlCardPageUrl(origin, code, source = "button") {
  if (!CODE.test(code)) throw new Error("Invalid QR code");
  const marker = { qr: "q", button: "b", link: "l" }[source] || "l";
  const url = new URL(
    `s/${code}.html`,
    origin.endsWith("/") ? origin : `${origin}/`,
  );
  url.searchParams.set("s", marker);
  return url.href;
}

export function cardHtml(name, code) {
  if (!CODE.test(code)) throw new Error("Invalid QR code");
  const text = escapeCardText(name || "公開リンク");
  const href = escapeCardText(cardDestination(code, "l"));
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${text}</title>
<meta name="description" content="${text}">
<meta property="og:title" content="${text}">
<meta property="og:description" content="${text}">
<meta name="robots" content="noindex">
</head>
<body>
<p>${text}</p>
<p><a href="${href}">開く</a></p>
<script>
const marker = new URLSearchParams(location.search).get("s");
const source = marker === "q" || marker === "b" || marker === "l" ? marker : "l";
location.replace(${JSON.stringify(PUBLIC_ORIGIN)} + "/?s=" + source + "#${code}");
</script>
</body>
</html>
`;
}
