// Export real renderer output for a second, independent offline QR decoder.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";
import { createQrRaster, qrImageDataUrl } from "../src/qr-image.mjs";
const output =
  process.env.QR_LOGO_DECODE_OUTPUT || path.join(tmpdir(), "qr-logo-decoding");
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
    };
  }
  const raster = createQrRaster(text, pixels);
  const id = item?.id || "none";
  const png = new PNG({ width: raster.width, height: raster.height });
  png.data = Buffer.from(raster.data);
  // The no-logo UI deliberately uses the established qrcode PNG renderer.
  const outputBytes = item
    ? PNG.sync.write(png)
    : Buffer.from((await qrImageDataUrl(text, null)).split(",")[1], "base64");
  await writeFile(path.join(output, `${id}.png`), outputBytes);
  results.push({
    id,
    file: `${id}.png`,
    renderer: item ? "center-logo-raster" : "unchanged-no-logo-api",
    text,
    verifiedText: raster.verifiedText,
    errorCorrectionLevel: raster.errorCorrectionLevel,
    symbolSize: raster.symbolSize,
    modulePixels: raster.modulePixels,
    logoBounds: raster.logoBounds,
  });
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
