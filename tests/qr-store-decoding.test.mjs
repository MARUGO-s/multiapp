import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";
import { createQrRaster } from "../src/qr-image.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("mistyped all-mask selection fails explicitly instead of silently checking only one mask", () => {
  const output = mkdtempSync(path.join(tmpdir(), "qr-invalid-mask-export-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["scripts/check-qr-logo-decoding.mjs"],
      {
        cwd: repo,
        env: {
          ...process.env,
          QR_LOGO_DECODE_OUTPUT: output,
          QR_LOGO_DECODE_MASKS: "ALL",
        },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /QR_LOGO_DECODE_MASKS must be all or unset/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
test("the independent-decoder export uses the real store layout rather than legacy SNS geometry", () => {
  const output = mkdtempSync(path.join(tmpdir(), "qr-store-export-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["scripts/check-qr-logo-decoding.mjs"],
      {
        cwd: repo,
        env: { ...process.env, QR_LOGO_DECODE_OUTPUT: output },
        encoding: "utf8",
        timeout: 90000,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const report = JSON.parse(
      readFileSync(path.join(output, "renderer-results.json"), "utf8"),
    );
    assert.equal(report.images.length, 39);
    const stores = QR_LOGOS.filter((item) => item.kind === "store");
    assert.equal(stores.length, 23);
    for (const item of stores) {
      const entry = report.images.find((image) => image.id === item.id);
      assert.ok(
        entry?.storeMetrics,
        `${item.id} must report its actual maximum-policy placement`,
      );
      const source = PNG.sync.read(
        readFileSync(path.join(repo, "public/qr-logos", item.file)),
      );
      const expected = createQrRaster(entry.text, {
        width: source.width,
        height: source.height,
        data: source.data,
        background: item.background,
        layout: "store",
      });
      const exported = PNG.sync.read(
        readFileSync(path.join(output, entry.file)),
      );
      assert.equal(hash(exported.data), hash(expected.data), item.id);
      assert.deepEqual(entry.logoBounds, expected.logoBounds);
      assert.equal(entry.verifiedText, entry.text);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("all-mask export records every artwork/mask exactly once and keeps the real no-logo control", () => {
  const output = mkdtempSync(path.join(tmpdir(), "qr-all-mask-export-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["scripts/check-qr-logo-decoding.mjs"],
      {
        cwd: repo,
        env: {
          ...process.env,
          QR_LOGO_DECODE_OUTPUT: output,
          QR_LOGO_DECODE_MASKS: "all",
        },
        encoding: "utf8",
        timeout: 90000,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const { images } = JSON.parse(
      readFileSync(path.join(output, "renderer-results.json"), "utf8"),
    );
    assert.equal(images.length, QR_LOGOS.length * 8 + 1);
    assert.equal(new Set(images.map((row) => row.file)).size, images.length);
    assert.equal(images.filter((row) => row.id === "none").length, 1);
    for (const logo of QR_LOGOS) {
      const variants = images.filter((row) => row.id === logo.id);
      assert.deepEqual(
        variants.map((row) => row.maskPattern).sort(),
        [0, 1, 2, 3, 4, 5, 6, 7],
        logo.id,
      );
      assert.ok(variants.every((row) => row.verifiedText === row.text));
      if (logo.kind === "store")
        assert.ok(variants.every((row) => row.storeMetrics));
    }
    const item = QR_LOGOS.find((logo) => logo.id === "store-marugo-2");
    const source = PNG.sync.read(
      readFileSync(path.join(repo, "public/qr-logos", item.file)),
    );
    for (const entry of images.filter((row) => row.id === item.id)) {
      const expected = createQrRaster(
        entry.text,
        {
          width: source.width,
          height: source.height,
          data: source.data,
          background: item.background,
          layout: "store",
        },
        { maskPattern: entry.maskPattern },
      );
      const actual = PNG.sync.read(readFileSync(path.join(output, entry.file)));
      assert.equal(
        hash(actual.data),
        hash(expected.data),
        `${item.id}/mask${entry.maskPattern}`,
      );
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
