import { createServer } from "vite";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const fixture = `import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';createRoot(document.getElementById('root')).render(React.createElement(App,{onChooseApp:()=>{}}));`;
const server = await createServer({
  plugins: [
    {
      name: "app-fixture",
      resolveId(id) {
        if (id === "virtual:offline-app") return "\0virtual:offline-app";
      },
      load(id) {
        if (id === "\0virtual:offline-app") return fixture;
      },
      configureServer(s) {
        s.middlewares.use("/app-fixture", async (_q, r) => {
          r.setHeader("Content-Type", "text/html;charset=utf-8");
          r.end(
            await s.transformIndexHtml(
              "/app-fixture",
              '<!doctype html><meta charset="utf-8"><h1>SYNTHETIC local App — no real API/AI</h1><div id="root"></div><script type="module" src="/@id/__x00__virtual:offline-app"></script>',
            ),
          );
        });
      },
    },
  ],
  server: { hmr: false, host: "127.0.0.1", port: 5199, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  page.setDefaultTimeout(8000);
  let creates = 0,
    uploads = 0,
    contextReads = 0;
  await context.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.hostname !== "127.0.0.1") return r.abort();
    if (u.pathname === "/api/uploads/context") {
      contextReads++;
      return r.fulfill({
        json: {
          ownerId: "owner",
          actorId: "actor",
          capabilities: { resumableUpload: 1 },
        },
      });
    }
    if (u.pathname === "/api/settings")
      return r.fulfill({
        json: {
          configured: true,
          transcriptionModel: "gpt-transcribe",
          model: "gpt-6-astra",
        },
      });
    if (u.pathname === "/api/meetings") {
      if (r.request().method() === "POST") creates++;
      return r.fulfill({ json: [] });
    }
    if (u.pathname === "/api/uploads") {
      uploads++;
      return r.fulfill({
        status: 503,
        json: { error: "SYNTHETIC unavailable" },
      });
    }
    return r.continue();
  });
  await page.goto("http://127.0.0.1:5199/app-fixture");
  await page.waitForTimeout(150);
  assert.ok(
    contextReads > 0,
    "App must cache verified owner/actor while online before opening the recording form",
  );
  await page.evaluate(async () => {
    const s = await import("/src/offline-store.ts");
    await s.saveDraft({
      id: "app-draft",
      scope: { ownerId: "owner", actorId: "actor" },
      mode: "text",
      metadata: {
        title: "SYNTHETIC APP RESTORE",
        date: "2026-10-28",
        participants: "fixture",
        template: "standard",
      },
      transcript: "SYNTHETIC text",
      files: [],
      attachments: [],
      sessionIds: [],
      updatedAt: 1,
    });
  });
  await page
    .getByRole("heading", { name: "端末内の下書き・送信待ち" })
    .waitFor();
  await page.getByRole("button", { name: "編集を再開" }).click();
  await page.getByLabel("会議名", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(
        'input[placeholder="例：新サービスのリリース定例"]',
      )?.value === "SYNTHETIC APP RESTORE",
  );
  assert.equal(
    await page.getByLabel("会議名", { exact: true }).inputValue(),
    "SYNTHETIC APP RESTORE",
  );
  await page.locator("dialog .modal-footer button").last().click();
  await page
    .getByRole("button", { name: "手動再送", exact: true })
    .last()
    .waitFor();
  assert.equal(
    creates,
    0,
    "text-only App submissions must use durable uploads, not non-idempotent meetings POST",
  );
  assert.ok(uploads > 0);
  const retained = await page.evaluate(async () => {
    const s = await import("/src/offline-store.ts");
    return (await s.getDraft("app-draft"))?.attempt?.input.transcript;
  });
  assert.equal(retained, "SYNTHETIC text");
  console.log(
    "PASS actual App mounts outbox, reopens exact draft, text-only uses frozen resumable route, 503 retains text",
  );
} finally {
  await browser.close();
  await server.close();
}
