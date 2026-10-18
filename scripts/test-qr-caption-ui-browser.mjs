// Real React controls and downloadable PNGs with synthetic local API only.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";
const output =
  process.env.QR_LOGO_EVIDENCE || path.join(tmpdir(), "qr-caption-ui");
await mkdir(output, { recursive: true });
const url =
  process.env.QR_LOGO_PREVIEW || "http://127.0.0.1:5197/__qr_logo_preview";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
async function choose(picker, id) {
  if ((await picker.locator("details").getAttribute("open")) === null)
    await picker.locator("summary").click();
  await picker.locator(`input[type=radio][value="${id}"]`).check();
}
async function picture(page, previous) {
  await page.waitForFunction((before) => {
    const image = document.querySelector(".qr-preview img");
    return image?.src.startsWith("data:image/png") && image.src !== before;
  }, previous || "");
  const source = await page.locator(".qr-preview img").getAttribute("src");
  assert.equal(
    await page.locator(".qr-preview a").getAttribute("href"),
    source,
  );
  const png = PNG.sync.read(Buffer.from(source.split(",")[1], "base64"));
  const code = await page.locator(".qr-preview a").getAttribute("download");
  assert.equal(
    jsQR(new Uint8ClampedArray(png.data), png.width, png.height, {
      inversionAttempts: "dontInvert",
    })?.data,
    `https://marugo-s.github.io/multiapp/?s=q#${code.replace("marugo-qr-", "").replace(".png", "")}`,
  );
  return source;
}
async function geometry(page) {
  const bounds = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    bad: [...document.querySelectorAll("input,button,summary")]
      .filter((e) => e.getClientRects().length && !e.closest("[hidden]"))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.left < -1 || r.right > innerWidth + 1)
      .map((r) => ({ left: r.left, right: r.right })),
    image: (() => {
      const i = document.querySelector(".qr-preview img");
      return {
        width: i.clientWidth,
        height: i.clientHeight,
        naturalWidth: i.naturalWidth,
        naturalHeight: i.naturalHeight,
      };
    })(),
  }));
  assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
  assert.deepEqual(bounds.bad, []);
  assert.ok(
    Math.abs(
      bounds.image.height / bounds.image.width -
        bounds.image.naturalHeight / bounds.image.naturalWidth,
    ) < 0.01,
    "caption PNG must retain its natural non-square aspect ratio",
  );
}
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
      acceptDownloads: true,
    });
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
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    try {
      await page.goto(url);
      await page.locator(".qr-link-row").first().waitFor();
      await page.locator("#qr-create-link-tab").click();
      const form = page.locator(".qr-create-card"),
        picker = form.locator(".qr-logo-picker");
      const field = form.locator(".qr-store-name-field input");
      await form.locator("input").first().fill("店舗名・架空検証");
      await form
        .locator("input[type=url]")
        .fill("https://example.invalid/caption");
      await choose(picker, "store-marugo-2");
      assert.equal(
        await field.inputValue(),
        QR_LOGOS.find((l) => l.id === "store-marugo-2").label,
      );
      await field.fill("  丸五 新宿店 MARUGO  ");
      await choose(picker, "store-marugo-2");
      assert.equal(await field.inputValue(), "  丸五 新宿店 MARUGO  ");
      await page.evaluate(() => (window.__qrFixture.failure = "unknown-once"));
      await form.locator("button.primary").click();
      await page.getByRole("alert").filter({ hasText: "通信結果" }).waitFor();
      assert.equal(await field.inputValue(), "  丸五 新宿店 MARUGO  ");
      const first = await page.evaluate(
        () =>
          window.__qrFixture.calls.find(
            (c) => c.path === "/links" && c.method === "POST",
          ).body,
      );
      assert.equal(first.storeName, "丸五 新宿店 MARUGO");
      await form.locator("button.primary").click();
      await page.locator(".qr-detail-heading h2").waitFor();
      const writes = await page.evaluate(() =>
        window.__qrFixture.calls
          .filter((c) => c.path === "/links" && c.method === "POST")
          .map((c) => c.body),
      );
      assert.deepEqual(writes[1], first);
      let saved = await picture(page);
      await geometry(page);
      const editor = page.locator(".qr-logo-editor"),
        name = editor.locator(".qr-store-name-field input"),
        save = editor.getByRole("button", { name: "ロゴを保存", exact: true });
      assert.equal(await name.inputValue(), "丸五 新宿店 MARUGO");
      await name.fill("編集中の店舗名");
      await page.locator(".page-heading button").click();
      await page.setViewportSize({ width: size.height, height: size.width });
      assert.equal(await name.inputValue(), "編集中の店舗名");
      await page.setViewportSize({ width: size.width, height: size.height });
      assert.equal(await name.inputValue(), "編集中の店舗名");
      assert.equal(
        await page.locator(".qr-preview a").getAttribute("href"),
        saved,
      );
      for (const failure of ["expired", "caption-mismatch"]) {
        await page.evaluate(
          (value) => (window.__qrFixture.failure = value),
          failure,
        );
        await save.click();
        await editor.getByRole("alert").waitFor();
        assert.equal(await name.inputValue(), "編集中の店舗名");
        assert.equal(
          await page.locator(".qr-preview a").getAttribute("href"),
          saved,
        );
      }
      await page.evaluate(() => {
        window.__qrFixture.failure = null;
        window.__qrFixture.holdNextList = true;
      });
      await page.locator(".page-heading button").click();
      await page.waitForFunction(
        () => window.__qrFixture.pendingLists.length === 1,
      );
      await save.click();
      saved = await picture(page, saved);
      await page.evaluate(() => window.__qrFixture.pendingLists.shift()());
      assert.equal(await name.inputValue(), "編集中の店舗名");
      const finalName = "MARUGO 新宿店";
      await name.fill(finalName);
      await save.click();
      saved = await picture(page, saved);
      await page
        .getByRole("button", { name: "QR詳細を閉じる", exact: true })
        .click();
      await page
        .locator(".qr-link-row")
        .filter({ hasText: "店舗名・架空検証" })
        .click();
      assert.equal(await name.inputValue(), finalName);
      assert.equal(await picture(page), saved);
      await geometry(page);
      await page
        .locator(".qr-detail-card")
        .screenshot({
          path: path.join(output, `${size.name}-caption-detail.png`),
        });
      const downloadEvent = page.waitForEvent("download");
      await page.locator(".qr-preview a").click();
      const download = await downloadEvent;
      await download.saveAs(path.join(output, `${size.name}-download.png`));
      await writeFile(
        path.join(output, `${size.name}-saved.png`),
        Buffer.from(saved.split(",")[1], "base64"),
      );
      await name.fill("");
      await save.click();
      saved = await picture(page, saved);
      assert.equal(
        PNG.sync.read(Buffer.from(saved.split(",")[1], "base64")).height,
        640,
      );
      await name.fill("再表示");
      await save.click();
      saved = await picture(page, saved);
      await choose(editor.locator(".qr-logo-picker"), "store-mitan");
      assert.equal(
        await name.inputValue(),
        QR_LOGOS.find((l) => l.id === "store-mitan").label,
      );
      await choose(editor.locator(".qr-logo-picker"), "instagram-gradient");
      assert.equal(
        await editor.locator(".qr-store-name-field input").count(),
        0,
      );
      await save.click();
      saved = await picture(page, saved);
      assert.equal(
        PNG.sync.read(Buffer.from(saved.split(",")[1], "base64")).height,
        640,
      );
      const patch = await page.evaluate(
        () =>
          window.__qrFixture.calls.filter((c) => c.method === "PATCH").at(-1)
            .body,
      );
      assert.equal(patch.storeName, null);
      assert.equal(
        await editor
          .getByRole("group", { name: "SNSロゴ", exact: true })
          .getByRole("radio")
          .count(),
        15,
      );
      results.push({
        viewport: size.name,
        scenario:
          "URL retry + saved-only PNG + polling/rotation + expiry/mismatch + stale list + repeat edits/hide/SNS",
        passed: true,
      });
      await page.goto(url);
      await page.locator(".qr-link-row").first().waitFor();
      const file = page.locator(".qr-file-upload");
      await choose(file.locator(".qr-logo-picker"), "store-marugo-2");
      await file.locator(".qr-store-name-field input").fill("ファイル店 FILE");
      await file
        .locator("input[type=file]")
        .setInputFiles(
          new URL("../public/qr-logos/store-blu-nero.png", import.meta.url)
            .pathname,
        );
      await file.locator("input[type=checkbox]").check();
      await page.evaluate(() => (window.__qrFixture.failure = "unknown-once"));
      await file.locator("button.primary").click();
      await file.getByRole("alert").waitFor();
      assert.equal(
        await file.locator(".qr-store-name-field input").inputValue(),
        "ファイル店 FILE",
      );
      assert.ok(await file.locator(".qr-store-name-field input").isDisabled());
      await page.setViewportSize({ width: size.height, height: size.width });
      await page.setViewportSize({ width: size.width, height: size.height });
      await file.locator("button.primary").click();
      await page.locator(".qr-detail-heading h2").waitFor();
      const uploads = await page.evaluate(() =>
        window.__qrFixture.calls
          .filter((c) => c.path === "/uploads")
          .map((c) => c.body),
      );
      assert.deepEqual(uploads[1], uploads[0]);
      assert.equal(uploads[0].storeName, "ファイル店 FILE");
      await picture(page);
      await geometry(page);
      await page.evaluate(() => {
        const encode = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (...args) {
          if (this.height > 640) {
            const c = this.getContext("2d");
            c.fillStyle = "#f00";
            c.fillRect(0, 0, 1, 1);
          }
          return encode.apply(this, args);
        };
        window.__qrFixture.rows[0].store_name = "PNG破損の検証";
      });
      await page.locator(".page-heading button").click();
      await page.locator(".qr-preview [role=alert]").waitFor();
      assert.equal(
        await page.locator(".qr-preview a").getAttribute("aria-disabled"),
        "true",
      );
      assert.equal(
        await page.locator(".qr-preview a").getAttribute("href"),
        null,
      );
      results.push({
        viewport: size.name,
        scenario:
          "File first-caption snapshot + unknown-result same-ID retry + locked field + PNG + corrupted-export rejection",
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
        JSON.stringify({ error: String(error), errors, blocked }, null, 2),
      );
      throw error;
    } finally {
      await context.close();
    }
    await writeFile(
      path.join(output, "caption-ui-results.json"),
      JSON.stringify(
        { count: results.length, results, productionWrites: 0 },
        null,
        2,
      ),
    );
  }
  assert.equal(results.length, 8);
  console.log(
    JSON.stringify({ count: results.length, allPassed: true, output }),
  );
} finally {
  await browser.close();
}
