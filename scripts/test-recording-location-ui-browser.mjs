// Real React components, synthetic meeting, loopback API fixture. Never production.
import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDemo } from "../supabase/functions/_shared/demo.mjs";
import { uploadDigest } from "../supabase/functions/_shared/upload.mjs";
import {
  minutesMarkdownPatch,
  PatchSchema,
} from "../supabase/functions/_shared/domain.mjs";
const output = path.resolve(
  process.env.LOCATION_EVIDENCE || "../kotonoha-location-evidence",
);
await mkdir(output, { recursive: true });
const point = {
  latitude: 1.234567,
  longitude: 2.345678,
  accuracy: 8,
  capturedAt: "2026-10-28T01:02:03.000Z",
};
let meeting = {
  ...createDemo(),
  isDemo: false,
  sources: [{ name: "架空の録音.webm", size: 100, startLocation: point }],
  recordingLocations: [{ sourceIndex: 0, ...point }],
};
const patches = [],
  uploads = [];
let uploadMeeting;
let failDeletion = false;
const initialMeeting = JSON.stringify(meeting);
const source = `import React from 'react'; import { createRoot } from 'react-dom/client';
import { NewMeeting } from '/src/NewMeeting'; import { MeetingDetail } from '/src/MeetingDetail';
import { uploadRecordings } from '/src/upload-recordings'; import '/src/styles.css';
window.uploadRecordings=uploadRecordings;
function App(){ const [m,setM]=React.useState(${JSON.stringify(meeting)});
return <><p>検証専用：架空の会議・位置</p>{location.search.includes('record') ? <NewMeeting settings={{configured:true,geminiConfigured:false,model:'gpt-6-astra',transcriptionModel:'gpt-transcribe',maxFileSize:24000000}} templates={[]} onClose={()=>{}} onSettings={()=>{}} onBot={()=>{}} onCreate={async data=>{ window.submitted=data; }} /> : <MeetingDetail meeting={m} onBack={()=>{}} backLabel="戻る" onCalendar={()=>{}} onRename={()=>{}} onChooseTags={()=>{}} onEditingChange={()=>{}} onChange={setM} notify={s=>{window.notice=s;}} onDelete={()=>{}} />}</>; }
createRoot(document.getElementById('root')).render(<App/>);`;
const fixtureId = path.resolve("__location_fixture.tsx");
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  plugins: [
    react(),
    {
      name: "location-ui-fixture",
      resolveId(id) {
        if (id === "/__location_fixture.tsx") return fixtureId;
      },
      load(id) {
        if (id === fixtureId)
          return source.replace(initialMeeting, JSON.stringify(meeting));
      },
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (req.url?.startsWith("/__location_ui")) {
            res.setHeader("Content-Type", "text/html;charset=utf-8");
            res.end(
              await s.transformIndexHtml(
                req.url,
                '<html lang="ja"><body><div id="root"></div><script type="module" src="/__location_fixture.tsx"></script></body></html>',
              ),
            );
            return;
          }
          if (req.url === "/api/uploads/context") {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ownerId: "fixture",
                actorId: "fixture",
                capabilities: { resumableUpload: 1 },
              }),
            );
            return;
          }
          if (req.url?.endsWith("/complete") && uploadMeeting) {
            res.setHeader("Content-Type", "application/json");
            uploadMeeting.uploadReceipt = {
              ...uploadMeeting.uploadIdentity,
              meetingId: uploadMeeting.id,
              status: "accepted",
            };
            res.end(JSON.stringify(uploadMeeting));
            return;
          }
          if (req.url?.startsWith("/api/meetings/")) {
            res.setHeader("Content-Type", "application/json");
            if (req.method === "PATCH" && failDeletion) {
              res.statusCode = 503;
              res.end(JSON.stringify({ error: "検証用の保存エラー" }));
              return;
            }
            if (req.method === "PATCH") {
              let body = "";
              for await (const part of req) body += part;
              const patch = JSON.parse(body);
              patches.push(patch);
              meeting = {
                ...meeting,
                ...minutesMarkdownPatch(meeting, PatchSchema.parse(patch)),
              };
            }
            res.end(JSON.stringify(meeting));
            return;
          }
          if (req.url === "/api/uploads") {
            let body = "";
            for await (const part of req) body += part;
            const input = JSON.parse(body);
            uploads.push(input);
            uploadMeeting = {
              id: input.uploadId,
              status: "uploading",
              recordings: [],
              attachments: [],
              uploadIdentity: {
                uploadId: input.uploadId,
                ownerId: "fixture",
                planDigest: await uploadDigest(input),
              },
            };
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(uploadMeeting));
            return;
          }
          next();
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
try {
  const context = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 1.234567, longitude: 2.345678, accuracy: 8 },
    viewport: {
      width: Number(process.env.LOCATION_UI_WIDTH || 1440),
      height: 1100,
    },
    acceptDownloads: true,
  });
  const external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin)
      return route.continue();
    if (new URL(route.request().url()).hostname === "fonts.googleapis.com")
      return route.fulfill({ contentType: "text/css", body: "" });
    external.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mode = process.env.LOCATION_UI_MODE || "record";
  await page.goto(`${origin}/__location_ui?${mode}`);
  if (mode === "record") {
    await page.getByRole("button", { name: "その場で録音" }).click();
    const toggle = page.getByRole("checkbox", { name: "録音場所を記録する" });
    assert.equal(await toggle.count(), 1, "opt-in control exists");
    assert.equal(await toggle.isChecked(), false);
    await toggle.check();
    await page.getByRole("button", { name: "録音を開始", exact: true }).click();
    await page
      .getByRole("button", { name: "停止して追加", exact: true })
      .waitFor();
    await page.waitForTimeout(1500);
    await page
      .getByRole("button", { name: "停止して追加", exact: true })
      .click();
    await page
      .locator(".audio-file-list, .selected-files")
      .first()
      .waitFor()
      .catch(() => {});
    await page.screenshot({
      path: path.join(output, "location-new-meeting.png"),
      fullPage: true,
    });
    await page.locator("form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => window.submitted);
    const submitted = await page.evaluate(() => ({
      locations: JSON.parse(window.submitted.get("recordingLocations")),
      files: window.submitted.getAll("audio").map((f) => f.name),
    }));
    assert.equal(submitted.locations[0].latitude, 1.234567);
    assert.equal(submitted.files.length, 1);
    await page.evaluate(() =>
      window.uploadRecordings(window.submitted, () => {}),
    );
    assert.equal(
      uploads[0].sources[0].startLocation?.latitude,
      1.234567,
      "actual uploader preserves location after FormData cloning and audio worker",
    );
    console.log(
      "PASS browser opt-in default off -> record -> submit source association",
    );
  } else {
    await page.locator(".meeting-heading").waitFor();
    const panel = page.locator(".recording-locations");
    assert.equal(await panel.count(), 1, "meeting location panel exists");
    assert.match(await panel.innerText(), /1.234567/);
    const link = panel.getByRole("link", { name: "地図で場所を確認" });
    assert.match(await link.getAttribute("href"), /1.234567.*2.345678/);
    assert.equal(await link.getAttribute("rel"), "noreferrer noopener");
    assert.ok(
      await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      "location panel does not overflow",
    );
    await page.screenshot({
      path: path.join(
        output,
        `location-meeting-detail-${process.env.LOCATION_UI_WIDTH || 1440}.png`,
      ),
      fullPage: true,
    });
    await page.emulateMedia({ media: "print" });
    assert.equal(
      await panel.evaluate((e) => getComputedStyle(e).display),
      "none",
      "print excludes location",
    );
    await page.pdf({ path: path.join(output, "location-print.pdf") });
    await page.emulateMedia({ media: "screen" });
    await page.locator(".export-menu summary").click();
    const wait = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "すべてのデータ（JSON）", exact: true })
      .click();
    const download = await wait;
    const json = await readFile(await download.path(), "utf8");
    assert.doesNotMatch(
      json,
      /recordingLocations|startLocation|1\.234567|2\.345678/,
    );
    for (const name of [/議事録.*Markdown/, "文字起こし（テキスト）"]) {
      if ((await page.locator(".export-menu").getAttribute("open")) === null)
        await page.locator(".export-menu summary").click();
      const pending = page.waitForEvent("download");
      await page.getByRole("button", { name }).click();
      const item = await pending;
      assert.doesNotMatch(
        await readFile(await item.path(), "utf8"),
        /recordingLocations|startLocation|1\.234567|2\.345678/,
      );
    }
    page.once("dialog", (dialog) => dialog.dismiss());
    await panel.getByRole("button", { name: "録音場所をすべて削除" }).click();
    assert.deepEqual(patches, []);
    failDeletion = true;
    page.once("dialog", (dialog) => dialog.accept());
    await panel.getByRole("button", { name: "録音場所をすべて削除" }).click();
    await page.waitForFunction(() => window.notice === "検証用の保存エラー");
    assert.equal(
      await panel.count(),
      1,
      "failed deletion preserves displayed and saved location",
    );
    assert.equal(meeting.recordingLocations.length, 1);
    failDeletion = false;
    page.once("dialog", (dialog) => dialog.accept());
    await panel.getByRole("button", { name: "録音場所をすべて削除" }).click();
    await panel.waitFor({ state: "detached" });
    assert.deepEqual(patches, [{ recordingLocations: null }]);
    assert.deepEqual(meeting.recordingLocations, []);
    assert.equal(meeting.sources[0].startLocation, undefined);
    server.moduleGraph.invalidateAll();
    await page.reload();
    await page.locator(".meeting-heading").waitFor();
    assert.equal(await page.locator(".recording-locations").count(), 0);
    console.log("PASS browser details/map link/delete/reload/JSON/print");
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(
    external,
    [],
    "no reverse geocoder or external automatic request",
  );
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
