// Actual browser canvas + actual assets; never follow the encoded tracking URL.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";
const output =
  process.env.QR_LOGO_EVIDENCE || path.join(tmpdir(), "qr-caption-browser");
await mkdir(output, { recursive: true });
assert.ok(
  existsSync(new URL("../src/qr-caption.mjs", import.meta.url)),
  "caption renderer must exist",
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const payload = "https://marugo-s.github.io/multiapp/?s=q#AbCd1234EfGh";
try {
  const context = await browser.newContext();
  const blocked = [],
    errors = [];
  await context.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    if (["127.0.0.1", "localhost"].includes(host)) return route.continue();
    if (host === "fonts.googleapis.com")
      return route.fulfill({ contentType: "text/css", body: "" });
    blocked.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    process.env.QR_LOGO_PREVIEW || "http://127.0.0.1:5197/__qr_logo_preview",
  );
  const cases = [
    ...QR_LOGOS.filter((logo) => logo.kind === "store").map((logo) => ({
      id: logo.id,
      name: null,
      label: "default",
    })),
    { id: "store-marugo-2", name: "丸五 新宿店 MARUGO", label: "custom" },
    {
      id: "store-marugo-2",
      name: "店舗名日本語".repeat(10) + "Latin-ABC".repeat(2),
      label: "long-japanese-latin",
    },
    { id: "store-marugo-2", name: "𠮷".repeat(80), label: "unicode80" },
    {
      id: "store-marugo-2",
      name: "क्".repeat(39) + "का",
      label: "single-grapheme80",
    },
    {
      id: "store-marugo-2",
      name: "g" + "\u0316".repeat(79),
      label: "combining-below80",
    },
    {
      id: "store-marugo-2",
      name: "A" + "\u030d".repeat(79),
      label: "combining-above80",
    },
    {
      id: "store-marugo-2",
      name: "W".repeat(14) + "f" + "\u0336".repeat(65),
      label: "combining-right-overhang80",
    },
    {
      id: "store-marugo-2",
      name: "𝐴".repeat(80),
      label: "italic-left-overhang80",
    },
    {
      id: "store-marugo-2",
      name: "𝑁".repeat(80),
      label: "italic-right-overhang80",
    },
    {
      id: "store-marugo-2",
      name: "छ्".repeat(39) + "छा",
      label: "unfittable-grapheme80",
      expectError: true,
    },
    { id: "store-marugo-2", name: "", label: "hidden" },
    ...QR_LOGOS.filter((logo) => logo.kind !== "store").map((logo) => ({
      id: logo.id,
      name: "ignored",
      label: "sns-unchanged",
    })),
    { id: null, name: "ignored", label: "no-logo-unchanged" },
  ];
  for (const item of cases) {
    if (item.label.endsWith("80"))
      assert.equal(
        [...item.name].length,
        80,
        `${item.label}: valid 80-code-point fixture`,
      );
    const data = await page.evaluate(
      async ({ item, payload }) => {
        const { qrImageDataUrl } = await import("/src/qr-image.mjs");
        const { qrImageWithStoreNameDataUrl } =
          await import("/src/qr-caption.mjs");
        const { resolveStoreName } =
          await import("/supabase/functions/_shared/qr-store-name.mjs");
        const draw = CanvasRenderingContext2D.prototype.fillText;
        const lines = [];
        CanvasRenderingContext2D.prototype.fillText = function (
          value,
          x,
          y,
          ...rest
        ) {
          if (this.canvas.height > 640) {
            const metrics = this.measureText(value);
            lines.push({
              value,
              width: metrics.width,
              x,
              y,
              font: this.font,
              left: x - metrics.actualBoundingBoxLeft,
              right: x + metrics.actualBoundingBoxRight,
              top: y - metrics.actualBoundingBoxAscent,
              bottom: y + metrics.actualBoundingBoxDescent,
            });
          }
          return draw.call(this, value, x, y, ...rest);
        };
        try {
          return {
            original: await qrImageDataUrl(payload, item.id, "/"),
            caption: await qrImageWithStoreNameDataUrl(
              payload,
              item.id,
              "/",
              item.name,
            ),
            name: resolveStoreName(item.id, item.name),
            lines,
          };
        } catch (error) {
          return { error: error.message, lines };
        } finally {
          CanvasRenderingContext2D.prototype.fillText = draw;
        }
      },
      { item, payload },
    );
    if (item.expectError) {
      assert.equal(
        data.error,
        "店舗名付きQR画像の読み取りを確認できませんでした。店舗名を空欄にして再試行してください。",
      );
      assert.equal(
        data.caption,
        undefined,
        "unfittable ink must never return a PNG",
      );
      assert.deepEqual(
        data.lines,
        [],
        "fail before painting an unfittable caption",
      );
      results.push({ ...item, rejected: true, error: data.error });
      await writeFile(
        path.join(output, `${item.label}.json`),
        JSON.stringify(results.at(-1), null, 2),
      );
      continue;
    }
    assert.equal(data.error, undefined, `${item.label}: renderer must succeed`);
    const original = PNG.sync.read(
      Buffer.from(data.original.split(",")[1], "base64"),
    );
    const bytes = Buffer.from(data.caption.split(",")[1], "base64");
    const png = PNG.sync.read(bytes);
    assert.equal(png.width, 640);
    assert.ok(
      png.data.subarray(0, original.data.length).equals(original.data),
      `${item.id}: original QR + quiet zone are untouched`,
    );
    assert.equal(
      jsQR(new Uint8ClampedArray(png.data), png.width, png.height, {
        inversionAttempts: "dontInvert",
      })?.data,
      payload,
    );
    await writeFile(
      path.join(output, `${item.id || "none"}-${item.label}-metrics.json`),
      JSON.stringify(
        {
          ...item,
          lines: data.lines,
          height: png.height,
          exactDecode: true,
          codepoints: [...data.name].length,
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(output, `${item.id || "none"}-${item.label}.png`),
      bytes,
    );
    const named = item.id?.startsWith("store-") && item.name !== "";
    if (named) {
      assert.ok(
        png.height > 640,
        "caption has a separate area below the complete QR",
      );
      assert.equal(
        data.lines.map((line) => line.value).join(""),
        data.name,
        "every grapheme is rendered without ellipsis",
      );
      const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
      const graphemes = (text) =>
        Array.from(segmenter.segment(text), (part) => part.segment);
      assert.deepEqual(
        data.lines.flatMap((line) => graphemes(line.value)),
        graphemes(data.name),
        "line wrapping never splits a grapheme",
      );
      for (const line of data.lines) {
        const fontSize = Number(line.font.match(/(\d+)px/)[1]);
        assert.ok(
          fontSize >= 20 && fontSize <= 59,
          "caption font stays readable",
        );
        assert.ok(
          line.width <= 576 &&
            line.x === 320 &&
            line.y > 640 &&
            line.y < png.height - 24,
          "caption stays within its own area",
        );
        assert.ok(
          line.left >= 32 &&
            line.right <= 608 &&
            line.top >= 640 &&
            line.bottom <= png.height - 24,
          `${item.label}: actual glyph ink stays inside caption padding: ${JSON.stringify(line)}`,
        );
      }
      if (item.label === "default") {
        assert.deepEqual(
          {
            enlarged: data.lines.every((line) => /\b59px\b/.test(line.font)),
            closer: data.lines[0].top - 640 <= 2,
          },
          { enlarged: true, closer: true },
          "default caption uses the 59px reference size and its ink gap stays at most 2px",
        );
      }
      for (let y = 640; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
          const i = (y * png.width + x) * 4;
          if (
            png.data[i] < 250 ||
            png.data[i + 1] < 250 ||
            png.data[i + 2] < 250
          )
            assert.ok(
              x >= 32 && x < 608 && y >= 640 && y < png.height - 24,
              `${item.label}: actual raster ink escaped caption padding at ${x},${y}`,
            );
        }
      }
      const bottom = png.data.subarray(640 * 640 * 4);
      assert.ok(
        bottom.some((v, i) => i % 4 !== 3 && v < 100),
        "caption area contains dark text",
      );
    } else
      assert.equal(
        data.caption,
        data.original,
        "SNS/no-logo/hidden retain exact original data URL",
      );
    results.push({
      ...item,
      width: png.width,
      height: png.height,
      lines: data.lines,
      exactDecode: true,
      originalPixelsEqual: true,
    });
  }
  assert.equal(results.length, cases.length);
  const ui = [];
  for (const viewport of [
    { label: "desktop", width: 1440, height: 1000 },
    { label: "phone", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.reload();
    await page.locator(".qr-link-row").first().waitFor();
    await page.evaluate(() => {
      window.__qrFixture.rows[0].logo_id = "store-marugo-es";
      window.__qrFixture.rows[0].store_name = null;
    });
    await page.locator(".page-heading button").click();
    await page.locator(".qr-link-row").first().click();
    await page.waitForFunction(
      () => document.querySelector(".qr-preview img")?.naturalHeight > 640,
    );
    const preview = page.locator(".qr-preview");
    assert.equal(
      await page
        .locator(".qr-logo-editor .qr-store-name-field input")
        .inputValue(),
      "MARUGO・S",
    );
    assert.equal(
      await preview.locator("a").getAttribute("href"),
      await preview.locator("img").getAttribute("src"),
    );
    await page.locator(".qr-detail-card").screenshot({
      path: path.join(output, `${viewport.label}-marugo-es-default-editor.png`),
    });
    await page.evaluate(() => {
      window.__qrFixture.rows[0].store_name = "छ्".repeat(39) + "छा";
    });
    await page.locator(".page-heading button").click();
    await preview.getByRole("alert").waitFor();
    assert.match(
      await preview.getByRole("alert").innerText(),
      /店舗名を空欄にして再試行/,
    );
    assert.equal(await preview.locator("a").getAttribute("href"), null);
    assert.equal(
      await preview.locator("a").getAttribute("aria-disabled"),
      "true",
    );
    assert.equal(await preview.locator("img").count(), 0);
    await page.locator(".qr-detail-card").screenshot({
      path: path.join(output, `${viewport.label}-unfittable-visible-error.png`),
    });
    await page.evaluate(() => {
      window.__qrFixture.rows[0].store_name = "";
    });
    await page.locator(".page-heading button").click();
    await page.waitForFunction(
      () => document.querySelector(".qr-preview img")?.naturalHeight === 640,
    );
    const restored = await preview.locator("img").getAttribute("src");
    const original = await page.evaluate(async (payload) => {
      const { qrImageDataUrl } = await import("/src/qr-image.mjs");
      return qrImageDataUrl(payload, "store-marugo-es", "/");
    }, payload);
    assert.equal(
      restored,
      original,
      "clearing an unfittable caption restores the exact original PNG",
    );
    ui.push({
      viewport: viewport.label,
      visibleError: true,
      noUnverifiedExport: true,
      hiddenRecovery: true,
    });
  }
  assert.equal(ui.length, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  await writeFile(
    path.join(output, "caption-render-results.json"),
    JSON.stringify(
      { count: results.length, results, ui, productionWrites: 0 },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ count: results.length, allPassed: true, output }),
  );
} finally {
  await browser.close();
}
