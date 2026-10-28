// FR-SEC-01: independent unsafe repro converted to safety assertions.
import { createServer } from "vite";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{OfflineQueue}from'/src/OfflineQueue.tsx';window.mountQueue=()=>{window.root=createRoot(document.getElementById('root'));window.root.render(React.createElement(OfflineQueue,{onOpen:()=>window.opened=true,onAccepted:m=>window.accepted=m}));};`;
const server = await createServer({
  define: { "import.meta.env.VITE_STORAGE_MODE": JSON.stringify("supabase") },
  plugins: [
    {
      name: "scope-safety",
      resolveId(id) {
        if (id === "virtual:scope") return "\0virtual:scope";
      },
      load(id) {
        if (id === "\0virtual:scope") return source;
      },
      configureServer(s) {
        s.middlewares.use("/scope-fixture", async (_q, r) => {
          r.setHeader("Content-Type", "text/html;charset=utf-8");
          r.end(
            await s.transformIndexHtml(
              "/scope-fixture",
              '<!doctype html><div id="root"></div><script type="module" src="/@id/__x00__virtual:scope"></script>',
            ),
          );
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 5278, strictPort: true, hmr: false },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext();
  await context.route("**/*", (r) =>
    new URL(r.request().url()).hostname === "127.0.0.1"
      ? r.continue()
      : r.abort(),
  );
  const p = await context.newPage();
  await p.goto("http://127.0.0.1:5278/scope-fixture");
  await p.waitForFunction(() => window.mountQueue);
  await p.evaluate(async () => {
    const s = await import("/src/offline-store.ts"),
      c = await import("/src/cloud.ts");
    window.session = (ch) => ({
      token: "ktn_" + ch.repeat(64),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    c.saveSession(window.session("b"));
    const draft = {
      id: "private-A",
      scope: { ownerId: "owner-A", actorId: "actor-A" },
      mode: "file",
      metadata: {
        title: "PRIVATE ACCOUNT A",
        date: "2026-10-28",
        participants: "PRIVATE",
        template: "standard",
      },
      transcript: "",
      files: [new File(["PRIVATE AUDIO"], "a.wav")],
      attachments: [],
      sessionIds: [],
      updatedAt: 1,
    };
    await s.saveDraft(draft);
    window.identity = {
      uploadId: crypto.randomUUID(),
      ownerId: "owner-A",
      planDigest: "a".repeat(64),
    };
    await s.saveDraft({ ...draft, id: "cleanup-A" });
    await s.freezeDraft(
      "cleanup-A",
      { input: {}, identity: window.identity, parts: [], attachments: [] },
      (await s.getDraft("cleanup-A")).revision || 0,
    );
    await s.updateSubmission("cleanup-A", {
      receipt: {
        ...window.identity,
        meetingId: window.identity.uploadId,
        status: "accepted",
      },
      acceptedMeeting: {
        id: window.identity.uploadId,
        title: "PRIVATE MEETING A",
      },
      status: "cleanup",
    });
    window.fetch = async () => {
      throw new TypeError("SYNTHETIC offline");
    };
    window.mountQueue();
  });
  await p.waitForTimeout(350);
  assert.equal(
    await p.getByText("PRIVATE ACCOUNT A", { exact: true }).count(),
    0,
    "foreign draft title must not render even while scope unavailable",
  );
  assert.equal(
    await p.getByRole("button", { name: "原音をダウンロード" }).count(),
    0,
    "foreign original download must not exist",
  );
  assert.equal(
    await p.getByRole("button", { name: "破棄", exact: true }).count(),
    0,
    "foreign discard must not exist",
  );
  assert.equal(
    await p.evaluate(() => !!window.accepted),
    false,
    "cleanup-only must not callback foreign meeting",
  );
  let state = await p.evaluate(async () => {
    const s = await import("/src/offline-store.ts");
    return !!(await s.getDraft("cleanup-A"));
  });
  assert.equal(state, true, "scope unavailable must preserve cleanup draft");
  await p.evaluate(async () => {
    const u = await import("/src/upload-recordings.ts");
    window.fetch = async () =>
      new Response(
        JSON.stringify({
          ownerId: "owner-B",
          actorId: "actor-B",
          capabilities: { resumableUpload: 1 },
        }),
      );
    for (const op of [
      () => u.discardOfflineDraft("private-A"),
      () => u.resumeOfflineDraft("cleanup-A"),
    ]) {
      try {
        await op();
      } catch {}
    }
  });
  state = await p.evaluate(async () => {
    const s = await import("/src/offline-store.ts");
    return (await s.listDrafts()).map((d) => d.id).sort();
  });
  assert.deepEqual(
    state,
    ["cleanup-A", "private-A"],
    "foreign direct discard and cleanup APIs must preserve originals",
  );
  // Render authorized A, switch authentication during a delayed receipt/context body.
  await p.evaluate(async () => {
    const c = await import("/src/cloud.ts");
    c.saveSession(window.session("a"));
    window.fetch = async () =>
      new Response(
        JSON.stringify(
          c.getSession()?.token === window.session("a").token
            ? {
                ownerId: "owner-A",
                actorId: "actor-A",
                capabilities: { resumableUpload: 1 },
              }
            : {
                ownerId: "owner-B",
                actorId: "actor-B",
                capabilities: { resumableUpload: 1 },
              },
        ),
      );
    window.dispatchEvent(new Event("online"));
  });
  await p.getByText("PRIVATE ACCOUNT A", { exact: true }).first().waitFor();
  const [audio] = await Promise.all([
    p.waitForEvent("download"),
    p.getByRole("button", { name: "原音をダウンロード" }).first().click(),
  ]);
  assert.equal(
    (await readFile(await audio.path())).toString(),
    "PRIVATE AUDIO",
    "same-scope download remains usable",
  );
  await p.evaluate(async () => {
    const c = await import("/src/cloud.ts");
    c.saveSession(window.session("b"));
  });
  await p.waitForTimeout(150);
  assert.equal(
    await p.getByText("PRIVATE ACCOUNT A", { exact: true }).count(),
    0,
    "auth event invalidates rendered data immediately",
  );
  const stale = await p.evaluate(async () => {
    const c = await import("/src/cloud.ts"),
      u = await import("/src/upload-recordings.ts");
    c.saveSession(window.session("a"));
    let changed = false;
    window.fetch = async () => ({
      ok: true,
      json: async () => {
        if (!changed) {
          changed = true;
          c.saveSession(window.session("b"));
        }
        return {
          ownerId: "owner-A",
          actorId: "actor-A",
          capabilities: { resumableUpload: 1 },
        };
      },
    });
    try {
      await u.getUploadContext(false);
      return true;
    } catch {
      return false;
    }
  });
  assert.equal(
    stale,
    false,
    "authentication must be rechecked after async response.json",
  );
  await p.evaluate(async () => {
    const s = await import("/src/offline-store.ts"),
      c = await import("/src/cloud.ts"),
      d = await import("/supabase/functions/_shared/upload.mjs");
    c.saveSession(window.session("a"));
    window.accepted = undefined;
    const input = {
      uploadId: crypto.randomUUID(),
      metadata: {
        title: "STALE RESPONSE A",
        date: "2026-10-28",
        participants: "",
        template: "standard",
      },
      transcript: "synthetic",
      sources: [],
      parts: [],
      attachments: [],
    };
    const draft = await s.saveDraft({
      id: "delayed-A",
      scope: { ownerId: "owner-A", actorId: "actor-A" },
      mode: "text",
      metadata: input.metadata,
      transcript: input.transcript,
      files: [],
      attachments: [],
      sessionIds: [],
      updatedAt: 1,
    });
    const identity = {
      uploadId: input.uploadId,
      ownerId: "owner-A",
      planDigest: await d.uploadDigest(input),
    };
    await s.freezeDraft(
      draft.id,
      { input, identity, parts: [], attachments: [] },
      draft.revision,
    );
    window.fetch = async (url) => {
      if (String(url).endsWith("/context"))
        return new Response(
          JSON.stringify(
            c.getSession()?.token === window.session("a").token
              ? {
                  ownerId: "owner-A",
                  actorId: "actor-A",
                  capabilities: { resumableUpload: 1 },
                }
              : {
                  ownerId: "owner-B",
                  actorId: "actor-B",
                  capabilities: { resumableUpload: 1 },
                },
          ),
        );
      return {
        ok: true,
        json: () =>
          new Promise((resolve) => {
            window.releaseReceipt = () =>
              resolve({
                id: identity.uploadId,
                uploadIdentity: identity,
                uploadReceipt: {
                  ...identity,
                  meetingId: identity.uploadId,
                  status: "accepted",
                },
              });
          }),
      };
    };
    window.dispatchEvent(new Event("online"));
  });
  await p.waitForFunction(() => !!window.releaseReceipt);
  await p.evaluate(async () => {
    const c = await import("/src/cloud.ts");
    c.saveSession(window.session("b"));
    window.releaseReceipt();
  });
  await p.waitForTimeout(200);
  assert.equal(
    await p.evaluate(() => !!window.accepted),
    false,
    "old queue completion cannot call new account callback",
  );
  assert.equal(
    await p.evaluate(
      async () =>
        !!(await (await import("/src/offline-store.ts")).getDraft("delayed-A")),
    ),
    true,
    "stale receipt must not delete original draft",
  );
  console.log(
    "PASS FR-SEC-01 foreign content/download/discard/cleanup blocked, originals preserved, auth-change and stale body fenced",
  );
} finally {
  await browser.close();
  await server.close();
}
