import { createServer } from "vite";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const fixture = `import React from'react';import{createRoot}from'react-dom/client';import{OfflineQueue}from'/src/OfflineQueue.tsx';createRoot(document.getElementById('root')).render(React.createElement(OfflineQueue,{onOpen:()=>{},onAccepted:()=>{window.fixtureAccepted=(window.fixtureAccepted||0)+1;}}));`;
const server = await createServer({
  plugins: [
    {
      name: "queue-fixture",
      resolveId(id) {
        if (id === "virtual:queue") return "\0virtual:queue";
      },
      load(id) {
        if (id === "\0virtual:queue") return fixture;
      },
      configureServer(s) {
        s.middlewares.use("/queue-fixture", async (_q, r) => {
          r.setHeader("Content-Type", "text/html;charset=utf-8");
          r.end(
            await s.transformIndexHtml(
              "/queue-fixture",
              '<!doctype html><meta charset="utf-8"><h1>SYNTHETIC outbox fixture</h1><div id="root"></div><script type="module" src="/@id/__x00__virtual:queue"></script>',
            ),
          );
        });
      },
    },
  ],
  server: { hmr: false, host: "127.0.0.1", port: 5198, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  page.setDefaultTimeout(8000);
  await context.route("**/*", (r) =>
    new URL(r.request().url()).hostname === "127.0.0.1"
      ? r.continue()
      : r.abort(),
  );
  await page.goto("http://127.0.0.1:5198/queue-fixture");
  await page.evaluate(async () => {
    window.fixturePosts = 0;
    window.fixtureFailure = 503;
    const s = await import("/src/offline-store.ts"),
      d = await import("/supabase/functions/_shared/upload.mjs");
    const input = {
      uploadId: crypto.randomUUID(),
      metadata: {
        title: "SYNTHETIC QUEUED",
        date: "2026-10-28",
        participants: "",
        template: "standard",
      },
      sources: [],
      parts: [],
      attachments: [],
      transcript: "SYNTHETIC conversation",
    };
    const identity = {
      uploadId: input.uploadId,
      ownerId: "owner",
      planDigest: await d.uploadDigest(input),
    };
    window.fixtureIdentity = identity;
    await s.saveDraft({
      id: "queue",
      scope: { ownerId: "owner", actorId: "actor" },
      mode: "text",
      metadata: input.metadata,
      files: [],
      attachments: [],
      sessionIds: [],
      transcript: input.transcript,
      updatedAt: 1,
    });
    await s.freezeDraft(
      "queue",
      {
        input,
        identity,
        parts: [],
        attachments: [],
      },
      (await s.getDraft("queue")).revision || 0,
    );
    window.fetch = async (url) => {
      const path = new URL(url, location.href).pathname;
      const ok = (v) =>
        new Response(JSON.stringify(v), {
          headers: { "Content-Type": "application/json" },
        });
      if (path.endsWith("/context"))
        return ok({
          ownerId: "owner",
          actorId: "actor",
          capabilities: { resumableUpload: 1 },
        });
      if (path === "/api/uploads") {
        window.fixturePosts++;
        if (window.fixtureFailure)
          return new Response(JSON.stringify({ error: "SYNTHETIC 503" }), {
            status: window.fixtureFailure,
          });
        return ok({
          id: identity.uploadId,
          status: "analyzing",
          recordings: [],
          attachments: [],
          uploadIdentity: identity,
          uploadReceipt: {
            ...identity,
            meetingId: identity.uploadId,
            status: "accepted",
          },
        });
      }
      throw Error("FORBIDDEN " + path);
    };
  });
  await page
    .getByRole("heading", { name: "端末内の下書き・送信待ち" })
    .waitFor();
  await page.waitForFunction(() => window.fixturePosts === 1);
  await page.waitForTimeout(500);
  assert.equal(
    await page.evaluate(() => window.fixturePosts),
    1,
    "503 must back off while online",
  );
  await page.evaluate(() => {
    window.fixtureFailure = 0;
    window.dispatchEvent(new Event("online"));
  });
  await page.waitForFunction(() => window.fixtureAccepted === 1, {
    timeout: 8000,
  });
  assert.equal(await page.evaluate(() => window.fixturePosts), 2);
  console.log(
    "PASS online=true HTTP503 backoff → online signal resumes same frozen outbox",
  );
  // Restore another pending attempt and prove authentication is blocked, not auto-looped.
  await page.evaluate(async () => {
    const s = await import("/src/offline-store.ts");
    const input = { uploadId: crypto.randomUUID() };
    await s.saveDraft({
      id: "blocked",
      scope: { ownerId: "owner", actorId: "actor" },
      mode: "text",
      metadata: {
        title: "SYNTHETIC AUTH",
        date: "2026-10-28",
        participants: "",
        template: "standard",
      },
      files: [],
      attachments: [],
      sessionIds: [],
      transcript: "SYNTHETIC",
      updatedAt: 1,
    });
    await s.freezeDraft(
      "blocked",
      {
        input,
        identity: window.fixtureIdentity,
        parts: [],
        attachments: [],
      },
      (await s.getDraft("blocked")).revision || 0,
    );
    window.fixtureFailure = 401;
  });
  let blocked = false;
  for (let i = 0; i < 40; i++) {
    blocked = await page.evaluate(async () => {
      const s = await import("/src/offline-store.ts");
      return (await s.getDraft("blocked"))?.status === "blocked";
    });
    if (blocked) break;
    await page.waitForTimeout(100);
  }
  assert.equal(blocked, true);
  const count = await page.evaluate(() => window.fixturePosts);
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => window.fixturePosts), count);
  await page.getByRole("button", { name: "手動再送" }).waitFor();
  console.log(
    "PASS authentication failure retains draft and does not auto-retry",
  );
} finally {
  await browser.close();
  await server.close();
}
