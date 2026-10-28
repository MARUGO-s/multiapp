import { createServer } from "vite";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const server = await createServer({
  define: { "import.meta.env.VITE_STORAGE_MODE": JSON.stringify("supabase") },
  plugins: [
    {
      name: "auth-fixture",
      configureServer(s) {
        s.middlewares.use("/auth-fixture", (_q, r) => {
          r.setHeader("Content-Type", "text/html;charset=utf-8");
          r.end(
            "<!doctype html><title>SYNTHETIC cloud auth fixture — all API requests intercepted</title>",
          );
        });
      },
    },
  ],
  server: { hmr: false, host: "127.0.0.1", port: 5200, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  await context.route("**/*", (r) =>
    new URL(r.request().url()).hostname === "127.0.0.1"
      ? r.continue()
      : r.abort(),
  );
  await page.goto("http://127.0.0.1:5200/auth-fixture");
  const result = await page.evaluate(async () => {
    const c = await import("/src/cloud.ts"),
      u = await import("/src/upload-recordings.ts"),
      s = await import("/src/offline-store.ts"),
      d = await import("/supabase/functions/_shared/upload.mjs");
    const session = (ch) => ({
      token: "ktn_" + ch.repeat(64),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const a = session("a"),
      b = session("b"),
      renewed = session("c");
    c.saveSession(a);
    let posts = 0,
      swap = false;
    window.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      const token = options.headers.Authorization;
      const ok = (v) =>
        new Response(JSON.stringify(v), {
          headers: { "Content-Type": "application/json" },
        });
      if (path.endsWith("/uploads/context")) {
        const scope = {
          ownerId: "owner",
          actorId: token.endsWith(b.token) ? "actor-B" : "actor-A",
          capabilities: { resumableUpload: 1 },
        };
        if (swap) c.saveSession(b);
        return ok(scope);
      }
      if (path.endsWith("/uploads")) {
        posts++;
        return new Response(JSON.stringify({ error: "SYNTHETIC 503" }), {
          status: 503,
        });
      }
      throw Error("FORBIDDEN " + path);
    };
    const draft = await u.createOfflineDraft(),
      input = {
        uploadId: crypto.randomUUID(),
        metadata: {
          title: "SYNTHETIC AUTH",
          date: "2026-10-28",
          participants: "",
          template: "standard",
        },
        sources: [],
        parts: [],
        attachments: [],
        transcript: "SYNTHETIC",
      };
    await s.freezeDraft(
      draft.id,
      {
        input,
        identity: {
          uploadId: input.uploadId,
          ownerId: "owner",
          planDigest: await d.uploadDigest(input),
        },
        parts: [],
        attachments: [],
      },
      (await s.getDraft(draft.id)).revision || 0,
    );
    c.saveSession(b);
    try {
      await u.resumeOfflineDraft(draft.id);
    } catch {}
    const otherBlocked =
      posts === 0 && (await s.getDraft(draft.id)).status === "blocked";
    c.saveSession(a);
    swap = true;
    try {
      await u.resumeOfflineDraft(draft.id);
    } catch {}
    const midflightBlocked = posts === 0;
    swap = false;
    c.saveSession(renewed);
    try {
      await u.resumeOfflineDraft(draft.id);
    } catch {}
    const sameActorManual =
      posts === 1 && (await s.getDraft(draft.id)).status === "queued";
    const uncached = session("d");
    c.saveSession(uncached);
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let changed = false;
    crypto.subtle.digest = async (...args) => {
      const value = await nativeDigest(...args);
      if (!changed) {
        changed = true;
        c.saveSession(b);
      }
      return value;
    };
    try {
      await u.getUploadContext();
    } catch {}
    crypto.subtle.digest = nativeDigest;
    c.saveSession(uncached);
    window.fetch = async () => {
      throw new TypeError("Failed to fetch SYNTHETIC offline");
    };
    let cachedForeign = false;
    try {
      cachedForeign = (await u.getUploadContext()).actorId === "actor-B";
    } catch {}
    return {
      cachedForeign,
      cloud: c.isCloud,
      otherBlocked,
      midflightBlocked,
      sameActorManual,
      kept: !!(await s.getDraft(draft.id)),
    };
  });
  assert.equal(result.cloud, true);
  assert.equal(result.otherBlocked, true);
  assert.equal(result.midflightBlocked, true);
  assert.equal(result.sameActorManual, true);
  assert.equal(result.kept, true);
  assert.equal(
    result.cachedForeign,
    false,
    "scope cache must not bind a new account to a previous token during asynchronous key hashing",
  );
  console.log(
    "PASS actual cloud credential path: different actor blocked, mid-request relogin blocked, renewed same actor manual resume, draft retained",
    result,
  );
} finally {
  await browser.close();
  await server.close();
}
