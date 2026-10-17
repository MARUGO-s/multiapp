import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
import jsQR from "jsqr";
import {
  QR_LOGOS,
  validateLogoId,
} from "../supabase/functions/_shared/qr-logos.mjs";

const imageModule = await import("../src/qr-image.mjs").catch(() => ({}));
const { createQrRaster } = imageModule;
const tracking = "https://marugo-s.github.io/multiapp/?s=q#AbCd1234EfGh";

test("a small center logo decodes to the unchanged tracking URL and never covers functional modules", () => {
  assert.equal(
    typeof createQrRaster,
    "function",
    "QR artwork needs a verified center-logo renderer",
  );
  const logo = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      220, 20, 80, 255, 220, 20, 80, 255, 220, 20, 80, 255, 220, 20, 80, 255,
    ]),
  };
  const image = createQrRaster(tracking, logo);
  assert.equal(image.verifiedText, tracking);
  assert.equal(image.errorCorrectionLevel, "H");
  assert.equal(image.width, 640);
  assert.equal(
    image.logoBounds.side,
    9,
    "The production QR badge must be one size larger than the original 7-module preview",
  );
  assert.ok(image.logoBounds.side <= image.symbolSize * 0.22);
  assert.ok(image.quietZone >= 4);
  const symbol = QRCode.create(tracking, { errorCorrectionLevel: "H" });
  for (let row = 0; row < symbol.modules.size; row++) {
    for (let col = 0; col < symbol.modules.size; col++) {
      if (!symbol.modules.isReserved(row, col)) continue;
      const x = image.offset + col * image.modulePixels;
      const y = image.offset + row * image.modulePixels;
      const pixel = (y * image.width + x) * 4;
      const expected = symbol.modules.get(row, col) ? 0 : 255;
      assert.deepEqual(
        Array.from(image.data.slice(pixel, pixel + 4)),
        [expected, expected, expected, 255],
        `functional module ${row},${col}`,
      );
    }
  }
});

test("PNG generation keeps no-logo output unchanged and rejects untrusted catalog IDs", async () => {
  assert.equal(
    typeof imageModule.qrImageDataUrl,
    "function",
    "The UI needs a catalog-only PNG renderer",
  );
  const expected = await QRCode.toDataURL(tracking, {
    width: 640,
    margin: 4,
    errorCorrectionLevel: "M",
  });
  const actual = await imageModule.qrImageDataUrl(tracking, null, "/multiapp/");
  assert.equal(actual, expected);
  assert.equal(
    PNG.sync.read(Buffer.from(actual.split(",")[1], "base64")).width,
    640,
  );
  for (const bad of [
    "https://example.invalid/logo.png",
    "../evil.svg",
    "",
    {},
    [],
    3,
  ]) {
    await assert.rejects(
      imageModule.qrImageDataUrl(tracking, bad, "/multiapp/"),
      /INVALID_LOGO/,
    );
  }
});

function suppliedLogo(item) {
  const image = PNG.sync.read(
    readFileSync(new URL(`../public/qr-logos/${item.file}`, import.meta.url)),
  );
  return {
    width: image.width,
    height: image.height,
    data: image.data,
    background: item.background,
  };
}
function resizeRaster(image, size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const source =
        (Math.floor((y * image.height) / size) * image.width +
          Math.floor((x * image.width) / size)) *
        4;
      data.set(image.data.subarray(source, source + 4), (y * size + x) * 4);
    }
  return data;
}

test("all 15 real catalog artworks decode with each of the eight mask patterns", () => {
  let completed = 0;
  for (const item of QR_LOGOS.filter((logo) => logo.kind !== "store"))
    for (let maskPattern = 0; maskPattern < 8; maskPattern++) {
      const raster = createQrRaster(tracking, suppliedLogo(item), {
        maskPattern,
      });
      assert.equal(
        raster.verifiedText,
        tracking,
        `${item.id} mask ${maskPattern}`,
      );
      const decoded = jsQR(resizeRaster(raster, 240), 240, 240, {
        inversionAttempts: "dontInvert",
      });
      assert.equal(
        decoded?.data,
        tracking,
        `${item.id} mask ${maskPattern} at 240px`,
      );
      completed++;
    }
  assert.equal(completed, 120);
});

test("alignment patterns in a center badge fail closed instead of being erased", () => {
  const logo = suppliedLogo(QR_LOGOS[1]);
  assert.throws(
    () => createQrRaster(tracking, logo, { version: 7 }),
    /中央にロゴを安全に配置できません/,
  );
  assert.equal(
    createQrRaster(tracking, null, { version: 7 }).verifiedText,
    tracking,
  );
});

test("quiet zones are opaque white on all sides and malformed logo rasters are rejected", () => {
  const raster = createQrRaster(tracking, suppliedLogo(QR_LOGOS[2]));
  const quietPixels = Math.floor(raster.modulePixels * 4);
  for (let y = 0; y < raster.height; y++)
    for (let x = 0; x < raster.width; x++) {
      if (
        x >= quietPixels &&
        y >= quietPixels &&
        x < raster.width - quietPixels &&
        y < raster.height - quietPixels
      )
        continue;
      const i = (y * raster.width + x) * 4;
      assert.deepEqual(
        Array.from(raster.data.subarray(i, i + 4)),
        [255, 255, 255, 255],
      );
    }
  for (const logo of [
    {},
    { width: 0, height: 1, data: [] },
    { width: 2, height: 2, data: new Uint8ClampedArray(4) },
  ]) {
    assert.throws(() => createQrRaster(tracking, logo), /ロゴ画像/);
  }
  assert.equal(validateLogoId(undefined), null);
  assert.equal(validateLogoId(null), null);
  for (const bad of [
    "https://example.invalid/logo.svg",
    {},
    2,
    "INSTAGRAM-BLACK",
    "instagram-black ",
  ])
    assert.throws(() => validateLogoId(bad), /INVALID_LOGO/);
});
