// FR-LOGIC-01 independent preparation race + real readwrite CAS.
import {
  offlineBrowserFixture,
  localOnlyPage,
} from "./offline-browser-fixture.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const server = await offlineBrowserFixture(5279, "SYNTHETIC revision safety");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const p = await localOnlyPage(browser);
  await p.goto("http://127.0.0.1:5279/offline-fixture");
  const result = await p.evaluate(async () => {
    const s = await import("/src/offline-store.ts"),
      u = await import("/src/upload-recordings.ts"),
      r = await import("/src/recording.ts"),
      d = await import("/supabase/functions/_shared/upload.mjs");
    window.fetch = async () =>
      new Response(
        JSON.stringify({
          ownerId: "owner-A",
          actorId: "actor-A",
          capabilities: { resumableUpload: 1 },
        }),
      );
    let draft = await u.createOfflineDraft();
    draft =
      (await s.saveDraft({
        ...draft,
        files: [new File(["OLD"], "old.wav")],
        sourceSessions: ["old-session"],
        sessionIds: ["old-session"],
        metadata: { ...draft.metadata, title: "old title" },
      })) || (await s.getDraft(draft.id));
    await r.listRecoverableSessions();
    await new Promise((resolve, reject) => {
      const q = indexedDB.open("kotonoha-recorder", 1);
      q.onsuccess = () => {
        const db = q.result,
          tx = db.transaction(["sessions", "chunks"], "readwrite");
        for (const id of ["old-session", "new-unsent-session"]) {
          tx.objectStore("sessions").put({
            id,
            startedAt: 1,
            mode: "mic",
            mimeType: "audio/webm",
            extension: ".webm",
            integrity: "complete",
            expectedChunks: 1,
            failedIndices: [],
          });
          tx.objectStore("chunks").put({
            key: id + "#0",
            sessionId: id,
            index: 0,
            blob: new Blob([id]),
          });
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    window.Worker = class {
      postMessage() {
        window.releaseWorker = () =>
          this.onmessage({
            data: {
              parts: [
                {
                  blob: new Blob(["OLD"]),
                  name: "recording-1-1.wav",
                  sourceIndex: 0,
                  partNumber: 1,
                  duration: 1,
                },
              ],
            },
          });
      }
      terminate() {}
    };
    let posts = 0;
    window.fetch = async (url, options = {}) => {
      if (String(url).endsWith("/context"))
        return new Response(
          JSON.stringify({
            ownerId: "owner-A",
            actorId: "actor-A",
            capabilities: { resumableUpload: 1 },
          }),
        );
      posts++;
      const posted = JSON.parse(options.body);
      const identity = {
        uploadId: posted.uploadId,
        ownerId: "owner-A",
        planDigest: await d.uploadDigest(posted),
      };
      return new Response(
        JSON.stringify({
          id: posted.uploadId,
          uploadIdentity: identity,
          uploadReceipt: {
            ...identity,
            meetingId: posted.uploadId,
            status: "accepted",
          },
        }),
      );
    };
    const form = new FormData();
    form.set("_offlineDraftId", draft.id);
    form.set("_offlineDraftRevision", String(draft.revision));
    const pending = u
      .uploadRecordings(form, () => {})
      .then(
        () => false,
        () => true,
      );
    while (!window.releaseWorker)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await s.saveDraft({
      ...draft,
      metadata: { ...draft.metadata, title: "new tab B title" },
      files: [...draft.files, new File(["NEW UNSENT"], "new-unsent.wav")],
      sourceSessions: ["old-session", "new-unsent-session"],
      sessionIds: ["old-session", "new-unsent-session"],
    });
    window.releaseWorker();
    const rejected = await pending;
    let staleEditRejected = false;
    try {
      await s.saveDraft({
        ...draft,
        metadata: { ...draft.metadata, title: "stale editor A" },
      });
    } catch {
      staleEditRejected = true;
    }
    window.Worker = class {
      postMessage(files) {
        queueMicrotask(() =>
          this.onmessage({
            data: {
              parts: files.map((f, sourceIndex) => ({
                blob: new Blob(["PCM"]),
                name: `recording-${sourceIndex + 1}-1.wav`,
                sourceIndex,
                partNumber: 1,
                duration: 1,
              })),
            },
          }),
        );
      }
      terminate() {}
    };
    const preSubmitRejected = await u
      .uploadRecordings(form, () => {})
      .then(
        () => false,
        () => true,
      );
    const latest = await s.getDraft(draft.id);
    return {
      preSubmitRejected,
      rejected,
      posts,
      staleEditRejected,
      title: latest?.metadata.title,
      files: latest?.files.map((f) => f.name),
      frozen: !!latest?.attempt,
      sessions: (await r.listRecoverableSessions()).map((x) => x.id).sort(),
    };
  });
  assert.equal(
    result.rejected,
    true,
    "Worker snapshot must refuse freeze after newer draft commits",
  );
  assert.equal(
    result.preSubmitRejected,
    true,
    "displayed revision must reject a tab edit committed before submission starts",
  );
  assert.equal(result.posts, 0, "CAS conflict must happen before POST");
  assert.equal(
    result.staleEditRejected,
    true,
    "stale saveDraft must not overwrite another editor",
  );
  assert.equal(result.title, "new tab B title");
  assert.deepEqual(result.files, ["old.wav", "new-unsent.wav"]);
  assert.equal(result.frozen, false);
  assert.deepEqual(result.sessions, ["new-unsent-session", "old-session"]);
  console.log("PASS FR-LOGIC-01", result);
} finally {
  await browser.close();
  await server.close();
}
