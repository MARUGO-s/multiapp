import QRCode from "qrcode";
import jsQR from "jsqr";
import ECCode from "qrcode/lib/core/error-correction-code.js";
import QRUtils from "qrcode/lib/core/utils.js";
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
    // Layout is catalog metadata, never caller-controlled geometry or artwork.
    ...(logo.kind === "store" ? { layout: "store" } : {}),
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

// Use the installed generator's version/EC tables, not an area-percentage
// approximation. Ordering mirrors qrcode's createCodewords and setupData;
// tests compare both against the installed private functions for v1..40.
export function createQrCodewordMap(symbol) {
  const { version, errorCorrectionLevel, modules } = symbol;
  const totalCodewords = QRUtils.getSymbolTotalCodewords(version);
  const eccTotal = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
  const blockCount = ECCode.getBlocksCount(version, errorCorrectionLevel);
  const dataTotal = totalCodewords - eccTotal;
  const shortBlocks = blockCount - (totalCodewords % blockCount);
  const shortData = Math.floor(dataTotal / blockCount);
  const eccCodewords = eccTotal / blockCount;
  const correctionCapacity = Math.floor(eccCodewords / 2);
  const blocks = Array.from({ length: blockCount }, (_, index) => ({
    dataCodewords: shortData + (index < shortBlocks ? 0 : 1),
    eccCodewords,
    correctionCapacity,
    // At least half the unknown-codeword correction capacity remains unused.
    logoBudget: Math.floor(correctionCapacity / 2),
  }));
  const codewordToBlock = new Int16Array(totalCodewords);
  let codeword = 0;
  for (let index = 0; index <= shortData; index++)
    for (let block = 0; block < blockCount; block++)
      if (index < blocks[block].dataCodewords)
        codewordToBlock[codeword++] = block;
  for (let index = 0; index < eccCodewords; index++)
    for (let block = 0; block < blockCount; block++)
      codewordToBlock[codeword++] = block;

  const size = modules.size;
  const moduleToCodeword = new Int16Array(size * size).fill(-1);
  let row = size - 1;
  let direction = -1;
  let bit = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (modules.isReserved(row, col - c)) continue;
        if (bit < totalCodewords * 8)
          moduleToCodeword[row * size + col - c] = Math.floor(bit / 8);
        bit++;
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
  return { totalCodewords, blocks, codewordToBlock, moduleToCodeword };
}

// Keep full integer modules, including four clear modules on every side.
// Store-only candidates include the entire white badge, not just colored ink.
// Reserved cells are never painted; H is not interpreted as a safe area ratio.
// A white badge can truncate a data run well beyond its edge into an extra
// finder-like cross, even though no reserved cell or RS budget was violated.
// Guard its cleared footprint, independently of the ink, in both orientations.
// Compare centers with the undecorated symbol: existing data coincidences are
// not new overlay damage. These normalized L1 tolerances come from OpenCV
// 5.0.0 QRDetect's horizontal/cross-line recognition (0.2/0.1), not a size cap.
// This module-grid guard is NOT an implementation of OpenCV or a scan guarantee.
function storeLocatorCrosses(symbol, bounds = null) {
  const size = symbol.modules.size;
  const centers = new Map();
  function weight(runs) {
    const total = runs.reduce((sum, value) => sum + value, 0);
    return runs.reduce(
      (sum, value, index) =>
        sum + Math.abs(value / total - (index === 2 ? 3 : 1) / 7),
      0,
    );
  }
  for (const transpose of [false, true]) {
    function get(row, col) {
      if (transpose) [row, col] = [col, row];
      if (row < 0 || col < 0 || row >= size || col >= size) return 0;
      if (
        bounds &&
        row >= bounds.row &&
        row < bounds.row + bounds.height &&
        col >= bounds.col &&
        col < bounds.col + bounds.width
      )
        return 0;
      return Number(Boolean(symbol.modules.get(row, col)));
    }
    for (let row = 0; row < size; row++) {
      const runs = [];
      for (let col = 0; col < size;) {
        const start = col;
        const ink = get(row, col);
        while (col < size && get(row, col) === ink) col++;
        runs.push({ start, length: col - start, ink });
      }
      for (let index = 0; index + 4 < runs.length; index++) {
        if (!runs[index].ink) continue;
        const scanRuns = runs.slice(index, index + 5).map((run) => run.length);
        if (weight(scanRuns) >= 0.2) continue;
        const x =
          runs[index].start +
          scanRuns.reduce((sum, value) => sum + value, 0) / 2;
        const col = Math.floor(x);
        if (!get(row, col)) continue;
        let top = row;
        let bottom = row + 1;
        while (get(top - 1, col)) top--;
        while (get(bottom, col)) bottom++;
        const outer = [];
        for (const direction of [-1, 1]) {
          let y = direction < 0 ? top - 1 : bottom;
          for (const ink of [0, 1]) {
            let count = 0;
            while (y >= 0 && y < size && get(y, col) === ink) {
              count++;
              y += direction;
            }
            outer.push(count);
          }
        }
        const crossRuns = [
          outer[1],
          outer[0],
          bottom - top,
          outer[2],
          outer[3],
        ];
        if (crossRuns.some((value) => value === 0) || weight(crossRuns) >= 0.1)
          continue;
        const y = (top + bottom) / 2;
        const point = transpose ? [y, x] : [x, y];
        centers.set(point.map((value) => value * 2).join(":"), {
          point,
          scanAxis: transpose ? "column" : "row",
          scanRuns,
          crossRuns,
        });
      }
    }
  }
  return centers;
}

function storeCandidates(symbol, logo, modulePixels) {
  const map = createQrCodewordMap(symbol);
  const size = symbol.modules.size;
  const candidates = [];
  const locatorControl = storeLocatorCrosses(symbol);
  const locatorRejected = [];
  const rejected = { structure: 0, budget: 0, locator: 0 };
  for (let width = 3; width <= size - 8; width += 2) {
    for (let height = 3; height <= size - 8; height += 2) {
      const col = (size - width) / 2;
      const row = (size - height) / 2;
      const seen = new Set();
      const touched = map.blocks.map(() => 0);
      let reserved = false;
      for (let r = row; r < row + height && !reserved; r++) {
        for (let c = col; c < col + width; c++) {
          if (symbol.modules.isReserved(r, c)) {
            reserved = true;
            break;
          }
          const cw = map.moduleToCodeword[r * size + c];
          if (cw >= 0 && !seen.has(cw)) {
            seen.add(cw);
            touched[map.codewordToBlock[cw]]++;
          }
        }
      }
      if (reserved) {
        rejected.structure++;
        continue;
      }
      if (touched.some((count, b) => count > map.blocks[b].logoBudget)) {
        rejected.budget++;
        continue;
      }
      const bounds = { row, col, width, height };
      const fitScale = Math.min(
        ((width - 2) * modulePixels) / logo.width,
        ((height - 2) * modulePixels) / logo.height,
      );
      const conflicts = [...storeLocatorCrosses(symbol, bounds)]
        .filter(([key]) => !locatorControl.has(key))
        .map(([, cross]) => cross);
      if (conflicts.length) {
        rejected.locator++;
        locatorRejected.push({ bounds, fitScale, conflicts });
        continue;
      }
      candidates.push({
        bounds,
        fitScale,
        blocks: map.blocks.map((block, b) => ({
          ...block,
          touchedCodewords: touched[b],
        })),
      });
    }
  }
  // Maximize actual aspect-preserving fit, then minimize the damaged badge.
  // Remaining equal-score ties are deterministic, independent of mask choice.
  candidates.sort(
    (a, b) =>
      b.fitScale - a.fitScale ||
      a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height ||
      a.bounds.width - b.bounds.width,
  );
  return { candidates, rejected, locatorRejected };
}

function paintStoreBadge(data, logo, bounds, modulePixels, offset, scale) {
  const left = offset + bounds.col * modulePixels;
  const top = offset + bounds.row * modulePixels;
  for (let row = top; row < top + bounds.height * modulePixels; row++)
    data.fill(
      255,
      (row * SIZE + left) * 4,
      (row * SIZE + left + bounds.width * modulePixels) * 4,
    );
  const width = Math.max(1, Math.floor(logo.width * scale));
  const height = Math.max(1, Math.floor(logo.height * scale));
  const x = left + Math.floor((bounds.width * modulePixels - width) / 2);
  const y = top + Math.floor((bounds.height * modulePixels - height) / 2);
  const background = logo.background || [255, 255, 255];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const source =
        (Math.min(logo.height - 1, Math.floor(row / scale)) * logo.width +
          Math.min(logo.width - 1, Math.floor(col / scale))) *
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
  return { x, y, width, height, scale };
}

function decodeAtSize(data, size) {
  if (size === SIZE)
    return jsQR(data, SIZE, SIZE, { inversionAttempts: "dontInvert" });
  // Fixed nearest-neighbor reduction is deterministic in Node and browsers.
  const reduced = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const source =
        (Math.floor((y * SIZE) / size) * SIZE + Math.floor((x * SIZE) / size)) *
        4;
      reduced.set(data.subarray(source, source + 4), (y * size + x) * 4);
    }
  return jsQR(reduced, size, size, { inversionAttempts: "dontInvert" });
}

function renderStoreLogo(data, symbol, logo, modulePixels, offset, text) {
  // Store policy also requires the undecorated control to decode at both sizes.
  // Do not try to "repair" an already undersampled symbol with a logo: dense
  // symbols can otherwise spend a minute decoding hundreds of doomed badges.
  for (const size of [SIZE, 240])
    if (decodeAtSize(data, size)?.data !== text)
      throw new Error(
        "QR画像の読み取り確認に失敗しました。短いURLかロゴなしで再試行してください。",
      );
  const { candidates, rejected, locatorRejected } = storeCandidates(
    symbol,
    logo,
    modulePixels,
  );
  const base = data.slice();
  const attempts = [];
  for (const candidate of candidates) {
    data.set(base);
    const logoPixels = paintStoreBadge(
      data,
      logo,
      candidate.bounds,
      modulePixels,
      offset,
      candidate.fitScale,
    );
    let failedSize = null;
    for (const size of [SIZE, 240]) {
      if (decodeAtSize(data, size)?.data !== text) {
        failedSize = size;
        break;
      }
    }
    if (failedSize) {
      attempts.push({
        bounds: candidate.bounds,
        fitScale: candidate.fitScale,
        failedSize,
      });
      continue;
    }
    return {
      bounds: candidate.bounds,
      metrics: {
        version: symbol.version,
        maskPattern: symbol.maskPattern,
        paddingModules: 1,
        dataBorderModules: 4,
        decodeSizes: [SIZE, 240],
        fitScale: candidate.fitScale,
        logoPixels,
        blocks: candidate.blocks,
        eligibleCandidates: candidates.length,
        rejected,
        locatorRejected,
        decodeRejected: attempts,
      },
    };
  }
  if (candidates.length === 0)
    throw new Error(
      "このQRには中央にロゴを安全に配置できません。「ロゴなし」を選んでください。",
    );
  throw new Error(
    "QR画像の読み取り確認に失敗しました。ロゴなしで再試行してください。",
  );
}

export function createQrRaster(text, logo = null, options = {}) {
  if (logo && logo.layout !== undefined && logo.layout !== "store")
    throw new Error("ロゴのレイアウトが不正です。");
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
  let storeMetrics = null;
  if (logo) {
    if (
      !Number.isInteger(logo.width) ||
      !Number.isInteger(logo.height) ||
      logo.width < 1 ||
      logo.height < 1 ||
      !logo.data ||
      logo.data.length !== logo.width * logo.height * 4 ||
      (logo.layout === "store" &&
        (logo.width > 512 ||
          logo.height > 512 ||
          !(
            logo.data instanceof Uint8Array ||
            logo.data instanceof Uint8ClampedArray
          ) ||
          (logo.background !== undefined &&
            (!Array.isArray(logo.background) ||
              logo.background.length !== 3 ||
              logo.background.some(
                (value) => !Number.isInteger(value) || value < 0 || value > 255,
              )))))
    )
      throw new Error(
        "ロゴ画像を読み込めませんでした。ロゴを選び直してください。",
      );
    if (logo.layout === "store") {
      const store = renderStoreLogo(
        data,
        symbol,
        logo,
        modulePixels,
        offset,
        text,
      );
      logoBounds = store.bounds;
      storeMetrics = store.metrics;
    } else {
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
    ...(storeMetrics ? { storeMetrics } : {}),
  };
}
