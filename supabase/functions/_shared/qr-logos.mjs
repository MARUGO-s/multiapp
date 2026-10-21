// Stable IDs are persisted by the QR API/DB. Never accept user-supplied URLs,
// data URIs or SVG markup as catalog entries. Keep SQL's allowlist in sync.
export const QR_LOGOS = Object.freeze(
  [
    {
      id: "instagram-black",
      label: "Instagram・黒",
      file: "instagram-black.png",
      background: [255, 255, 255],
    },
    {
      id: "instagram-gradient",
      label: "Instagram・グラデーション",
      file: "instagram-gradient.png",
      background: [255, 255, 255],
    },
    {
      id: "instagram-white",
      label: "Instagram・白",
      file: "instagram-white.png",
      background: [38, 43, 53],
    },
    {
      id: "line-android",
      label: "LINE・丸形",
      file: "line-android.png",
      background: [255, 255, 255],
    },
    {
      id: "line-ios",
      label: "LINE・角丸",
      file: "line-ios.png",
      background: [255, 255, 255],
    },
    {
      id: "line-icons8-100",
      label: "LINE・線画 100",
      file: "line-icons8-100.png",
      background: [255, 255, 255],
    },
    {
      id: "line-icons8-50",
      label: "LINE・線画 50",
      file: "line-icons8-50.png",
      background: [255, 255, 255],
    },
    {
      id: "instagram-icons8-100",
      label: "Instagram・線画 100",
      file: "instagram-icons8-100.png",
      background: [255, 255, 255],
    },
    {
      id: "instagram-icons8-50",
      label: "Instagram・線画 50",
      file: "instagram-icons8-50.png",
      background: [255, 255, 255],
    },
    {
      id: "x-icons8-100",
      label: "X・線画 100",
      file: "x-icons8-100.png",
      background: [255, 255, 255],
    },
    {
      id: "x-icons8-50",
      label: "X・線画 50",
      file: "x-icons8-50.png",
      background: [255, 255, 255],
    },
    {
      id: "facebook-icons8-100",
      label: "Facebook・線画 100",
      file: "facebook-icons8-100.png",
      background: [255, 255, 255],
    },
    {
      id: "facebook-icons8-48",
      label: "Facebook・青 48",
      file: "facebook-icons8-48.png",
      background: [255, 255, 255],
    },
    {
      id: "facebook-icons8-50",
      label: "Facebook・線画 50",
      file: "facebook-icons8-50.png",
      background: [255, 255, 255],
    },
    {
      id: "facebook-icons8-96",
      label: "Facebook・青 96",
      file: "facebook-icons8-96.png",
      background: [255, 255, 255],
    },
    {
      id: "store-marugo-d",
      label: "MARUGO-D",
      file: "store-marugo-d.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-marugo-es",
      label: "MARUGO・S",
      file: "store-marugo-es.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-371bar",
      label: "371 BAR",
      file: "store-371bar.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-blu-nero",
      label: "BLU NERO",
      file: "store-blu-nero.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-briccola",
      label: "Briccola",
      file: "store-briccola.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-cava",
      label: "BISTRO CAVA CAVA",
      file: "store-cava.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-claudia2",
      label: "Pizzeria Claudia²",
      file: "store-claudia2.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-donaiya",
      label: "どないや",
      file: "store-donaiya.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-erics",
      label: "eric'S",
      file: "store-erics.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-koruri",
      label: "こるり",
      file: "store-koruri.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-marugo-1",
      label: "MARUGO（1）",
      file: "store-marugo-1.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-marugo-2",
      label: "MARUGO II",
      file: "store-marugo-2.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-marugo-grande",
      label: "MARUGO GRANDE",
      file: "store-marugo-grande.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-marugo-marunouchi",
      label: "MARUGO Marunouchi",
      file: "store-marugo-marunouchi.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-marugo-otto",
      label: "MARUGO OTTO",
      file: "store-marugo-otto.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-marugo-shinbashi",
      label: "MARUGO SHINBASHI",
      file: "store-marugo-shinbashi.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-marugo-yotsuya",
      label: "MARUGO YOTSUYA",
      file: "store-marugo-yotsuya.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-mitan",
      label: "MITAN",
      file: "store-mitan.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-pelota",
      label: "BAR PELOTA",
      file: "store-pelota.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-sobaju",
      label: "SOBA-JU",
      file: "store-sobaju.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-violet",
      label: "Bar Violet",
      file: "store-violet.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-x-c",
      label: "街中華 X&C",
      file: "store-x-c.png",
      background: [255, 255, 255],
      kind: "store",
    },
    {
      id: "store-yakiniku",
      label: "焼肉 MARUGO",
      file: "store-yakiniku.png",
      background: [255, 255, 255],
      kind: "store",
    },
  ].map((logo) =>
    Object.freeze({
      kind: "sns",
      ...logo,
      background: Object.freeze(logo.background),
    }),
  ),
);

export const QR_LOGO_CATALOG_HEADER = "x-qr-logo-catalog";
export const QR_LOGO_CATALOG_VALUE = QR_LOGOS.map((logo) => logo.id).join(",");

// The shipped pre-capability client knows exactly these IDs. Do not derive
// this set from the growing catalog (including future SNS additions).
const legacyLogoIds = new Set([
  "instagram-black",
  "instagram-gradient",
  "instagram-white",
  "line-android",
  "line-ios",
  "line-icons8-100",
  "line-icons8-50",
  "instagram-icons8-100",
  "instagram-icons8-50",
  "x-icons8-100",
  "x-icons8-50",
  "facebook-icons8-100",
  "facebook-icons8-48",
  "facebook-icons8-50",
  "facebook-icons8-96",
]);

// Response compatibility only, never an authorization or write-validation rule.
export function supportsQrLogoPayload(data, header) {
  // Bound processing before splitting; malformed declarations support no IDs.
  // Unknown but well-formed IDs are allowed for future clients, not for writes.
  const supported =
    header == null
      ? legacyLogoIds
      : new Set(
          typeof header === "string" &&
            header.length <= 4096 &&
            /^[a-z0-9]+(?:-[a-z0-9]+)*(?:,[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(
              header,
            )
            ? header.split(",")
            : [],
        );
  const pending = [data];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (
      Object.hasOwn(value, "logo_id") &&
      value.logo_id != null &&
      !supported.has(value.logo_id)
    )
      return false;
    pending.push(...Object.values(value));
  }
  return true;
}

const ids = new Set(QR_LOGOS.map((logo) => logo.id));
export function validateLogoId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !ids.has(value))
    throw new Error("INVALID_LOGO");
  return value;
}
export function findQrLogo(id) {
  const value = validateLogoId(id);
  return value === null ? null : QR_LOGOS.find((logo) => logo.id === value);
}
