import QRCode from "qrcode";
import jsQR from "jsqr";
import { findQrLogo } from "../supabase/functions/_shared/qr-logos.mjs";

// Keep the established M-level PNG byte-for-byte when no logo was selected.
// Only bundled raster catalog assets can ever enter the canvas.
/**
 * @param {string} text
 * @param {string | null} [logoId]
 * @param {string} [baseUrl]
 * @returns {Promise<string>}
 */
export async function qrImageDataUrl(text, logoId = null, baseUrl = "/") {
  const logo = findQrLogo(logoId);
  if (!logo)
    return QRCode.toDataURL(text, {
      width: 640,
      margin: 4,
      errorCorrectionLevel: "M",
    });
  const image = await new Promise((resolve, reject) => {
    const value = new Image();
    const timer = setTimeout(() => {
      value.onload = value.onerror = null;
      reject(
        new Error(
          "ロゴ画像の読み込みに時間がかかっています。選び直してください。",
        ),
      );
    }, 12000);
    value.onload = () => {
      clearTimeout(timer);
      resolve(value);
    };
    value.onerror = () => {
      clearTimeout(timer);
      reject(
        new Error("ロゴ画像を読み込めませんでした。ロゴを選び直してください。"),
      );
    };
    value.src = `${baseUrl.replace(/\/$/, "")}/qr-logos/${logo.file}`;
  });
  if (
    !image.naturalWidth ||
    !image.naturalHeight ||
    image.naturalWidth > 512 ||
    image.naturalHeight > 512
  )
    throw new Error("ロゴ画像の寸法を確認できませんでした。");
  const input = document.createElement("canvas");
  input.width = image.naturalWidth;
  input.height = image.naturalHeight;
  const inputContext = input.getContext("2d", { willReadFrequently: true });
  if (!inputContext)
    throw new Error("このブラウザーでQR画像を生成できません。");
  inputContext.drawImage(image, 0, 0);
  const pixels = inputContext.getImageData(0, 0, input.width, input.height);
  const raster = createQrRaster(text, {
    width: input.width,
    height: input.height,
    data: pixels.data,
    background: logo.background,
  });
  const output = document.createElement("canvas");
  output.width = raster.width;
  output.height = raster.height;
  const context = output.getContext("2d");
  if (!context) throw new Error("このブラウザーでQR画像を生成できません。");
  context.putImageData(
    new ImageData(raster.data, raster.width, raster.height),
    0,
    0,
  );
  return output.toDataURL("image/png");
}

const SIZE = 640;
const QUIET_MODULES = 4;
const MAX_LOGO_SIDE = 0.22;

// Keep full integer modules, including four clear modules on every side.
// Logos only occupy a small data-only square; finder/timing/alignment/format/
// version cells are never overpainted. Do not interpret H as a safe area ratio.
export function createQrRaster(text, logo = null, options = {}) {
  const errorCorrectionLevel = logo ? "H" : "M";
  const symbol = QRCode.create(text, { ...options, errorCorrectionLevel });
  const symbolSize = symbol.modules.size;
  const modulePixels = Math.floor(SIZE / (symbolSize + QUIET_MODULES * 2));
  if (modulePixels < 2)
    throw new Error("QRコードが細かすぎます。短いURLを使用してください。");
  const offset = Math.floor((SIZE - symbolSize * modulePixels) / 2);
  const data = new Uint8ClampedArray(SIZE * SIZE * 4).fill(255);
  function rectangle(x, y, width, height, color) {
    for (let dy = y; dy < y + height; dy++) {
      for (let dx = x; dx < x + width; dx++) {
        const i = (dy * SIZE + dx) * 4;
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
      }
    }
  }
  for (let row = 0; row < symbolSize; row++) {
    for (let col = 0; col < symbolSize; col++) {
      if (symbol.modules.get(row, col))
        rectangle(
          offset + col * modulePixels,
          offset + row * modulePixels,
          modulePixels,
          modulePixels,
          [0, 0, 0],
        );
    }
  }
  let logoBounds = null;
  if (logo) {
    if (
      !Number.isInteger(logo.width) ||
      !Number.isInteger(logo.height) ||
      logo.width < 1 ||
      logo.height < 1 ||
      !logo.data ||
      logo.data.length !== logo.width * logo.height * 4
    )
      throw new Error(
        "ロゴ画像を読み込めませんでした。ロゴを選び直してください。",
      );
    let side = Math.floor(symbolSize * MAX_LOGO_SIDE);
    if (side % 2 === 0) side--;
    let start = 0;
    for (; side >= 3; side -= 2) {
      start = Math.floor((symbolSize - side) / 2);
      let reserved = false;
      for (let row = start; row < start + side; row++)
        for (let col = start; col < start + side; col++)
          reserved ||= Boolean(symbol.modules.isReserved(row, col));
      if (!reserved) break;
    }
    if (side < 3)
      throw new Error(
        "このQRには中央にロゴを安全に配置できません。「ロゴなし」を選んでください。",
      );
    logoBounds = { start, side };
    const left = offset + start * modulePixels;
    rectangle(
      left,
      left,
      side * modulePixels,
      side * modulePixels,
      [255, 255, 255],
    );
    const available = (side - 2) * modulePixels;
    const ratio = Math.min(available / logo.width, available / logo.height);
    const width = Math.max(1, Math.floor(logo.width * ratio));
    const height = Math.max(1, Math.floor(logo.height * ratio));
    const x = left + Math.floor((side * modulePixels - width) / 2);
    const y = left + Math.floor((side * modulePixels - height) / 2);
    const background = logo.background || [255, 255, 255];
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const source =
          (Math.min(logo.height - 1, Math.floor(row / ratio)) * logo.width +
            Math.min(logo.width - 1, Math.floor(col / ratio))) *
          4;
        const target = ((y + row) * SIZE + x + col) * 4;
        const alpha = logo.data[source + 3] / 255;
        for (let channel = 0; channel < 3; channel++)
          data[target + channel] = Math.round(
            logo.data[source + channel] * alpha +
              background[channel] * (1 - alpha),
          );
      }
    }
  }
  // Fail closed: no PNG may be offered for a different or unreadable payload.
  // This is a software decode check, not a guarantee for printed/physical codes.
  const decoded = jsQR(data, SIZE, SIZE, { inversionAttempts: "dontInvert" });
  if (decoded?.data !== text)
    throw new Error(
      "QR画像の読み取り確認に失敗しました。ロゴなしで再試行してください。",
    );
  return {
    data,
    width: SIZE,
    height: SIZE,
    verifiedText: decoded.data,
    errorCorrectionLevel,
    symbolSize,
    modulePixels,
    offset,
    quietZone: offset / modulePixels,
    logoBounds,
  };
}
