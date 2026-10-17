import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";
import { createQrRaster } from "../src/qr-image.mjs";

const python = process.env.QR_OPENCV_PYTHON || "python3";
const text = "https://marugo-s.github.io/multiapp/?s=q#AbCd1234EfGh";

// Optional independent reader: no product dependency, network or browser I/O.
// Exercise the real catalog PNGs and renderer, not precomputed fixed outputs.
test("OpenCV detects and exactly decodes the seven wide mask-2 store PNGs after area reduction", (t) => {
  const available = spawnSync(
    python,
    ["-c", "import cv2; print(cv2.__version__)"],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
  if (
    available.error?.code === "ENOENT" ||
    /No module named ['\"]cv2/.test(available.stderr || "")
  ) {
    t.skip("optional Python OpenCV is not installed");
    return;
  }
  assert.equal(available.status, 0, available.stderr);
  const ids = [
    "store-marugo-1",
    "store-marugo-2",
    "store-marugo-grande",
    "store-marugo-marunouchi",
    "store-marugo-otto",
    "store-mitan",
    "store-sobaju",
  ];
  const images = ids.map((id) => {
    const item = QR_LOGOS.find((entry) => entry.id === id);
    assert.equal(item?.kind, "store", id);
    const logo = PNG.sync.read(
      readFileSync(new URL(`../public/qr-logos/${item.file}`, import.meta.url)),
    );
    const raster = createQrRaster(
      text,
      {
        width: logo.width,
        height: logo.height,
        data: logo.data,
        background: item.background,
        layout: "store",
      },
      { maskPattern: 2 },
    );
    assert.equal(
      raster.storeMetrics.maskPattern,
      2,
      "never replace the requested mask",
    );
    return { id, text, png: PNG.sync.write(raster).toString("base64") };
  });
  const decoded = spawnSync(
    python,
    [
      "-c",
      String.raw`
import base64, json, sys
import cv2
import numpy as np
results = []
for entry in json.load(sys.stdin):
    original = cv2.imdecode(np.frombuffer(base64.b64decode(entry["png"]), np.uint8), cv2.IMREAD_COLOR)
    assert original is not None and original.shape[:2] == (640, 640)
    for size in [320, 240]:
        image = cv2.resize(original, (size, size), interpolation=cv2.INTER_AREA)
        value, corners, _ = cv2.QRCodeDetector().detectAndDecode(image)
        results.append({"id": entry["id"], "size": size, "detected": corners is not None, "passed": value == entry["text"]})
print(json.dumps({"version": cv2.__version__, "count": len(results), "failed": [row for row in results if not row["passed"]]}))
  `,
    ],
    {
      input: JSON.stringify(images),
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(decoded.status, 0, decoded.stderr || decoded.error?.message);
  const report = JSON.parse(decoded.stdout);
  assert.equal(report.count, 14);
  assert.deepEqual(report.failed, [], JSON.stringify(report));
  t.diagnostic(
    JSON.stringify({
      decoder: "OpenCV",
      version: report.version,
      imageCount: images.length,
      caseCount: report.count,
      failed: report.failed.length,
    }),
  );
});
