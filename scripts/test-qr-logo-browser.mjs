// Run with the synthetic-only preview servers; no real API can be reached.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const mode = process.argv.includes("--baseline-only") ? "before" : "after";
const url =
  process.env.QR_LOGO_PREVIEW ||
  `http://127.0.0.1:${mode === "before" ? 5198 : 5197}/__qr_logo_preview`;
const output =
  process.env.QR_LOGO_EVIDENCE || path.join(tmpdir(), "qr-logo-ui-evidence");
await mkdir(path.join(output, "screenshots"), { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const payloads = [];
const widths = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "phone", width: 390, height: 844 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "tablet-landscape", width: 1024, height: 768 },
];
const title = "ロゴ機能・入力経路の比較検証";
const targetUrl = "https://example.invalid/menu?source=offline";
try {
  for (const size of widths) {
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
      // Pin identical offline fallback fonts in baseline/candidate; never call Google.
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
    async function boot() {
      await page.goto(url);
      await page.locator(".qr-link-row").first().waitFor();
      await page.evaluate(() => {
        window.__mainNavigations = 0;
      });
    }
    async function setLinkForm() {
      await page.locator("#qr-create-link-tab").click();
      const form = page.locator(".qr-create-card");
      return {
        form,
        name: form.locator("input").nth(0),
        url: form.locator('input[type="url"]'),
        submit: form
          .locator('button[type="submit"],button:not([type])')
          .first(),
      };
    }
    async function geometry() {
      const overflow = await page.evaluate(() => ({
        viewport: innerWidth,
        width: document.documentElement.scrollWidth,
        controls: Array.from(
          document.querySelectorAll("input,select,button,summary"),
        )
          .filter((e) => e.getClientRects().length && !e.closest("[hidden]"))
          .map((e) => ({
            text: e.getAttribute("aria-label") || e.textContent?.slice(0, 70),
            left: e.getBoundingClientRect().left,
            right: e.getBoundingClientRect().right,
          }))
          .filter((e) => e.left < -1 || e.right > innerWidth + 1),
      }));
      assert.ok(
        overflow.width <= overflow.viewport + 1,
        JSON.stringify(overflow),
      );
      assert.deepEqual(overflow.controls, [], JSON.stringify(overflow));
      return overflow;
    }
    await boot();
    await geometry();
    await page.screenshot({
      path: path.join(output, "screenshots", `${mode}-${size.name}.png`),
    });
    let fields = await setLinkForm();
    await fields.submit.click();
    assert.equal(
      await page.evaluate(
        () => window.__qrFixture.calls.filter((c) => c.method !== "GET").length,
      ),
      0,
    );
    results.push({
      viewport: size.name,
      scenario: "empty-validation",
      passed: true,
    });
    await fields.name.fill(title);
    await fields.url.fill("not-a-url");
    await fields.submit.click();
    assert.equal(
      await page.evaluate(
        () => window.__qrFixture.calls.filter((c) => c.method !== "GET").length,
      ),
      0,
    );
    results.push({
      viewport: size.name,
      scenario: "invalid-url",
      passed: true,
    });
    await fields.url.fill(targetUrl);
    await page.evaluate(() => (window.__qrFixture.failure = "expired"));
    let navigations = 0;
    const navigation = (frame) => {
      if (frame === page.mainFrame()) navigations++;
    };
    page.on("framenavigated", navigation);
    await fields.submit.click();
    await page.getByRole("alert").filter({ hasText: "有効期限" }).waitFor();
    assert.equal(await fields.name.inputValue(), title);
    assert.equal(await fields.url.inputValue(), targetUrl);
    assert.equal(navigations, 0);
    const expiredBody = await page.evaluate(
      () => window.__qrFixture.calls.find((c) => c.method === "POST").body,
    );
    await page.evaluate(() => (window.__qrFixture.failure = null));
    await fields.submit.click();
    await page
      .locator(".qr-detail-heading h2")
      .filter({ hasText: title })
      .waitFor();
    const posts = await page.evaluate(() =>
      window.__qrFixture.calls.filter((c) => c.method === "POST"),
    );
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.id, posts[1].body.id);
    assert.equal(posts[1].body.targetUrl, targetUrl);
    const business = { ...posts[1].body };
    delete business.id;
    delete business.logoId;
    assert.deepEqual(business, { title, targetUrl });
    payloads.push({ viewport: size.name, operation: "url-create", business });
    results.push({
      viewport: size.name,
      scenario: "expired-session-retains-input-and-id",
      passed: true,
      body: expiredBody,
    });
    assert.equal(
      await page.locator(".qr-preview a").getAttribute("href"),
      await page.locator(".qr-preview img").getAttribute("src"),
    );
    results.push({
      viewport: size.name,
      scenario: "same-png-preview-and-download",
      passed: true,
    });
    page.off("framenavigated", navigation);
    await boot();
    fields = await setLinkForm();
    await fields.name.fill(title);
    await fields.url.fill(targetUrl);
    await page.evaluate(() => (window.__qrFixture.failure = "unknown-once"));
    await fields.submit.click();
    await page.getByRole("alert").filter({ hasText: "通信結果" }).waitFor();
    assert.equal(await fields.name.inputValue(), title);
    assert.equal(await fields.url.inputValue(), targetUrl);
    const before = await page.evaluate(
      () => window.__qrFixture.calls.filter((c) => c.method === "POST").length,
    );
    await page.waitForTimeout(200);
    assert.equal(
      await page.evaluate(
        () =>
          window.__qrFixture.calls.filter((c) => c.method === "POST").length,
      ),
      before,
    );
    await fields.submit.click();
    await page
      .locator(".qr-detail-heading h2")
      .filter({ hasText: title })
      .waitFor();
    const retries = await page.evaluate(() =>
      window.__qrFixture.calls.filter((c) => c.method === "POST"),
    );
    assert.equal(retries.length, 2);
    assert.equal(retries[0].body.id, retries[1].body.id);
    assert.equal(await page.evaluate(() => window.__qrFixture.rows.length), 2);
    results.push({
      viewport: size.name,
      scenario: "unknown-outcome-manual-same-id-retry",
      passed: true,
    });
    await boot();
    fields = await setLinkForm();
    await fields.name.fill(title);
    await fields.url.fill(targetUrl);
    await fields.name.evaluate((node) => {
      window.__originalNameInput = node;
    });
    await page.locator("#qr-create-file-tab").click();
    await page.locator("#qr-create-link-tab").click();
    await page.setViewportSize({ width: size.height, height: size.width });
    await geometry();
    assert.equal(await fields.name.inputValue(), title);
    assert.equal(await fields.url.inputValue(), targetUrl);
    assert.equal(
      await fields.name.evaluate((node) => node === window.__originalNameInput),
      true,
    );
    await page.setViewportSize({ width: size.width, height: size.height });
    results.push({
      viewport: size.name,
      scenario: "tab-switch-and-rotation-retain-input-nodes",
      passed: true,
    });
    await boot();
    const fileForm = page.locator(".qr-file-upload");
    await fileForm
      .locator('input[type="file"]')
      .setInputFiles(
        new URL("../public/qr-logos/instagram-black.png", import.meta.url)
          .pathname,
      );
    await fileForm.locator(".qr-file-fields input").first().fill(title);
    await fileForm.locator('input[type="checkbox"]').check();
    await page.evaluate(() => (window.__qrFixture.failure = "expired"));
    await fileForm.locator("button.primary").click();
    await fileForm.getByRole("alert").filter({ hasText: "有効期限" }).waitFor();
    assert.equal(
      await fileForm.locator(".qr-file-fields input").first().inputValue(),
      title,
    );
    assert.equal(
      await fileForm.locator('input[type="checkbox"]').isChecked(),
      true,
    );
    await page.evaluate(() => (window.__qrFixture.failure = null));
    await fileForm.locator("button.primary").click();
    await page
      .locator(".qr-detail-heading h2")
      .filter({ hasText: title })
      .waitFor();
    const fileCalls = await page.evaluate(() =>
      window.__qrFixture.calls.filter(
        (c) => c.path === "/uploads" && c.method === "POST",
      ),
    );
    assert.equal(fileCalls.length, 2);
    assert.equal(fileCalls[0].body.id, fileCalls[1].body.id);
    const fileBusiness = { ...fileCalls[1].body };
    delete fileBusiness.id;
    delete fileBusiness.logoId;
    assert.equal(fileBusiness.fileName, "instagram-black.png");
    assert.equal(fileBusiness.publishConfirmed, true);
    payloads.push({
      viewport: size.name,
      operation: "file-create",
      business: fileBusiness,
    });
    results.push({
      viewport: size.name,
      scenario: "file-consent-input-and-attempt-survive-expiry",
      passed: true,
    });
    await geometry();
    assert.deepEqual(errors, [], `${mode} ${size.name} browser errors`);
    assert.deepEqual(
      blocked,
      [],
      `${mode} ${size.name} attempted external network`,
    );
    results.push({
      viewport: size.name,
      scenario: "responsive-controls-and-no-errors",
      passed: true,
    });
    await context.close();
  }
  if (mode === "after") {
    const baseline = JSON.parse(
      await readFile(path.join(output, "before-results.json"), "utf8"),
    );
    assert.deepEqual(
      payloads,
      baseline.payloads,
      "New logo UI must preserve all non-logo business fields at every viewport",
    );
  }
  const report = {
    mode,
    url,
    results,
    payloads,
    completedCases: results.length,
    allPassed: true,
    productionWrites: 0,
    limitations: [
      "Synthetic API boundary; not production authentication or persistence",
      "Desktop Chrome and simulated touch viewports, not physical phones",
    ],
  };
  await writeFile(
    path.join(output, `${mode}-results.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      { mode, completedCases: results.length, allPassed: true, output },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
