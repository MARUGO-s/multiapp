import { createServer } from "vite";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const evidence =
  process.env.KOTONOHA_OFFLINE_EVIDENCE ||
  fileURLToPath(new URL("../../kotonoha-offline-evidence/", import.meta.url));
await mkdir(evidence, { recursive: true });
const fixture = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{NewMeeting}from'/src/NewMeeting.tsx';import{uploadRecordings}from'/src/upload-recordings.ts';function Fixture(){const[open,setOpen]=useState(true);return React.createElement('main',null,React.createElement('h1',null,'SYNTHETIC LOCAL FIXTURE — no microphone / AI'),React.createElement('button',{onClick:()=>setOpen(true)},'新規fixture'),open&&React.createElement(NewMeeting,{settings:{configured:true,transcriptionModel:'gpt-transcribe',model:'gpt-6-astra'},templates:[],onClose:()=>setOpen(false),onSettings:()=>{},onBot:()=>{throw Error('FORBIDDEN BOT')},onCreate:async(data,progress)=>{await uploadRecordings(data,progress);setOpen(false);}}));}createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
const server = await createServer({
  plugins: [
    {
      name: "offline-fixture",
      resolveId(id) {
        if (id === "virtual:offline-ui") return "\0virtual:offline-ui";
      },
      load(id) {
        if (id === "\0virtual:offline-ui") return fixture;
      },
      configureServer(s) {
        s.middlewares.use("/offline-ui", async (_q, r) => {
          r.setHeader("Content-Type", "text/html;charset=utf-8");
          r.end(
            await s.transformIndexHtml(
              "/offline-ui",
              '<!doctype html><meta charset="utf-8"><title>SYNTHETIC local UI</title><div id="root"></div><script type="module" src="/@id/__x00__virtual:offline-ui"></script>',
            ),
          );
        });
      },
    },
  ],
  server: { hmr: false, host: "127.0.0.1", port: 5197, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE", m.text());
  });
  page.setDefaultTimeout(8000);
  page.on("requestfailed", (r) => console.log("FAILED", r.url(), r.failure()));
  let scopeUnavailable = false,
    uploadRequests = 0;
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== "127.0.0.1") return route.abort();
    if (u.pathname === "/api/uploads") uploadRequests++;
    if (u.pathname === "/api/uploads/context" && scopeUnavailable)
      return route.abort();
    if (u.pathname === "/api/uploads/context")
      return route.fulfill({
        json: {
          ownerId: "fixture-owner",
          actorId: "fixture-actor",
          capabilities: { resumableUpload: 1 },
        },
      });
    return route.continue();
  });
  await page.goto("http://127.0.0.1:5197/offline-ui");
  await page.getByText("テキスト", { exact: true }).click();
  await page
    .getByLabel("会議名", { exact: true })
    .fill("SYNTHETIC 保存する日本語");
  await page
    .getByLabel("会話テキスト", { exact: false })
    .fill("SYNTHETIC conversation");
  await page.waitForTimeout(150);
  let count = await page.evaluate(
    async () =>
      new Promise((resolve) => {
        const r = indexedDB.open("kotonoha-offline");
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains("drafts")) {
            db.close();
            resolve(0);
            return;
          }
          const q = db.transaction("drafts").objectStore("drafts").getAll();
          q.onsuccess = () => {
            db.close();
            resolve(
              q.result.filter(
                (d) => d.metadata.title === "SYNTHETIC 保存する日本語",
              ).length,
            );
          };
        };
      }),
  );
  assert.equal(
    count,
    1,
    "actual NewMeeting must persist inputs before submission",
  );
  await page.reload();
  await page.getByLabel("会議名", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(
        'input[placeholder="例：新サービスのリリース定例"]',
      )?.value === "SYNTHETIC 保存する日本語",
  );
  assert.equal(
    await page.getByLabel("会話テキスト", { exact: false }).inputValue(),
    "SYNTHETIC conversation",
  );
  await page.getByText("録音ファイル", { exact: true }).click();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "SYNTHETIC.wav",
      mimeType: "audio/wav",
      buffer: Buffer.from("SYNTHETIC WAVE"),
    });
  await page.locator("details.new-meeting-options summary").click();
  await page
    .locator("input[type=file]")
    .nth(1)
    .setInputFiles({
      name: "SYNTHETIC.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("SYNTHETIC attachment"),
    });
  await page.waitForTimeout(200);
  await page.reload();
  await page.getByText("1. SYNTHETIC.wav", { exact: true }).waitFor();
  const stored = await page.evaluate(async () => {
    const m = await import("/src/offline-store.ts");
    const ds = await m.listDrafts();
    return {
      files: await ds[0].files[0].text(),
      attachment: await ds[0].attachments[0].text(),
    };
  });
  assert.equal(stored.files, "SYNTHETIC WAVE");
  assert.equal(stored.attachment, "SYNTHETIC attachment");
  await page.getByRole("button", { name: "原音をダウンロード" }).waitFor();
  await page.getByRole("button", { name: "この下書きを破棄" }).waitFor();
  const [audioDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "原音をダウンロード" }).click(),
  ]);
  assert.equal(
    (await readFile(await audioDownload.path())).toString(),
    "SYNTHETIC WAVE",
  );
  await page.evaluate(() => {
    window.Worker = class {
      postMessage() {
        queueMicrotask(() =>
          this.onmessage({
            data: {
              parts: [
                {
                  blob: new Blob(["SYNTHETIC WAVE"]),
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
  });
  scopeUnavailable = true;
  await context.setOffline(true);
  await page.locator("dialog .modal-footer button").last().click();
  await page.getByRole("alert").waitFor();
  const offlineKept = await page.evaluate(async () => {
    const m = await import("/src/offline-store.ts");
    const ds = await m.listDrafts();
    return (
      !ds[0].attempt &&
      ds[0].files.length === 1 &&
      ds[0].attachments.length === 1
    );
  });
  assert.equal(offlineKept, true);
  assert.equal(
    uploadRequests,
    0,
    "unavailable fresh scope must stop before upload POST",
  );
  scopeUnavailable = false;
  await context.setOffline(false);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "この下書きを破棄" }).click();
  // The launch button exists even while the form is open. Wait for the actual
  // async discard/close commit, not that unrelated always-present control.
  await page.locator("dialog").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "新規fixture" }).waitFor();
  assert.equal(
    await page.evaluate(async () => {
      const m = await import("/src/offline-store.ts");
      return (await m.listDrafts()).length;
    }),
    0,
  );
  console.log(
    "PASS actual NewMeeting input/file/attachment reload restoration + original download/discard controls",
    stored,
  );
  console.log(
    "PASS real download bytes, unavailable fresh scope preserves editable source/attachment without sending, explicit scoped discard",
  );
  await page.evaluate(async () => {
    const r = await import("/src/recording.ts");
    await r.listRecoverableSessions();
    await new Promise((resolve) => {
      const q = indexedDB.open("kotonoha-recorder", 1);
      q.onsuccess = () => {
        const db = q.result,
          tx = db.transaction(["sessions", "chunks"], "readwrite");
        tx.objectStore("sessions").put({
          id: "foreign-original",
          draftId: "deleted-other-draft",
          scope: { ownerId: "foreign-owner", actorId: "foreign-actor" },
          startedAt: 1,
          mode: "mic",
          mimeType: "audio/webm",
          extension: ".webm",
        });
        tx.objectStore("sessions").put({
          id: "orphan-original",
          draftId: "deleted-draft",
          scope: { ownerId: "fixture-owner", actorId: "fixture-actor" },
          integrity: "complete",
          expectedChunks: 1,
          failedIndices: [],
          startedAt: 1,
          mode: "mic",
          mimeType: "audio/webm",
          extension: ".webm",
        });
        tx.objectStore("chunks").put({
          key: "orphan-original#0",
          sessionId: "orphan-original",
          index: 0,
          blob: new Blob(["SYNTHETIC orphan"]),
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  });
  await page.getByRole("button", { name: "新規fixture" }).click();
  await page
    .getByRole("button", { name: "復元して追加", exact: true })
    .waitFor();
  console.log(
    "PASS unsubmitted original remains recoverable after its draft is accepted/deleted",
  );
  await page.screenshot({
    path: path.join(evidence, "frontend-ui.png"),
    fullPage: true,
  });
  await page.evaluate(async () => {
    const ctx = new AudioContext(),
      dest = ctx.createMediaStreamDestination(),
      osc = ctx.createOscillator();
    osc.connect(dest);
    osc.start();
    await ctx.resume();
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        window.fixtureGrant = () => resolve(dest.stream);
      });
    window.MediaRecorder = class {
      static isTypeSupported() {
        return true;
      }
      state = "inactive";
      constructor() {
        window.fixtureRecorder = this;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["SYNTHETIC late recording"], { type: "audio/webm" }),
        });
        queueMicrotask(() => this.onstop?.());
      }
    };
  });
  await page.getByRole("button", { name: "その場で録音", exact: true }).click();
  await page.getByRole("button", { name: "録音を開始", exact: true }).click();
  await page.getByText("マイクを準備しています…", { exact: true }).waitFor();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.evaluate(() => window.fixtureGrant());
  await page.waitForTimeout(400);
  assert.equal(
    await page.evaluate(() => window.fixtureRecorder?.state),
    "inactive",
    "late microphone permission after unmount must finalize without deleting original or leaking capture",
  );
  const retainedAfterUnmount = await page.evaluate(async () => {
    const r = await import("/src/recording.ts");
    const sessions = await r.listRecoverableSessions();
    for (const s of sessions) {
      if (s.id === "orphan-original" || s.id === "foreign-original") continue;
      const f = await r.recoverSession(s.id);
      if ((await f.text()) === "SYNTHETIC late recording") return true;
    }
    return false;
  });
  assert.equal(retainedAfterUnmount, true);
  console.log(
    "PASS actual NewMeeting unmount during pending microphone permission stops late recorder and preserves original",
  );
} finally {
  await browser.close();
  await server.close();
}
