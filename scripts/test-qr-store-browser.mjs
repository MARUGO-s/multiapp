// Real store-logo controls and exported PNGs, synthetic local API only.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";
const url =
  process.env.QR_LOGO_PREVIEW || "http://127.0.0.1:5197/__qr_logo_preview";
const output =
  process.env.QR_LOGO_EVIDENCE || path.join(tmpdir(), "qr-store-browser");
await mkdir(output, { recursive: true });
const stores = QR_LOGOS.filter((logo) => logo.kind === "store");
assert.equal(stores.length, 23);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
function decode(source) {
  const bytes = Buffer.from(source.split(",")[1], "base64");
  const png = PNG.sync.read(bytes);
  return {
    bytes,
    text: jsQR(new Uint8ClampedArray(png.data), png.width, png.height, {
      inversionAttempts: "dontInvert",
    })?.data,
  };
}
async function choose(picker, id) {
  if ((await picker.locator("details").getAttribute("open")) === null)
    await picker.locator("summary").click();
  await picker.locator(`input[type=radio][value="${id}"]`).check();
}
async function picture(page, expected, previous) {
  if (previous)
    await page.waitForFunction((before) => {
      const image = document.querySelector(".qr-preview img");
      return image?.src.startsWith("data:image/png") && image.src !== before;
    }, previous);
  await page.locator(".qr-preview img").waitFor();
  const source = await page.locator(".qr-preview img").getAttribute("src");
  assert.equal(
    await page.locator(".qr-preview a").getAttribute("href"),
    source,
  );
  assert.equal(decode(source).text, expected);
  return source;
}
const withoutLogo = (row) => {
  const copy = { ...row };
  delete copy.logo_id;
  return copy;
};
try {
  for (const size of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "phone", width: 390, height: 844 },
    { name: "tablet-portrait", width: 768, height: 1024 },
    { name: "tablet-landscape", width: 1024, height: 768 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      hasTouch: size.name !== "desktop",
    });
    const blocked = [];
    await context.route("**/*", (route) => {
      const host = new URL(route.request().url()).hostname;
      if (["127.0.0.1", "localhost"].includes(host)) return route.continue();
      if (host === "fonts.googleapis.com")
        return route.fulfill({
          status: 200,
          contentType: "text/css",
          body: "",
        });
      blocked.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    try {
      await page.goto(url);
      await page.locator(".qr-link-row").first().waitFor();
      await page.locator("#qr-create-link-tab").click();
      const form = page.locator(".qr-create-card"),
        picker = form.locator(".qr-logo-picker");
      const title = "店舗ロゴ最大配置（架空検証）",
        target = "https://example.invalid/store-logo";
      await form.locator("input").first().fill(title);
      await form.locator('input[type="url"]').fill(target);
      for (const store of stores) {
        await choose(picker, store.id);
        assert.ok(
          await picker.locator(`input[value="${store.id}"]`).isChecked(),
        );
        assert.equal(await form.locator("input").first().inputValue(), title);
        assert.equal(
          await form.locator('input[type="url"]').inputValue(),
          target,
        );
        const bounds = await picker
          .locator(`input[value="${store.id}"]`)
          .boundingBox();
        const panel = await picker.locator(".qr-logo-categories").boundingBox();
        assert.ok(
          bounds &&
            panel &&
            bounds.x >= panel.x &&
            bounds.x + bounds.width <= panel.x + panel.width + 1,
        );
      }
      assert.equal(await picker.getByRole("radio").count(), 39);
      assert.equal(
        await picker
          .getByRole("group", { name: "店舗ロゴ", exact: true })
          .getByRole("radio")
          .count(),
        23,
      );
      assert.equal(
        await picker
          .getByRole("group", { name: "SNSロゴ", exact: true })
          .getByRole("radio")
          .count(),
        15,
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.__qrFixture.calls.filter((call) => call.method !== "GET")
              .length,
        ),
        0,
      );
      assert.ok(
        await page.evaluate(() => {
          const panel = document.querySelector(
            ".qr-create-card .qr-logo-categories",
          );
          return (
            panel.getBoundingClientRect().height <=
              Math.min(460, innerHeight * 0.55) + 1 &&
            document.documentElement.scrollWidth <= innerWidth + 1
          );
        }),
      );
      await choose(picker, "store-marugo-d");
      await picker.locator('input[value="store-marugo-d"]').focus();
      await picker.locator('input[value="store-marugo-d"]').press("ArrowRight");
      assert.ok(
        await picker.locator('input[value="store-marugo-es"]').isChecked(),
      );
      await choose(picker, "store-marugo-2");
      await form.screenshot({
        path: path.join(output, `${size.name}-store-gallery.png`),
      });
      results.push({
        viewport: size.name,
        scenario: "all23-native-selections-keyboard-scroll-and-draft-retention",
        passed: true,
        artworks: stores.length,
      });
      await page.evaluate(() => (window.__qrFixture.failure = "unknown-once"));
      await form.locator("button.primary").click();
      await page.getByRole("alert").filter({ hasText: "通信結果" }).waitFor();
      const first = await page.evaluate(
        () =>
          window.__qrFixture.calls.find(
            (call) => call.path === "/links" && call.method === "POST",
          ).body,
      );
      assert.equal(first.logoId, "store-marugo-2");
      assert.equal(await form.locator("input").first().inputValue(), title);
      assert.equal(
        await form.locator('input[type="url"]').inputValue(),
        target,
      );
      assert.ok(
        await picker.locator('input[value="store-marugo-2"]').isChecked(),
      );
      await form.locator("button.primary").click();
      await page
        .locator(".qr-detail-heading h2")
        .filter({ hasText: title })
        .waitFor();
      const written = await page.evaluate(() =>
        window.__qrFixture.calls
          .filter((call) => call.path === "/links" && call.method === "POST")
          .map((call) => call.body),
      );
      assert.equal(written.length, 2);
      assert.deepEqual(written[1], first);
      const created = await page.evaluate(
        (name) => window.__qrFixture.rows.find((row) => row.title === name),
        title,
      );
      const tracking = `https://marugo-s.github.io/multiapp/?s=q#${created.code}`;
      let src = await picture(page, tracking);
      await writeFile(
        path.join(output, `${size.name}-wide-store.png`),
        decode(src).bytes,
      );
      await page
        .locator(".qr-preview")
        .screenshot({
          path: path.join(output, `${size.name}-wide-preview.png`),
        });
      results.push({
        viewport: size.name,
        scenario: "wide-store-create-unknown-result-same-id-retry-and-export",
        passed: true,
      });
      const before = withoutLogo(created);
      const editor = page.locator(".qr-logo-editor");
      await choose(editor.locator(".qr-logo-picker"), "store-blu-nero");
      await editor
        .getByRole("button", { name: "ロゴを保存", exact: true })
        .click();
      const square = await picture(page, tracking, src);
      assert.notEqual(square, src);
      await page
        .getByRole("button", { name: "QR詳細を閉じる", exact: true })
        .click();
      await page.locator(".qr-link-row").filter({ hasText: title }).click();
      assert.ok(
        await page
          .locator('.qr-logo-editor input[value="store-blu-nero"]')
          .isChecked(),
      );
      assert.equal(await picture(page, tracking), square);
      results.push({
        viewport: size.name,
        scenario: "shared-square-store-reopens-with-exact-saved-png",
        passed: true,
      });
      await choose(editor.locator(".qr-logo-picker"), "store-marugo-shinbashi");
      await page.evaluate(() => (window.__qrFixture.failure = "expired"));
      await editor
        .getByRole("button", { name: "ロゴを保存", exact: true })
        .click();
      await editor.getByRole("alert").filter({ hasText: "有効期限" }).waitFor();
      assert.equal(
        await page.locator(".qr-preview img").getAttribute("src"),
        square,
      );
      assert.ok(
        await editor
          .locator('input[value="store-marugo-shinbashi"]')
          .isChecked(),
      );
      await page.evaluate(() => (window.__qrFixture.failure = null));
      await editor
        .getByRole("button", { name: "ロゴを保存", exact: true })
        .click();
      src = await picture(page, tracking, square);
      assert.notEqual(src, square);
      const after = await page.evaluate(
        (name) => window.__qrFixture.rows.find((row) => row.title === name),
        title,
      );
      assert.deepEqual(withoutLogo(after), before);
      await writeFile(
        path.join(output, `${size.name}-portrait-store.png`),
        decode(src).bytes,
      );
      if ((await editor.locator("details").getAttribute("open")) !== null)
        await editor.locator("summary").click();
      await page.screenshot({
        path: path.join(output, `${size.name}-saved-store.png`),
        fullPage: true,
      });
      results.push({
        viewport: size.name,
        scenario: "portrait-store-expired-save-keeps-draft-and-previous-png",
        passed: true,
      });
      await choose(editor.locator(".qr-logo-picker"), "");
      await editor
        .getByRole("button", { name: "ロゴを保存", exact: true })
        .click();
      await picture(page, tracking, src);
      assert.equal(
        (
          await page.evaluate(
            (name) => window.__qrFixture.rows.find((row) => row.title === name),
            title,
          )
        ).logo_id,
        null,
      );
      results.push({
        viewport: size.name,
        scenario: "store-removal-keeps-code-routing-counts-history",
        passed: true,
      });
      await page.goto(url);
      await page.locator(".qr-link-row").first().waitFor();
      const file = page.locator(".qr-file-upload");
      await choose(file.locator(".qr-logo-picker"), "store-marugo-shinbashi");
      await file
        .locator('input[type="file"]')
        .setInputFiles(
          new URL("../public/qr-logos/store-blu-nero.png", import.meta.url)
            .pathname,
        );
      await file.locator('input[type="checkbox"]').check();
      await file.locator("button.primary").click();
      await page.locator(".qr-detail-heading h2").waitFor();
      const upload = await page.evaluate(
        () =>
          window.__qrFixture.calls.find(
            (call) => call.path === "/uploads" && call.method === "POST",
          ).body,
      );
      assert.equal(upload.logoId, "store-marugo-shinbashi");
      await picture(
        page,
        "https://marugo-s.github.io/multiapp/?s=q#MnOp1234QrSt",
      );
      results.push({
        viewport: size.name,
        scenario: "file-publication-preserves-store-selection-and-consent",
        passed: true,
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } catch (error) {
      await page.screenshot({
        path: path.join(output, `failure-${size.name}.png`),
        fullPage: true,
      });
      await writeFile(
        path.join(output, `failure-${size.name}.json`),
        JSON.stringify(
          {
            message: String(error),
            errors,
            blocked,
            body: await page.locator("body").innerText(),
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const report = {
  caseCount: results.length,
  allPassed: true,
  storeCount: stores.length,
  results,
  productionWrites: 0,
  limits:
    "Actual local components and assets with intercepted synthetic API only; not real user persistence or camera/print testing.",
};
await writeFile(
  path.join(output, "store-browser-results.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    caseCount: results.length,
    allPassed: true,
    storeCount: stores.length,
    output,
  }),
);
