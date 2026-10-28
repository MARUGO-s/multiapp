// Integrated real React/MediaRecorder/worker/IndexedDB → real local HTTP/store.
// Synthetic GPS + Chrome fake microphone only. No provider, DB or remote access.
import { createServer } from "vite";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { createApp } from "../server/app.mjs";
import { summaryInput } from "../supabase/functions/_shared/summary.mjs";
const output = path.resolve(
  process.env.KOTONOHA_INTEGRATION_EVIDENCE ||
    "../kotonoha-integration-evidence",
);
await mkdir(output, { recursive: true });
const dir = await mkdtemp(path.join(output, "integration-http-"));
const aiInputs = [];
let aiCalls = 0,
  release;
const held = new Promise((r) => (release = r));
const instance = await createApp({
  dataDir: dir,
  apiKey: "SYNTHETIC-NOT-A-KEY",
  aiFactory: () => ({
    async transcribe() {
      aiCalls++;
      await held;
      return { transcript: "SYNTHETIC offline recording conversation" };
    },
    async summarize(m) {
      aiInputs.push(summaryInput(m));
      return {
        summary: "SYNTHETIC minutes body",
        topics: [],
        decisions: [],
        actions: [],
        openQuestions: [],
      };
    },
  }),
});
const http = instance.app.listen(0, "127.0.0.1");
await once(http, "listening");
const base = `http://127.0.0.1:${http.address().port}`;
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import{NewMeeting}from'/src/NewMeeting';import{MeetingDetail}from'/src/MeetingDetail';import{uploadRecordings}from'/src/upload-recordings';import'/src/styles.css';
function Fixture(){const[m,setM]=React.useState(null);React.useEffect(()=>{if(location.search.includes('detail'))fetch('/api/meetings/'+sessionStorage.getItem('meeting')).then(r=>r.json()).then(setM);},[]);return <><h1>SYNTHETIC local-only integration</h1>{m?<MeetingDetail meeting={m} onBack={()=>{}} backLabel='戻る' onCalendar={()=>{}} onRename={()=>{}} onChooseTags={()=>{}} onEditingChange={()=>{}} onChange={setM} notify={s=>window.notice=s} onDelete={()=>{}}/>:<NewMeeting draftId={sessionStorage.getItem('draft') || undefined} templates={[]} settings={{configured:true,model:'gpt-6-astra',transcriptionModel:'gpt-transcribe',maxFileSize:24000000}} onClose={()=>{}} onSettings={()=>{}} onBot={()=>{throw Error('FORBIDDEN BOT')}} onCreate={async(data,progress)=>{window.submittedLocations=data.get('recordingLocations');const m=await uploadRecordings(data,progress);sessionStorage.setItem('meeting',m.id);window.accepted=m;setM(m);}}/>}</>;}createRoot(document.getElementById('root')).render(<Fixture/>);`;
const fixtureId = path.resolve("__offline_location_fixture.tsx");
let postCount = 0;
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  plugins: [
    (await import("@vitejs/plugin-react")).default(),
    {
      name: "synthetic-offline-location",
      resolveId(id) {
        if (id === "/__offline_location_fixture.tsx") return fixtureId;
      },
      load(id) {
        if (id === fixtureId) return fixture;
      },
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (req.url?.startsWith("/__integration")) {
            res.setHeader("Content-Type", "text/html;charset=utf-8");
            res.end(
              await s.transformIndexHtml(
                req.url,
                '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/__offline_location_fixture.tsx"></script>',
              ),
            );
            return;
          }
          if (req.url?.startsWith("/api/") && req.method === "POST")
            postCount++;
          next();
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 0,
    hmr: false,
    proxy: { "/api": { target: base } },
  },
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const rows = [];
try {
  const context = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 1.234567, longitude: 2.345678, accuracy: 8 },
    acceptDownloads: true,
  });
  const external = [],
    errors = [];
  let failedTransport = false,
    scopeUnavailable = false;
  await context.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin !== origin) {
      if (u.hostname === "fonts.googleapis.com")
        return r.fulfill({ contentType: "text/css", body: "" });
      external.push(u.origin);
      return r.abort();
    }
    if (
      failedTransport &&
      u.pathname.startsWith("/api/") &&
      (scopeUnavailable || u.pathname !== "/api/uploads/context")
    )
      return r.abort("internetdisconnected");
    return r.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/__integration");
  await page.getByRole("button", { name: "その場で録音", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: "録音場所を記録する" });
  assert.equal(await toggle.isChecked(), false);
  await toggle.check();
  await page.getByRole("button", { name: "録音を開始", exact: true }).click();
  await page
    .getByRole("button", { name: "停止して追加", exact: true })
    .waitFor();
  await page.waitForFunction(async () => {
    const r = await import("/src/recording.ts");
    return (await r.listRecoverableSessions()).some((s) => s.startLocation);
  });
  await page.waitForTimeout(1200);
  await context.setOffline(true);
  await page.getByRole("button", { name: "停止して追加", exact: true }).click();
  // Imports used below were already loaded by the real component. No new offline module fetch.
  await page.waitForFunction(async () => {
    const s = await import("/src/offline-store.ts");
    const [d] = await s.listDrafts();
    return (
      d?.files.length === 1 && d.sourceLocations?.[0]?.latitude === 1.234567
    );
  });
  const initial = await page.evaluate(async () => {
    const s = await import("/src/offline-store.ts"),
      r = await import("/src/recording.ts");
    const [d] = await s.listDrafts();
    return {
      id: d.id,
      file: d.files[0].name,
      size: d.files[0].size,
      point: d.sourceLocations[0],
      sessions: (await r.listRecoverableSessions()).map((s) => s.id),
    };
  });
  assert.equal(initial.sessions.length, 1);
  assert.ok(initial.size > 0);
  rows.push("record → offline draft + original/session + explicit location");
  // Restore connectivity only for local app assets: API remains unavailable and navigator.onLine=true.
  await context.setOffline(false);
  failedTransport = true;
  scopeUnavailable = true;
  await page.reload();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByText("1. " + initial.file, { exact: true }).count(),
    0,
    "unavailable fresh scope must not reveal stored original",
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (await (await import("/src/offline-store.ts")).listDrafts())[0]?.files
          .length,
    ),
    1,
    "hidden original remains durable",
  );
  scopeUnavailable = false;
  await page.reload();
  await page.getByText("1. " + initial.file, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.onLine), true);
  await page.locator("form").evaluate((f) => f.requestSubmit());
  await page
    .getByRole("button", { name: /手動再送/ })
    .waitFor()
    .catch(async (e) => {
      console.error(
        "INTEGRATION FAILURE",
        await page.locator("body").innerText(),
        await page.evaluate(async () => {
          const s = await import("/src/offline-store.ts");
          return (await s.listDrafts()).map((d) => ({
            id: d.id,
            status: d.status,
            error: d.error,
            attempt: !!d.attempt,
            mode: d.mode,
            metadata: d.metadata,
          }));
        }),
        errors,
      );
      await page.screenshot({
        path: path.join(output, "integration-failure.png"),
        fullPage: true,
      });
      throw e;
    });
  const frozen = await page.evaluate(async () => {
    const s = await import("/src/offline-store.ts"),
      r = await import("/src/recording.ts");
    const [d] = await s.listDrafts();
    window.frozenInput = d.attempt.input;
    sessionStorage.setItem("draft", d.id);
    return {
      id: d.id,
      identity: d.attempt.identity,
      input: d.attempt.input,
      source: d.sourceLocations[0],
      sessionCount: (await r.listRecoverableSessions()).length,
      status: d.status,
    };
  });
  assert.equal(frozen.id, initial.id);
  assert.deepEqual(frozen.input.sources[0].startLocation, initial.point);
  assert.equal(frozen.sessionCount, 1);
  assert.equal(frozen.status, "queued");
  assert.equal(postCount, 0);
  const { uploadDigest } =
    await import("../supabase/functions/_shared/upload.mjs");
  assert.equal(await uploadDigest(frozen.input), frozen.identity.planDigest);
  const altered = structuredClone(frozen.input);
  altered.sources[0].startLocation.latitude = 3.456789;
  assert.notEqual(await uploadDigest(altered), frozen.identity.planDigest);
  rows.push(
    "reload → online=true transport failure → zero server POST; original/location/frozen digest retained",
  );
  await page.reload();
  await page.getByRole("button", { name: /手動再送/ }).waitFor();
  failedTransport = false;
  await page.getByRole("button", { name: /手動再送/ }).click();
  await page.waitForFunction(() => window.accepted);
  const accepted = await page.evaluate(() => window.accepted);
  assert.deepEqual(accepted.sources[0].startLocation, initial.point);
  assert.deepEqual(accepted.recordingLocations, [
    { sourceIndex: 0, ...initial.point },
  ]);
  assert.equal(accepted.uploadReceipt.status, "accepted");
  assert.equal(accepted.uploadReceipt.planDigest, frozen.identity.planDigest);
  const clean = await page.evaluate(async () => {
    const s = await import("/src/offline-store.ts"),
      r = await import("/src/recording.ts");
    return {
      drafts: (await s.listDrafts()).length,
      sessions: (await r.listRecoverableSessions()).length,
      chunks: await new Promise((resolve, reject) => {
        const q = indexedDB.open("kotonoha-recorder");
        q.onsuccess = () => {
          const db = q.result,
            req = db.transaction("chunks").objectStore("chunks").count();
          req.onsuccess = () => {
            db.close();
            resolve(req.result);
          };
          req.onerror = () => reject(req.error);
        };
      }),
    };
  });
  assert.deepEqual(clean, { drafts: 0, sessions: 0, chunks: 0 });
  rows.push(
    "recovery → server location exact match → accepted receipt → target draft/parts/original/session removed",
  );
  release();
  await instance.waitForJobs();
  assert.equal(aiCalls, 1);
  assert.equal(aiInputs.length, 1);
  assert.doesNotMatch(
    JSON.stringify(aiInputs),
    /1\.234567|2\.345678|startLocation|recordingLocations/,
  );
  await page.goto(origin + "/__integration?detail");
  await page.locator(".meeting-heading").waitFor();
  const panel = page.locator(".recording-locations");
  assert.match(await panel.innerText(), /1.234567/);
  // The existing shared-workspace GET returns the same location. Separate authenticated viewers are covered by cloud-api.test.ts.
  const shared = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/meetings/" + id)).json()).recordingLocations,
    accepted.id,
  );
  assert.deepEqual(shared, accepted.recordingLocations);
  const map = panel.getByRole("link", { name: "地図で場所を確認" });
  assert.match(await map.getAttribute("href"), /1.234567.*2.345678/);
  await page.locator(".export-menu summary").click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "すべてのデータ（JSON）", exact: true })
    .click();
  const download = await downloadPromise;
  const json = await readFile(await download.path(), "utf8");
  assert.equal(JSON.parse(json).id, accepted.id);
  assert.doesNotMatch(
    json,
    /recordingLocations|startLocation|1\.234567|2\.345678|uploadInput/,
  );
  await writeFile(path.join(output, "integration-export.json"), json);
  await page.emulateMedia({ media: "print" });
  assert.equal(
    await panel.evaluate((e) => getComputedStyle(e).display),
    "none",
  );
  await page.pdf({ path: path.join(output, "integration-location-print.pdf") });
  await page.emulateMedia({ media: "screen" });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfTask = pdfjs.getDocument({
    data: new Uint8Array(
      await readFile(path.join(output, "integration-location-print.pdf")),
    ),
    useSystemFonts: true,
  });
  const pdf = await pdfTask.promise;
  let pdfText = "";
  for (let i = 1; i <= pdf.numPages; i++)
    pdfText += (await (await pdf.getPage(i)).getTextContent()).items
      .map((i) => i.str)
      .join(" ");
  await pdfTask.destroy();
  assert.match(pdfText, /SYNTHETIC minutes body/);
  assert.doesNotMatch(pdfText, /1\.234567|2\.345678|録音場所|地図で場所を確認/);
  await writeFile(path.join(output, "integration-print-text.txt"), pdfText);
  rows.push(
    "AI explicit input + actual JSON download + actual printed PDF exclude coordinates before deletion",
  );
  page.once("dialog", (d) => d.accept());
  await panel.getByRole("button", { name: "録音場所をすべて削除" }).click();
  await panel.waitFor({ state: "detached" });
  const assertLocationErased = async () => {
    assert.doesNotMatch(
      await readFile(path.join(dir, "meetings", `${accepted.id}.json`), "utf8"),
      /startLocation|latitude|longitude|accuracy|capturedAt|1\.234567|2\.345678/,
      "UI deletion must erase raw locations from every persisted copy, including uploadInput",
    );
  };
  await assertLocationErased();
  const replay = await page.evaluate(
    async ({ id, input }) => {
      const call = async (path, body) => {
        const r = await fetch("/api" + path, {
          method: "POST",
          headers: { "X-Kotonoha": "1", "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!r.ok) throw Error("replay status " + r.status);
        return r.json();
      };
      const complete = await call("/meetings/" + id + "/complete"),
        init = await call("/uploads", input),
        current = await (await fetch("/api/meetings/" + id)).json();
      return { complete, init, current };
    },
    { id: accepted.id, input: frozen.input },
  );
  for (const current of Object.values(replay)) {
    assert.deepEqual(current.recordingLocations, []);
    assert.equal(current.sources[0].startLocation, undefined);
    assert.equal(current.id, accepted.id);
    assert.ok(current.uploadReceipt);
  }
  await assertLocationErased();
  assert.equal(
    aiInputs.length,
    1,
    "init/complete replays do not start another summary",
  );
  assert.equal(
    await page.evaluate(
      async (id) =>
        (
          await fetch(`/api/meetings/${id}/retry`, {
            method: "POST",
            headers: { "X-Kotonoha": "1", "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
      accepted.id,
    ),
    202,
  );
  await instance.waitForJobs();
  await assertLocationErased();
  assert.equal(
    aiInputs.length,
    2,
    "only explicit regeneration creates another summary",
  );
  await page.reload();
  await page.locator(".meeting-heading").waitFor();
  assert.equal(await page.locator(".recording-locations").count(), 0);
  assert.equal(aiCalls, 1);
  assert.equal(instance.store.list().length, 1);
  rows.push(
    "detail delete → complete/init frozen replay → explicit regeneration → reload: all saved coordinate copies erased, one meeting/transcription, no retry-triggered summary",
  );
  await page.screenshot({
    path: path.join(output, "integration-final.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const result = {
    pass: true,
    scenarios: rows,
    identity: frozen.identity,
    originalBytes: initial.size,
    clean,
    aiCalls,
    externalRequests: external.length,
  };
  await writeFile(
    path.join(output, "integration-browser-results.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    "PASS integrated real Chrome + local HTTP",
    JSON.stringify(result),
  );
  await context.close();
} finally {
  release();
  await browser.close();
  await vite.close();
  await instance.waitForJobs();
  await new Promise((r) => http.close(r));
  await rm(dir, { recursive: true, force: true });
}
