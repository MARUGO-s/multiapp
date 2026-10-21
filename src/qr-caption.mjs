import jsQR from "jsqr";
import { qrImageDataUrl } from "./qr-image.mjs";
import { resolveStoreName } from "../supabase/functions/_shared/qr-store-name.mjs";

const SIZE = 640;
const PADDING = 32;
const TOP_PADDING = 0;
const BOTTOM_PADDING = 24;
// Largest whole-pixel size fitting the reference "MARUGO Marunouchi"
// in the verified system font and 576px caption width (60px overflows).
const FONT_SIZE = 59;
const MIN_FONT_SIZE = 20;
const FONT_FAMILY =
  'system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
const LINE_HEIGHT = 60;
const CAPTION_ERROR =
  "店舗名付きQR画像の読み取りを確認できませんでした。店舗名を空欄にして再試行してください。";

function measureInk(context, value) {
  const metrics = context.measureText(value);
  const {
    width,
    actualBoundingBoxLeft: left,
    actualBoundingBoxRight: right,
    actualBoundingBoxAscent: ascent,
    actualBoundingBoxDescent: descent,
  } = metrics;
  if (![width, left, right, ascent, descent].every(Number.isFinite))
    throw new Error(CAPTION_ERROR);
  // The origin stays centered: include both overhangs, not just advance width.
  // Reserve one extra pixel for antialiasing beyond fractional ink metrics.
  return {
    fits: Math.max(width, left * 2 + 2, right * 2 + 2) <= SIZE - PADDING * 2,
    ascent: Math.max(1, Math.ceil(ascent)) + 1,
    descent: Math.max(1, Math.ceil(descent)) + 1,
  };
}

async function loadPng(source) {
  const image = new Image();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      image.onload = image.onerror = null;
      reject(new Error("QR画像の読み込みに時間がかかっています。"));
    }, 12000);
    image.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error("QR画像を読み込めませんでした。"));
    };
    image.src = source;
  });
  return image;
}

function contextFor(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("このブラウザーでQR画像を生成できません。");
  return context;
}

/**
 * Append a caption without changing any pixel of the existing QR raster.
 * @param {string} text
 * @param {string | null} [logoId]
 * @param {string} [baseUrl]
 * @param {string | null} [storeName]
 * @returns {Promise<string>}
 */
export async function qrImageWithStoreNameDataUrl(
  text,
  logoId = null,
  baseUrl = "/",
  storeName = null,
) {
  const name = resolveStoreName(logoId, storeName);
  const original = await qrImageDataUrl(text, logoId, baseUrl);
  if (!name) return original;
  await document.fonts.ready;
  const image = await loadPng(original);
  if (image.naturalWidth !== SIZE || image.naturalHeight !== SIZE)
    throw new Error("QR画像の寸法を確認できませんでした。");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const context = contextFor(canvas);
  context.drawImage(image, 0, 0);
  const qr = context.getImageData(0, 0, SIZE, SIZE);
  context.textAlign = "center";
  context.textBaseline = "middle";
  // Grapheme segmentation keeps supplementary Japanese and combining marks whole.
  const segments = Array.from(
    new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(name),
    (part) => part.segment,
  );
  // A single grapheme may contain the entire valid 80-code-point name.
  // Keep it whole and readable; never let the first segment bypass the limit.
  let font;
  for (let size = FONT_SIZE; ; size--) {
    font = `500 ${size}px ${FONT_FAMILY}`;
    context.font = font;
    if (segments.every((segment) => measureInk(context, segment).fits)) break;
    if (size === MIN_FONT_SIZE) throw new Error(CAPTION_ERROR);
  }
  const lines = [];
  let line = "";
  for (const segment of segments) {
    if (line && !measureInk(context, line + segment).fits) {
      lines.push(line);
      line = "";
    }
    line += segment;
  }
  if (line) lines.push(line);
  let bottom = SIZE + TOP_PADDING;
  let previousY = 0;
  const placements = lines.map((value, index) => {
    const ink = measureInk(context, value);
    if (!ink.fits) throw new Error(CAPTION_ERROR);
    const y = Math.max(
      bottom + (index ? 12 : 0) + ink.ascent,
      previousY + LINE_HEIGHT,
    );
    bottom = y + ink.descent;
    previousY = y;
    return { value, y };
  });
  // Bound allocation and reject unmeasurable/pathological output before export.
  if (bottom + BOTTOM_PADDING > SIZE + 4096) throw new Error(CAPTION_ERROR);
  // Keep the established single-line export envelope. Moving the caption up
  // must not also shrink the raster and change downstream reader resampling.
  canvas.height = Math.max(SIZE + 112, bottom + BOTTOM_PADDING);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.putImageData(qr, 0, 0);
  context.font = font;
  context.fillStyle = "#111";
  context.textAlign = "center";
  context.textBaseline = "middle";
  placements.forEach(({ value, y }) => context.fillText(value, SIZE / 2, y));
  const result = canvas.toDataURL("image/png");
  // Verify the actual encoded PNG, not just the pre-export canvas.
  const exported = await loadPng(result);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(exported, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  if (qr.data.some((value, index) => pixels.data[index] !== value))
    throw new Error("QR画像の余白・模様の一致を確認できませんでした。");
  if (
    jsQR(pixels.data, pixels.width, pixels.height, {
      inversionAttempts: "dontInvert",
    })?.data !== text
  )
    throw new Error(CAPTION_ERROR);
  return result;
}
