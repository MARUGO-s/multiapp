import {
  offlineBrowserFixture,
  localOnlyPage,
} from "./offline-browser-fixture.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const server = await offlineBrowserFixture(
  5205,
  "SYNTHETIC strict capability regression",
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await localOnlyPage(browser);
  await page.goto("http://127.0.0.1:5205/offline-fixture");
  const results = await page.evaluate(async () => {
    const u = await import("/src/upload-recordings.ts"),
      s = await import("/src/offline-store.ts");
    let capability = { resumableUpload: 1 },
      posts = 0;
    window.fetch = async (url, options = {}) => {
      if (options.method === "POST") {
        posts++;
        throw new TypeError("SYNTHETIC write boundary");
      }
      return new Response(
        JSON.stringify({
          ownerId: "local",
          actorId: "local",
          ...(capability === undefined ? {} : { capabilities: capability }),
        }),
      );
    };
    const draft = await u.createOfflineDraft();
    draft.mode = "text";
    draft.transcript = "SYNTHETIC";
    draft.metadata.title = "SYNTHETIC";
    draft.files = [new File(["ORIGINAL"], "preserve.wav")];
    await s.saveDraft(draft);
    // A previously valid cached context must not authorize a legacy or malformed fresh response.
    const results = [];
    for (const value of [
      undefined,
      {},
      null,
      { resumableUpload: 0 },
      { resumableUpload: "1" },
      { resumableUpload: true },
      { resumableUpload: 2 },
      ["resumableUpload"],
    ]) {
      capability = value;
      const before = posts;
      let rejected = false;
      try {
        await u.getUploadContext(false);
      } catch {
        rejected = true;
      }
      const form = new FormData();
      form.set("_offlineDraftId", draft.id);
      try {
        await u.uploadRecordings(form, () => {});
      } catch {}
      const kept = (await s.listDrafts()).some((d) =>
        d.files.some((f) => f.name === "preserve.wav" && f.size === 8),
      );
      results.push({
        value: value ?? "missing/null",
        rejected,
        posts: posts - before,
        kept,
      });
    }
    capability = { resumableUpload: 1 };
    const scope = await u.getUploadContext(false);
    return { results, valid: scope.ownerId === "local" };
  });
  for (const result of results.results) {
    assert.equal(result.rejected, true, JSON.stringify(result));
    assert.equal(result.posts, 0, JSON.stringify(result));
    assert.equal(result.kept, true);
  }
  assert.equal(results.valid, true);
  console.log(
    "PASS strict resumableUpload === 1, 8 legacy/malformed contexts, zero POST, original preserved",
    JSON.stringify(results),
  );
} finally {
  await browser.close();
  await server.close();
}
