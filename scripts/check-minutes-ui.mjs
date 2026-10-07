// Local-only UI smoke server. No saved keys, production records or paid AI calls.
import { createApp } from "../server/app.mjs";
import { createDemo } from "../server/demo.mjs";
import { createServer } from "vite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MINUTES_FORMATS } from "../supabase/functions/_shared/minutes-formats.mjs";
import { minutesToMarkdown } from "../supabase/functions/_shared/domain.mjs";

const dataDir = await mkdtemp(path.join(tmpdir(), "kotonoha-minutes-ui-"));
const { app, store } = await createApp({
  dataDir,
  apiKey: "sk-mock-test-only-never-sent",
  aiFactory: () => ({ summarize: async () => createDemo().minutes }),
});
for (const format of MINUTES_FORMATS) {
  const meeting = {
    ...createDemo(),
    id: randomUUID(),
    isDemo: false,
    source: "text",
    template: format.id,
    title: `表示検証・${format.label}（架空の会議）`,
  };
  meeting.markdown = minutesToMarkdown(meeting, meeting.minutes);
  await store.save(meeting);
}
const api = app.listen(5197, "127.0.0.1");
const vite = await createServer({
  server: {
    port: 5198,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5197",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (req) =>
            req.setHeader("Origin", "http://127.0.0.1:5197"),
          );
        },
      },
    },
  },
});
await vite.listen();
console.log(JSON.stringify({ url: "http://127.0.0.1:5198/", mockAI: true }));
async function stop() {
  await vite.close();
  api.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
