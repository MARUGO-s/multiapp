// Browser-level feature checks against the isolated real-component preview.
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
  process.env.QR_LOGO_EVIDENCE || path.join(tmpdir(), "qr-logo-ui-evidence");
await mkdir(path.join(output, "screenshots"), { recursive: true });
await mkdir(path.join(output, "browser-exports"), { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
function decode(dataUrl) {
  const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
  const image = PNG.sync.read(bytes);
  const code = jsQR(
    new Uint8ClampedArray(image.data),
    image.width,
    image.height,
    { inversionAttempts: "dontInvert" },
  );
  return { bytes, text: code?.data };
}
function withoutLogo(row) {
  const copy = { ...row };
  delete copy.logo_id;
  return copy;
}
async function safeContext(viewport) {
  const context = await browser.newContext({
    viewport,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    hasTouch: viewport.width < 1400,
  });
  await context.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    if (["127.0.0.1", "localhost"].includes(host)) return route.continue();
    if (host === "fonts.googleapis.com")
      return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.abort();
  });
  return context;
}
async function choose(picker, value) {
  if ((await picker.locator("details").getAttribute("open")) === null)
    await picker.locator("summary").click();
  await picker.locator(`input[type="radio"][value="${value || ""}"]`).check();
}
async function picture(page) {
  await page.locator(".qr-preview img").waitFor();
  const src = await page.locator(".qr-preview img").getAttribute("src");
  assert.equal(await page.locator(".qr-preview a").getAttribute("href"), src);
  return src;
}
async function geometry(page) {
  const bad = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    controls: Array.from(
      document.querySelectorAll("input,button,select,summary"),
    )
      .filter((e) => e.getClientRects().length && !e.closest("[hidden]"))
      .map((e) => ({
        label: e.getAttribute("aria-label") || e.textContent?.slice(0, 50),
        left: e.getBoundingClientRect().left,
        right: e.getBoundingClientRect().right,
      }))
      .filter((e) => e.left < -1 || e.right > innerWidth + 1),
  }));
  assert.ok(bad.scroll <= bad.width + 1, JSON.stringify(bad));
  assert.deepEqual(bad.controls, [], JSON.stringify(bad));
}
try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "phone", width: 390, height: 844 },
    { name: "tablet-portrait", width: 768, height: 1024 },
    { name: "tablet-landscape", width: 1024, height: 768 },
  ]) {
    const context = await safeContext({
      width: viewport.width,
      height: viewport.height,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(url);
    await page.locator(".qr-link-row").first().waitFor();
    await page.locator("#qr-create-link-tab").click();
    const create = page.locator(".qr-create-card");
    const picker = create.locator(".qr-logo-picker");
    await choose(picker, "instagram-gradient");
    assert.equal(await picker.getByRole("radio").count(), QR_LOGOS.length + 1);
    await geometry(page);
    await create.locator("input").first().fill("SNSロゴ入りQR（架空検証）");
    await create
      .locator('input[type="url"]')
      .fill("https://example.invalid/logo-feature");
    await create.screenshot({
      path: path.join(
        output,
        "screenshots",
        `after-${viewport.name}-gallery.png`,
      ),
    });
    await create.locator("button.primary").click();
    await page
      .locator(".qr-detail-heading h2")
      .filter({ hasText: "SNSロゴ入りQR" })
      .waitFor();
    let src = await picture(page);
    const created = await page.evaluate(() =>
      window.__qrFixture.rows.find((r) => r.title.startsWith("SNSロゴ入りQR")),
    );
    assert.equal(created.logo_id, "instagram-gradient");
    assert.equal(
      decode(src).text,
      `https://marugo-s.github.io/multiapp/?s=q#${created.code}`,
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.__qrFixture.calls.find(
            (c) => c.path === "/links" && c.method === "POST",
          ).body.logoId,
      ),
      "instagram-gradient",
    );
    results.push({
      viewport: viewport.name,
      scenario: "url-logo-create-and-verified-export",
      passed: true,
    });
    await page
      .getByRole("button")
      .filter({ hasText: "店頭ポスター（検証用）" })
      .click();
    const noLogo = await picture(page);
    const before = await page.evaluate(() =>
      structuredClone(
        window.__qrFixture.rows.find((r) => r.code === "AbCd1234EfGh"),
      ),
    );
    const editor = page.locator(".qr-logo-editor");
    await choose(editor.locator(".qr-logo-picker"), "instagram-gradient");
    assert.equal(
      await page.evaluate(
        () =>
          window.__qrFixture.rows.find((r) => r.code === "AbCd1234EfGh")
            .logo_id,
      ),
      null,
    );
    // Queue a real pre-save refresh, then release its stale list after the write.
    await page.evaluate(() => (window.__qrFixture.holdNextList = true));
    await page.locator(".page-heading button").click();
    await page.waitForFunction(
      () => window.__qrFixture.pendingLists.length === 1,
    );
    await editor
      .getByRole("button", { name: "ロゴを保存", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".qr-logo-editor summary")
          ?.textContent.includes("Instagram・グラデーション") &&
        document.querySelector(".qr-logo-editor button")?.disabled,
    );
    await page.evaluate(() => window.__qrFixture.pendingLists.shift()());
    src = await picture(page);
    assert.notEqual(src, noLogo);
    assert.equal(
      decode(src).text,
      "https://marugo-s.github.io/multiapp/?s=q#AbCd1234EfGh",
    );
    const after = await page.evaluate(() =>
      structuredClone(
        window.__qrFixture.rows.find((r) => r.code === "AbCd1234EfGh"),
      ),
    );
    assert.deepEqual(withoutLogo(after), withoutLogo(before));
    assert.match(await page.locator(".qr-count").innerText(), /37/);
    await geometry(page);
    await page
      .locator(".qr-preview")
      .screenshot({
        path: path.join(output, "screenshots", `after-${viewport.name}-qr.png`),
      });
    results.push({
      viewport: viewport.name,
      scenario: "shared-saved-logo-unchanged-url-count-and-stale-poll",
      passed: true,
    });
    await choose(editor.locator(".qr-logo-picker"), null);
    await page.evaluate(() => (window.__qrFixture.failure = "expired"));
    await editor
      .getByRole("button", { name: "ロゴを保存", exact: true })
      .click();
    await editor.getByRole("alert").filter({ hasText: "有効期限" }).waitFor();
    assert.equal(await editor.locator('input[value=""]').isChecked(), true);
    assert.equal(
      await page.locator(".qr-preview img").getAttribute("src"),
      src,
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.__qrFixture.rows.find((r) => r.code === "AbCd1234EfGh")
            .logo_id,
      ),
      "instagram-gradient",
    );
    await page.evaluate(() => (window.__qrFixture.failure = null));
    await editor
      .getByRole("button", { name: "ロゴを保存", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".qr-preview img")?.getAttribute("src") ===
        window.__expectedNoLogo,
      await page.evaluate((value) => (window.__expectedNoLogo = value), noLogo),
    );
    assert.equal(await picture(page), noLogo);
    results.push({
      viewport: viewport.name,
      scenario: "remove-logo-error-retains-image-and-manual-retry",
      passed: true,
    });
    await page.goto(url);
    await page.locator(".qr-link-row").first().waitFor();
    const fileForm = page.locator(".qr-file-upload");
    await choose(fileForm.locator(".qr-logo-picker"), "line-ios");
    await fileForm
      .locator('input[type="file"]')
      .setInputFiles(
        new URL("../public/qr-logos/instagram-black.png", import.meta.url)
          .pathname,
      );
    await fileForm.locator('input[type="checkbox"]').check();
    await fileForm.locator("button.primary").click();
    await page.locator(".qr-detail-heading h2").waitFor();
    const upload = await page.evaluate(() =>
      window.__qrFixture.calls.find(
        (c) => c.path === "/uploads" && c.method === "POST",
      ),
    );
    assert.equal(upload.body.logoId, "line-ios");
    src = await picture(page);
    assert.equal(
      decode(src).text,
      "https://marugo-s.github.io/multiapp/?s=q#MnOp1234QrSt",
    );
    results.push({
      viewport: viewport.name,
      scenario: "file-creation-persists-selected-logo",
      passed: true,
    });
    if (viewport.name === "desktop") {
      const artifacts = await page.evaluate(async () => {
        const { qrImageDataUrl } = await import("/src/qr-image.mjs");
        const { QR_LOGOS } =
          await import("/supabase/functions/_shared/qr-logos.mjs");
        const out = [];
        for (const logo of QR_LOGOS)
          out.push({
            id: logo.id,
            png: await qrImageDataUrl(
              "https://marugo-s.github.io/multiapp/?s=q#AbCd1234EfGh",
              logo.id,
              "/",
            ),
          });
        return out;
      });
      assert.equal(artifacts.length, 38);
      for (const artifact of artifacts) {
        const image = decode(artifact.png);
        assert.equal(
          image.text,
          "https://marugo-s.github.io/multiapp/?s=q#AbCd1234EfGh",
        );
        await writeFile(
          path.join(output, "browser-exports", `${artifact.id}.png`),
          image.bytes,
        );
      }
      results.push({
        viewport: viewport.name,
        scenario: "all38-real-browser-assets-decode-to-original-url",
        passed: true,
        images: artifacts.length,
      });
    }
    assert.deepEqual(errors, [], JSON.stringify(errors));
    await context.close();
  }
  // Missing catalog raster must show a visible error and disable saving, no fallback.
  const context = await safeContext({ width: 390, height: 844 });
  await context.route("**/qr-logos/line-android.png", (route) =>
    route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "missing test fixture",
    }),
  );
  const page = await context.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(e.message));
  await page.goto(url);
  await page.locator(".qr-link-row").first().waitFor();
  await page.evaluate(
    () => (window.__qrFixture.rows[0].logo_id = "line-android"),
  );
  await page.locator(".page-heading button").click();
  await page.waitForFunction(
    () =>
      window.__qrFixture.calls.filter((c) => c.path.startsWith("/links?"))
        .length >= 2,
  );
  await page.locator(".qr-link-row").first().click();
  await page.locator('.qr-preview [role="alert"]').waitFor();
  assert.equal(await page.locator(".qr-preview img").count(), 0);
  assert.equal(
    await page.locator(".qr-preview a").getAttribute("aria-disabled"),
    "true",
  );
  assert.equal(await page.locator(".qr-preview a").getAttribute("href"), null);
  assert.match(
    await page.locator('.qr-preview [role="alert"]').innerText(),
    /ロゴ画像を読み込めません/,
  );
  assert.deepEqual(jsErrors, []);
  results.push({
    viewport: "phone",
    scenario: "missing-logo-visible-error-and-no-png-or-fallback",
    passed: true,
  });
  await context.close();
  const report = {
    caseCount: results.length,
    allPassed: true,
    results,
    productionWrites: 0,
    limits:
      "Real local components/PNG assets with a synthetic API boundary. This does not prove real production authentication or physical camera/print readability.",
  };
  await writeFile(
    path.join(output, "feature-results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({ caseCount: results.length, allPassed: true, output }),
  );
} finally {
  await browser.close();
}
