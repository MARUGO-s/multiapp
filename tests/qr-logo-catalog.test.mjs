import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";

const catalog =
  await import("../supabase/functions/_shared/qr-logos.mjs").catch(() => ({}));

test("all 15 supplied SNS logos retain their compact local assets and verified provenance", () => {
  const sns = catalog.QR_LOGOS.filter((logo) => logo.kind !== "store");
  assert.ok(
    Array.isArray(catalog.QR_LOGOS),
    "The supplied logos need a shared allowlisted catalog",
  );
  assert.equal(sns.length, 15);
  assert.equal(new Set(sns.map((logo) => logo.id)).size, 15);
  const manifest = JSON.parse(
    readFileSync(
      new URL("../docs/qr-logo-assets.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    manifest.entries.filter((entry) => !entry.id.startsWith("store-")).length,
    15,
  );
  let totalBytes = 0;
  for (const logo of sns) {
    assert.match(logo.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(logo.file, `${logo.id}.png`);
    const entry = manifest.entries.find((value) => value.id === logo.id);
    assert.ok(entry?.sourceSha256 && entry?.sourceFilename);
    const bytes = readFileSync(
      new URL(`../public/qr-logos/${logo.file}`, import.meta.url),
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.assetSha256,
    );
    const image = PNG.sync.read(bytes);
    assert.ok(image.width <= 128 && image.height <= 128);
    assert.equal(bytes.length, entry.assetBytes);
    totalBytes += bytes.length;
    assert.equal(catalog.validateLogoId(logo.id), logo.id);
  }
  assert.ok(
    totalBytes < 100000,
    "Do not ship the 11 MB gradient SVG to clients",
  );
});
