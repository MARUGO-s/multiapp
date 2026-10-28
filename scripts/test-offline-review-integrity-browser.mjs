// FR-LOGIC-02: abort middle/head/tail, reload, and inability to persist failure mark.
import {
  offlineBrowserFixture,
  localOnlyPage,
} from "./offline-browser-fixture.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const server = await offlineBrowserFixture(5280, "SYNTHETIC integrity safety");
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
try {
  const p = await localOnlyPage(browser);
  await p.goto("http://127.0.0.1:5280/offline-fixture");
  for (const scenario of [
    { fail: 1, markFails: false },
    { fail: 0, markFails: false },
    { fail: 2, markFails: false },
    { fail: 1, markFails: true },
  ]) {
    const failure = await p.evaluate(async ({ fail, markFails }) => {
      const ctx = new AudioContext(),
        dest = ctx.createMediaStreamDestination();
      await ctx.resume();
      navigator.mediaDevices.getUserMedia = async () => dest.stream;
      window.MediaRecorder = class {
        static isTypeSupported() {
          return true;
        }
        state = "inactive";
        constructor() {
          window.rec = this;
        }
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable({ data: new Blob(["TAIL"]) });
          queueMicrotask(() => this.onstop(new Event("stop")));
        }
      };
      const r = await import("/src/recording.ts");
      const c = await r.startRecording("mic", () => {});
      const put = IDBObjectStore.prototype.put;
      let aborts = 0;
      IDBObjectStore.prototype.put = function (value, ...args) {
        if (markFails && this.name === "sessions")
          throw new DOMException("SYNTHETIC mark quota", "QuotaExceededError");
        const req = put.call(this, value, ...args);
        if (this.name === "chunks" && value.index === fail)
          req.addEventListener("success", () => {
            aborts++;
            req.transaction.abort();
          });
        return req;
      };
      window.rec.ondataavailable({ data: new Blob(["HEAD"]) });
      window.rec.ondataavailable({ data: new Blob(["MIDDLE"]) });
      let rejected = false;
      try {
        await c.stop();
      } catch {
        rejected = true;
      } finally {
        IDBObjectStore.prototype.put = put;
        await ctx.close();
      }
      return { id: c.sessionId, rejected, aborts };
    }, scenario);
    assert.equal(
      failure.rejected,
      true,
      "failed chunk commit must reject stop",
    );
    assert.equal(failure.aborts, 1);
    await p.reload();
    const restored = await p.evaluate(async (id) => {
      const r = await import("/src/recording.ts");
      let accepted = false,
        error = "";
      try {
        await r.recoverSession(id);
        accepted = true;
      } catch (e) {
        error = e.message;
      }
      return {
        accepted,
        error,
        preserved: (await r.listRecoverableSessions()).some((s) => s.id === id),
      };
    }, failure.id);
    assert.equal(
      restored.accepted,
      false,
      `partial ${JSON.stringify(scenario)} must not become a normal File across reload`,
    );
    assert.equal(restored.preserved, true);
    assert.match(restored.error, /不完全|完全性|未完了/);
    console.log("PASS FR-LOGIC-02", scenario, restored);
    const guarded = await p.evaluate(async (id) => {
      const s = await import("/src/offline-store.ts"),
        u = await import("/src/upload-recordings.ts"),
        r = await import("/src/recording.ts");
      let posts = 0,
        workers = 0;
      window.Worker = class {
        constructor() {
          workers++;
        }
      };
      window.fetch = async (url) => {
        if (!String(url).endsWith("/context")) posts++;
        return new Response(
          JSON.stringify({
            ownerId: "owner",
            actorId: "actor",
            capabilities: { resumableUpload: 1 },
          }),
        );
      };
      const draft = await s.saveDraft({
        id: crypto.randomUUID(),
        scope: { ownerId: "owner", actorId: "actor" },
        mode: "file",
        metadata: {
          title: "legacy partial",
          date: "2026-10-28",
          participants: "",
          template: "standard",
        },
        transcript: "",
        files: [new File(["HEADTAIL"], "partial.webm")],
        attachments: [],
        sessionIds: [id],
        sourceSessions: [id],
        updatedAt: 1,
      });
      const form = new FormData();
      form.set("_offlineDraftId", draft.id);
      form.set("_offlineDraftRevision", String(draft.revision));
      let sendBlocked = false;
      try {
        await u.uploadRecordings(form, () => {});
      } catch {
        sendBlocked = true;
      }
      const identity = {
        uploadId: crypto.randomUUID(),
        ownerId: "owner",
        planDigest: "a".repeat(64),
      };
      await s.freezeDraft(
        draft.id,
        { input: {}, identity, parts: [], attachments: [] },
        draft.revision,
      );
      await s.updateSubmission(draft.id, {
        receipt: {
          ...identity,
          meetingId: identity.uploadId,
          status: "accepted",
        },
        acceptedMeeting: { id: identity.uploadId },
        status: "cleanup",
      });
      let cleanupBlocked = false;
      try {
        await u.resumeOfflineDraft(draft.id, undefined, { automatic: true });
      } catch {
        cleanupBlocked = true;
      }
      return {
        sendBlocked,
        cleanupBlocked,
        posts,
        workers,
        kept: !!(await s.getDraft(draft.id)),
        originalKept: (await r.listRecoverableSessions()).some(
          (s) => s.id === id,
        ),
      };
    }, failure.id);
    assert.deepEqual(
      guarded,
      {
        sendBlocked: true,
        cleanupBlocked: true,
        posts: 0,
        workers: 0,
        kept: true,
        originalKept: true,
      },
      "legacy partial file and receipt must not permit automatic upload or deletion",
    );
  }
  for (const missingIndex of [0, 1, 2]) {
    const outcome = await p.evaluate(async (missingIndex) => {
      const r = await import("/src/recording.ts");
      const id = crypto.randomUUID();
      await r.listRecoverableSessions();
      await new Promise((resolve) => {
        const q = indexedDB.open("kotonoha-recorder");
        q.onsuccess = () => {
          const db = q.result,
            tx = db.transaction(["sessions", "chunks"], "readwrite");
          tx.objectStore("sessions").put({
            id,
            startedAt: 1,
            mode: "mic",
            mimeType: "audio/webm",
            extension: ".webm",
            integrity: "complete",
            expectedChunks: 3,
            failedIndices: [],
          });
          for (let i = 0; i < 3; i++)
            if (i !== missingIndex)
              tx.objectStore("chunks").put({
                key: id + "#" + i,
                sessionId: id,
                index: i,
                blob: new Blob(["chunk"]),
              });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
      let blocked = false;
      try {
        await r.recoverSession(id);
      } catch {
        blocked = true;
      }
      return {
        blocked,
        preserved: (await r.listRecoverableSessions()).some((s) => s.id === id),
      };
    }, missingIndex);
    assert.deepEqual(outcome, { blocked: true, preserved: true });
    console.log("PASS sealed manifest gap", missingIndex, outcome);
  }
} finally {
  await browser.close();
  await server.close();
}
