import {
  offlineBrowserFixture,
  localOnlyPage,
} from "./offline-browser-fixture.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const server = await offlineBrowserFixture(5196, "SYNTHETIC offline fixture");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await localOnlyPage(browser);
  await page.goto("http://127.0.0.1:5196/offline-fixture");
  const result = await page.evaluate(async () => {
    const u = await import("/src/upload-recordings.ts"),
      s = await import("/src/offline-store.ts"),
      d = await import("/supabase/functions/_shared/upload.mjs");
    if (typeof u.resumeOfflineDraft !== "function") return { missing: true };
    let actor = "actor",
      owner = "owner",
      fail = "init-loss",
      posts = 0,
      partPosts = 0,
      completePosts = 0,
      attachmentPosts = 0,
      inputs = [],
      meeting = null;
    const ok = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    window.fetch = async (url, options = {}) => {
      const path = new URL(url, location.href).pathname;
      if (path === "/api/uploads/context")
        return ok({
          ownerId: owner,
          actorId: actor,
          capabilities: { resumableUpload: 1 },
        });
      if (path === "/api/uploads") {
        posts++;
        const input = JSON.parse(options.body);
        inputs.push(input);
        const identity = {
          uploadId: input.uploadId,
          ownerId: "owner",
          planDigest: await d.uploadDigest(input),
        };
        meeting ||= {
          id: input.uploadId,
          status: "uploading",
          recordings: [],
          attachments: [],
          uploadIdentity: identity,
        };
        if (fail === "init-loss") {
          fail = "part-loss";
          throw new TypeError("Failed to fetch SYNTHETIC lost init response");
        }
        return ok(meeting);
      }
      if (path.endsWith("/parts")) {
        partPosts++;
        meeting.recordings.push({ fixture: true });
        if (fail === "part-loss") {
          fail = "complete-loss";
          throw new DOMException("SYNTHETIC abort", "AbortError");
        }
        return ok(meeting);
      }
      if (path.endsWith("/attachments")) {
        attachmentPosts++;
        meeting.attachments.push({ id: options.body.get("id") });
        return ok(meeting);
      }
      if (path.endsWith("/complete")) {
        completePosts++;
        meeting = {
          ...meeting,
          status: "transcribing",
          uploadReceipt: {
            ...meeting.uploadIdentity,
            meetingId: meeting.id,
            status: "accepted",
          },
        };
        if (fail === "complete-loss") {
          fail = "";
          throw new TypeError(
            "Failed to fetch SYNTHETIC lost complete response",
          );
        }
        return ok(meeting);
      }
      throw new Error("FORBIDDEN NETWORK " + path);
    };
    // Mock only audio codec worker boundary; no microphone, real plan hashing/IDB/send.
    window.Worker = class {
      postMessage() {
        queueMicrotask(() =>
          this.onmessage({
            data: {
              parts: [
                {
                  blob: new Blob(["SYNTHETIC PCM"]),
                  name: "recording-1-1.wav",
                  fileName: "original.wav", // Real splitRecordings includes a display-only source name.
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
    const data = new FormData();
    data.set("title", "SYNTHETIC upload");
    data.set("date", "2026-10-28");
    data.set("participants", "");
    data.set("template", "standard");
    data.append(
      "audio",
      new File(["SYNTHETIC PCM"], "original.wav", { type: "audio/wav" }),
    );
    data.append(
      "attachment",
      new File(["SYNTHETIC DOC"], "fixture.txt", { type: "text/plain" }),
    );
    let firstError = "";
    try {
      await u.uploadRecordings(data, () => {});
    } catch (e) {
      firstError = e.message;
    }
    let drafts = await s.listDrafts();
    const id = drafts[0]?.id;
    const frozen = await s.getDraft(id);
    if (!frozen?.attempt)
      throw Error(
        "Real worker shape must freeze a resumable attempt; got " + firstError,
      );
    await s.saveDraft({
      ...frozen,
      id: "other",
      revision: 0,
      attempt: undefined,
      status: undefined,
    });
    const retryStates = [];
    for (let i = 0; i < 2; i++) {
      try {
        await u.resumeOfflineDraft(id, () => {});
      } catch {}
      retryStates.push((await s.getDraft(id))?.status);
    }
    const beforeCleanup = await s.getDraft(id);
    const accepted = await u.resumeOfflineDraft(id, () => {});
    const stable = inputs.every(
      (v) => JSON.stringify(v) === JSON.stringify(inputs[0]),
    );
    const sha = inputs[0].parts.every((p) => /^[a-f0-9]{64}$/.test(p.sha256));
    const beforeStale = posts,
      beforeStaleDrafts = (await s.listDrafts()).length;
    data.set("_offlineDraftId", id);
    try {
      await u.uploadRecordings(data, () => {});
    } catch {}
    const staleSafe =
      posts === beforeStale &&
      (await s.listDrafts()).length === beforeStaleDrafts;
    const primary = {
      staleSafe,
      missing: false,
      firstError: !!firstError,
      stable,
      sha,
      posts,
      partPosts,
      completePosts,
      attachmentPosts,
      retryStates,
      beforeCleanup: !!beforeCleanup,
      removed: !(await s.getDraft(id)),
      other: !!(await s.getDraft("other")),
      accepted: !!accepted.uploadReceipt,
    };
    // Wrong-owner/account must stop before any init, leaving original untouched.
    meeting = null;
    fail = "";
    actor = "different";
    const oldPosts = posts;
    const mismatch = await s.getDraft("other");
    await s.freezeDraft(
      "other",
      frozen.attempt,
      (await s.getDraft("other")).revision || 0,
    );
    try {
      await u.resumeOfflineDraft("other", () => {});
    } catch {}
    primary.accountBlocked =
      posts === oldPosts && (await s.getDraft("other")).status === "blocked";
    actor = "actor";
    meeting = {
      id: frozen.attempt.identity.uploadId,
      status: "transcribing",
      recordings: [],
      attachments: [],
      uploadIdentity: frozen.attempt.identity,
      uploadReceipt: {
        ...frozen.attempt.identity,
        ownerId: "wrong",
        meetingId: frozen.attempt.identity.uploadId,
        status: "accepted",
      },
    };
    try {
      await u.resumeOfflineDraft("other", () => {});
    } catch {}
    primary.wrongReceiptKept = !!(await s.getDraft("other"));
    primary.wrongReceiptBlocked =
      (await s.getDraft("other")).status === "blocked";
    // Cleanup failure after an accepted receipt must never create another meeting.
    await s.saveDraft({
      ...frozen,
      id: "cleanup",
      revision: 0,
      attempt: undefined,
      sessionIds: ["original-a"],
    });
    await s.freezeDraft(
      "cleanup",
      frozen.attempt,
      (await s.getDraft("cleanup")).revision || 0,
    );
    const recorder = await import("/src/recording.ts");
    await recorder.listRecoverableSessions();
    await new Promise((resolve, reject) => {
      const q = indexedDB.open("kotonoha-recorder", 1);
      q.onsuccess = () => {
        const db = q.result,
          tx = db.transaction(["sessions", "chunks"], "readwrite");
        for (const id of ["original-a", "unrelated-b"]) {
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
            blob: new Blob(["SYNTHETIC original"]),
          });
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    meeting = {
      ...meeting,
      uploadReceipt: {
        ...frozen.attempt.identity,
        meetingId: frozen.attempt.identity.uploadId,
        status: "accepted",
      },
    };
    const nativeDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (...args) {
      const req = nativeDelete.apply(this, args);
      if (this.name === "sessions")
        req.addEventListener("success", () => req.transaction.abort());
      return req;
    };
    try {
      await u.resumeOfflineDraft("cleanup", () => {});
    } catch {}
    IDBObjectStore.prototype.delete = nativeDelete;
    const failedCleanup = await s.getDraft("cleanup"),
      initAfterReceipt = posts;
    await u.resumeOfflineDraft("cleanup", () => {});
    primary.cleanupOnly =
      posts === initAfterReceipt &&
      !!failedCleanup.receipt &&
      !(await s.getDraft("cleanup"));
    primary.originalCleaned = !(await recorder.listRecoverableSessions()).some(
      (v) => v.id === "original-a",
    );
    primary.unrelatedKept = (await recorder.listRecoverableSessions()).some(
      (v) => v.id === "unrelated-b",
    );
    // Stop automatic retries for invalid 200 and permanent permission/validation errors.
    const originalFetch = window.fetch;
    primary.permanent = [];
    for (const code of [200, 403, 400]) {
      window.fetch = async (url) =>
        new URL(url, location.href).pathname.endsWith("/context")
          ? ok({
              ownerId: "owner",
              actorId: "actor",
              capabilities: { resumableUpload: 1 },
            })
          : code === 200
            ? ok({ not: "a meeting" })
            : ok({ error: "SYNTHETIC permanent" }, code);
      try {
        await u.resumeOfflineDraft("other", () => {});
      } catch {}
      primary.permanent.push((await s.getDraft("other")).status);
    }
    // Timeout while online and AbortError are transient, not permanent rejection.
    window.fetch = async (url, options) =>
      new URL(url, location.href).pathname.endsWith("/context")
        ? ok({
            ownerId: "owner",
            actorId: "actor",
            capabilities: { resumableUpload: 1 },
          })
        : new Promise((_, reject) =>
            options.signal.addEventListener("abort", () =>
              reject(new DOMException("SYNTHETIC timeout", "AbortError")),
            ),
          );
    try {
      await u.resumeOfflineDraft("other", () => {}, { timeoutMs: 20 });
    } catch {}
    primary.timeoutQueued = (await s.getDraft("other")).status === "queued";
    window.fetch = async (url, options) =>
      new URL(url, location.href).pathname.endsWith("/context")
        ? ok({
            ownerId: "owner",
            actorId: "actor",
            capabilities: { resumableUpload: 1 },
          })
        : {
            ok: true,
            status: 200,
            json: () =>
              new Promise((_, reject) =>
                options.signal.addEventListener("abort", () =>
                  reject(
                    new DOMException("SYNTHETIC body timeout", "AbortError"),
                  ),
                ),
              ),
          };
    try {
      await u.resumeOfflineDraft("other", () => {}, { timeoutMs: 20 });
    } catch {}
    primary.bodyTimeoutQueued = (await s.getDraft("other")).status === "queued";
    window.fetch = originalFetch;
    await s.updateSubmission("other", { nextRetryAt: Date.now() + 60000 });
    const beforeBackoff = posts;
    await u.resumeOfflineDraft("other", () => {}, { automatic: true });
    primary.lockedBackoff =
      posts === beforeBackoff && !!(await s.getDraft("other"));
    return primary;
  });
  assert.equal(result.missing, false, "durable resumable sender must exist");
  assert.equal(result.firstError, true);
  assert.equal(result.stable, true);
  assert.equal(result.sha, true);
  assert.equal(
    result.partPosts,
    1,
    "lost part response resumes at persisted server count",
  );
  assert.equal(
    result.completePosts,
    1,
    "lost completion response must reuse accepted receipt",
  );
  assert.equal(result.attachmentPosts, 1);
  assert.equal(result.removed, true);
  assert.equal(result.other, true);
  assert.equal(result.accountBlocked, true);
  assert.equal(result.wrongReceiptKept, true);
  assert.equal(result.wrongReceiptBlocked, true);
  assert.equal(result.accepted, true);
  console.log(
    "PASS real outbox init/part/complete response loss, stable plan/hash, scoped receipt cleanup, account mismatch",
    result,
  );
  assert.equal(result.cleanupOnly, true);
  assert.equal(result.originalCleaned, true);
  assert.equal(result.unrelatedKept, true);
  assert.deepEqual(result.permanent, ["blocked", "blocked", "blocked"]);
  assert.equal(result.timeoutQueued, true);
  console.log(
    "PASS accepted cleanup-only retry, exact original deletion/unrelated preservation, invalid200/403/400 stop, online timeout queued",
  );
  assert.equal(
    result.lockedBackoff,
    true,
    "automatic sender must recheck persisted backoff after acquiring cross-tab lock",
  );
  assert.equal(
    result.staleSafe,
    true,
    "a stale form after automatic acceptance/cleanup must not recreate its missing draft or a new upload",
  );
  assert.equal(
    result.bodyTimeoutQueued,
    true,
    "timeout after HTTP headers while reading body must remain retryable",
  );
} finally {
  await browser.close();
  await server.close();
}
