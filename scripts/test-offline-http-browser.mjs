// Actual browser sender + real local HTTP handler/store; synthetic bytes and held AI only.
import { createServer } from "vite";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createApp } from "../server/app.mjs";
const evidence =
  process.env.KOTONOHA_OFFLINE_EVIDENCE ||
  fileURLToPath(new URL("../../kotonoha-offline-evidence/", import.meta.url));
await mkdir(evidence, { recursive: true });
const dir = await mkdtemp(path.join(evidence, "http-"));
let release;
const held = new Promise((resolve) => {
  release = resolve;
});
let aiCalls = 0;
const { app, waitForJobs } = await createApp({
  dataDir: dir,
  apiKey: "synthetic-local-only-not-a-real-key",
  aiFactory: () => ({
    transcribe: async () => {
      aiCalls++;
      await held;
      throw Error("SYNTHETIC fixture stops before provider");
    },
  }),
});
const http = app.listen(0, "127.0.0.1");
await once(http, "listening");
const base = `http://127.0.0.1:${http.address().port}`;
const vite = await createServer({
  plugins: [
    {
      name: "transport-fixture",
      configureServer(s) {
        s.middlewares.use("/transport-fixture", (_q, r) => {
          r.setHeader("Content-Type", "text/html;charset=utf-8");
          r.end(
            "<!doctype html><title>SYNTHETIC real local HTTP upload fixture — no AI</title>",
          );
        });
      },
    },
  ],
  server: {
    hmr: false,
    host: "127.0.0.1",
    port: 5201,
    strictPort: true,
    proxy: { "/api": { target: base } },
  },
});
await vite.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  await context.route("**/*", (r) =>
    new URL(r.request().url()).hostname === "127.0.0.1"
      ? r.continue()
      : r.abort(),
  );
  await page.goto("http://127.0.0.1:5201/transport-fixture");
  const result = await page.evaluate(async () => {
    const u = await import("/src/upload-recordings.ts"),
      s = await import("/src/offline-store.ts");
    const nativeFetch = window.fetch.bind(window);
    let stage = 0;
    const ids = [];
    window.fetch = async (url, options = {}) => {
      const response = await nativeFetch(url, options);
      if (new URL(url, location.href).pathname === "/api/uploads")
        ids.push(JSON.parse(options.body).uploadId);
      if (response.ok) {
        const path = new URL(url, location.href).pathname;
        if (
          (stage === 0 && path === "/api/uploads") ||
          (stage === 1 && path.endsWith("/parts")) ||
          (stage === 2 && path.endsWith("/complete"))
        ) {
          stage++;
          await response.arrayBuffer();
          throw new TypeError(
            "Failed to fetch SYNTHETIC committed response lost",
          );
        }
      }
      return response;
    };
    window.Worker = class {
      postMessage() {
        queueMicrotask(() =>
          this.onmessage({
            data: {
              parts: [
                {
                  blob: new Blob(["SYNTHETIC PCM"]),
                  name: "recording-1-1.wav",
                  sourceIndex: 0,
                  partNumber: 1,
                  duration: 1,
                },
              ],
            },
          }),
        );
      }
      terminate() {}
    };
    const form = new FormData();
    form.set("title", "SYNTHETIC real HTTP");
    form.set("date", "2026-10-28");
    form.set("participants", "fixture");
    form.set("template", "standard");
    form.append(
      "audio",
      new File(["SYNTHETIC PCM"], "source.wav", { type: "audio/wav" }),
    );
    form.append(
      "attachment",
      new File(["SYNTHETIC document"], "fixture.txt", { type: "text/plain" }),
    );
    try {
      await u.uploadRecordings(form, () => {});
    } catch {}
    const [draft] = await s.listDrafts();
    if (!draft?.attempt) throw Error("real handler did not freeze plan");
    for (let i = 0; i < 2; i++) {
      try {
        await u.resumeOfflineDraft(draft.id);
      } catch {}
    }
    const kept = !!(await s.getDraft(draft.id));
    const accepted = await u.resumeOfflineDraft(draft.id);
    return {
      stage,
      stable: ids.every((id) => id === ids[0]),
      kept,
      removed: !(await s.getDraft(draft.id)),
      meetingId: accepted.id,
      identity: accepted.uploadIdentity,
      receipt: accepted.uploadReceipt,
    };
  });
  assert.equal(result.stage, 3);
  assert.equal(result.stable, true);
  assert.equal(result.kept, true);
  assert.equal(result.removed, true);
  assert.equal(result.receipt.meetingId, result.meetingId);
  const records = await (await fetch(base + "/api/meetings")).json();
  assert.equal(records.length, 1);
  assert.equal(aiCalls, 1);
  assert.equal(records[0].recordings.length, 1);
  assert.equal(records[0].attachments.length, 1);
  console.log(
    "PASS real browser → actual local API/store: 3 committed response losses, one meeting, one part/attachment, accepted identity cleanup, one synthetic held AI job",
    result,
  );
} finally {
  await browser.close();
  await vite.close();
  release();
  await waitForJobs();
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
