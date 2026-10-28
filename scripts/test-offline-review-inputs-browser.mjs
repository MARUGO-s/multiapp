// FR-LOGIC-03: actual NewMeeting all form values survive reload; never run Bot.
import { createServer } from "vite";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const source = `import React from'react';import{createRoot}from'react-dom/client';import{NewMeeting}from'/src/NewMeeting.tsx';window.mount=()=>createRoot(document.getElementById('root')).render(React.createElement(NewMeeting,{settings:{configured:true},templates:[],onClose:()=>{},onSettings:()=>{},onBot:()=>{window.botCalls++},onCreate:()=>{window.creates++}}));`;
const server = await createServer({
  define: { "import.meta.env.VITE_STORAGE_MODE": JSON.stringify("supabase") },
  plugins: [
    {
      name: "inputs",
      resolveId(id) {
        if (id === "virtual:inputs") return "\0virtual:inputs";
      },
      load(id) {
        if (id === "\0virtual:inputs") return source;
      },
      configureServer(s) {
        s.middlewares.use("/inputs-fixture", async (_q, r) => {
          r.setHeader("Content-Type", "text/html;charset=utf-8");
          r.end(
            await s.transformIndexHtml(
              "/inputs-fixture",
              '<!doctype html><div id="root"></div><script type="module" src="/@id/__x00__virtual:inputs"></script>',
            ),
          );
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 5281, strictPort: true, hmr: false },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const c = await browser.newContext();
  await c.route("**/*", (r) =>
    new URL(r.request().url()).hostname === "127.0.0.1"
      ? r.continue()
      : r.abort(),
  );
  const p = await c.newPage();
  async function mount() {
    await p.goto("http://127.0.0.1:5281/inputs-fixture");
    await p.waitForFunction(() => window.mount);
    await p.evaluate(async () => {
      const auth = await import("/src/cloud.ts");
      auth.saveSession({
        token: "ktn_" + "a".repeat(64),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      window.botCalls = 0;
      window.creates = 0;
      window.fetch = async () =>
        new Response(
          JSON.stringify({
            ownerId: "owner",
            actorId: "actor",
            capabilities: { resumableUpload: 1 },
          }),
        );
      window.mount();
    });
    await p.getByLabel("会議名", { exact: true }).waitFor();
  }
  await mount();
  await p.getByLabel("会議名", { exact: true }).fill("PERSISTED TITLE");
  await p.getByRole("button", { name: "その場で録音", exact: true }).click();
  await p.getByLabel("録音場所を記録する").check();
  // Browser control name is verified against real DOM; mic+tab selection is a radio/button.
  await p
    .getByRole("button", {
      name: "マイク＋会議の音声（ブラウザーのタブ）",
      exact: true,
    })
    .click();
  await p.getByRole("button", { name: "Botを呼ぶ", exact: true }).click();
  await p
    .getByLabel("Google MeetのURL", { exact: false })
    .fill("https://meet.google.com/abc-defg-hij");
  await p.waitForFunction(async () => {
    const s = await import("/src/offline-store.ts");
    return (await s.listDrafts()).some(
      (d) => d.mode === "bot" && d.metadata.title === "PERSISTED TITLE",
    );
  });
  await p.waitForTimeout(200);
  await mount();
  await p.waitForFunction(
    () =>
      document.querySelector(
        'input[placeholder="例：新サービスのリリース定例"]',
      )?.value === "PERSISTED TITLE",
  );
  assert.equal(
    await p.getByLabel("Google MeetのURL", { exact: false }).inputValue(),
    "https://meet.google.com/abc-defg-hij",
    "Meet URL must survive reload",
  );
  await p.getByRole("button", { name: "その場で録音", exact: true }).click();
  assert.equal(
    await p.getByLabel("録音場所を記録する").isChecked(),
    true,
    "location opt-in input must survive reload",
  );
  assert.match(
    await p
      .getByRole("button", {
        name: "マイク＋会議の音声（ブラウザーのタブ）",
        exact: true,
      })
      .getAttribute("class"),
    /active/,
    "recording mode must survive reload",
  );
  assert.equal(await p.evaluate(() => window.botCalls), 0);
  assert.equal(await p.evaluate(() => window.creates), 0);
  console.log(
    "PASS FR-LOGIC-03 URL/location/mode inputs restored without automatic Bot/upload",
  );
} finally {
  await browser.close();
  await server.close();
}
