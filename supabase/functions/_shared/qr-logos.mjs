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
  ].map((logo) =>
    Object.freeze({ ...logo, background: Object.freeze(logo.background) }),
  ),
);

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
