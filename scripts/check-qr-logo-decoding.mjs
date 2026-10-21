// Export real renderer output for a second, independent offline QR decoder.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";
import { createQrRaster, qrImageDataUrl } from "../src/qr-image.mjs";
const output =
  process.env.QR_LOGO_DECODE_OUTPUT || path.join(tmpdir(), "qr-logo-decoding");
const masks =
  process.env.QR_LOGO_DECODE_MASKS === "all"
    ? Array.from({ length: 8 }, (_, i) => i)
    : [undefined];
if (
  process.env.QR_LOGO_DECODE_MASKS !== undefined &&
  process.env.QR_LOGO_DECODE_MASKS !== "all"
) {
  throw new Error("QR_LOGO_DECODE_MASKS must be all or unset");
}
await mkdir(output, { recursive: true });
const text = "https://marugo-s.github.io/multiapp/?s=q#AbCd1234EfGh";
const results = [];
for (const item of [null, ...QR_LOGOS]) {
  let pixels = null;
  if (item) {
    const image = PNG.sync.read(
      await readFile(
        new URL(`../public/qr-logos/${item.file}`, import.meta.url),
      ),
    );
    pixels = {
      width: image.width,
      height: image.height,
      data: image.data,
      background: item.background,
      ...(item.kind === "store" ? { layout: "store" } : {}),
    };
  }
  // The baseline is always the actual established no-logo API, not an approximation.
  for (const maskPattern of item ? masks : [undefined]) {
    const raster = createQrRaster(
      text,
      pixels,
      maskPattern === undefined ? {} : { maskPattern },
    );
    const id = item?.id || "none";
    const file = `${id}${maskPattern === undefined ? "" : `-mask-${maskPattern}`}.png`;
    const png = new PNG({ width: raster.width, height: raster.height });
    png.data = Buffer.from(raster.data);
    const outputBytes = item
      ? PNG.sync.write(png)
      : Buffer.from((await qrImageDataUrl(text, null)).split(",")[1], "base64");
    await writeFile(path.join(output, file), outputBytes);
    results.push({
      id,
      file,
      kind: item?.kind || "none",
      renderer: item ? "center-logo-raster" : "unchanged-no-logo-api",
      text,
      ...(maskPattern === undefined ? {} : { maskPattern }),
      verifiedText: raster.verifiedText,
      errorCorrectionLevel: raster.errorCorrectionLevel,
      symbolSize: raster.symbolSize,
      modulePixels: raster.modulePixels,
      logoBounds: raster.logoBounds,
      ...(raster.storeMetrics ? { storeMetrics: raster.storeMetrics } : {}),
    });
  }
}
await writeFile(
  path.join(output, "renderer-results.json"),
  JSON.stringify({ images: results, completed: results.length }, null, 2),
);
console.log(
  JSON.stringify({
    output,
    completed: results.length,
    allJsQrDecoded: results.every(
      (result) => result.text === result.verifiedText,
    ),
  }),
);
