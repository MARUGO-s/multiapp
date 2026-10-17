import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import {
  QR_LOGOS,
  validateLogoId,
} from "../supabase/functions/_shared/qr-logos.mjs";

const suppliedStores = [
  "store-marugo-d",
  "store-marugo-es",
  "store-371bar",
  "store-blu-nero",
  "store-briccola",
  "store-cava",
  "store-claudia2",
  "store-donaiya",
  "store-erics",
  "store-koruri",
  "store-marugo-1",
  "store-marugo-2",
  "store-marugo-grande",
  "store-marugo-marunouchi",
  "store-marugo-otto",
  "store-marugo-shinbashi",
  "store-marugo-yotsuya",
  "store-mitan",
  "store-pelota",
  "store-sobaju",
  "store-violet",
  "store-x-c",
  "store-yakiniku",
];

test("the 23 supplied store artworks extend the existing 15-ID catalog with faithful local raster provenance", () => {
  assert.equal(
    QR_LOGOS.length,
    38,
    "15 existing SNS and every one of the 23 store logos are required",
  );
  assert.equal(new Set(QR_LOGOS.map((item) => item.id)).size, 38);
  const stores = QR_LOGOS.filter((item) => item.kind === "store");
  assert.deepEqual(
    stores.map((item) => item.id),
    suppliedStores,
  );
  assert.equal(QR_LOGOS.filter((item) => item.kind === "sns").length, 15);
  const manifest = JSON.parse(
    readFileSync(
      new URL("../docs/qr-logo-assets.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.inputCount, 38);
  assert.equal(manifest.assetCount, 38);
  assert.equal(manifest.entries.length, 38);
  assert.equal(new Set(manifest.entries.map((item) => item.id)).size, 38);
  let total = 0;
  for (const item of QR_LOGOS) {
    const entry = manifest.entries.find((record) => record.id === item.id);
    assert.ok(entry, item.id);
    const bytes = readFileSync(
      new URL(`../public/qr-logos/${item.file}`, import.meta.url),
    );
    const png = PNG.sync.read(bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.assetSha256,
      item.id,
    );
    assert.equal(bytes.length, entry.assetBytes);
    assert.deepEqual([png.width, png.height], entry.dimensions);
    assert.equal(item.file, `${item.id}.png`);
    assert.equal(validateLogoId(item.id), item.id);
    assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.sourceFilename && item.label);
    if (item.kind === "store") {
      assert.equal(entry.sourceKind, "store-attachment");
      assert.ok(png.width <= 512 && png.height <= 512);
      assert.ok(
        entry.geometry?.uniformScale,
        "The same scale must be used on both axes",
      );
      assert.equal(entry.geometry.contentCropped, false);
    } else {
      assert.ok(png.width <= 128 && png.height <= 128);
    }
    total += bytes.length;
  }
  assert.equal(total, manifest.assetTotalBytes);
  assert.ok(
    total < 2_000_000,
    "Ship bounded PNGs, never the original SVG payloads",
  );
});
