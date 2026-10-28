import {
  offlineBrowserFixture,
  localOnlyPage,
} from "./offline-browser-fixture.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const server = await offlineBrowserFixture(5194, "SYNTHETIC offline fixture");
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await localOnlyPage(browser);
  await page.goto("http://127.0.0.1:5194/offline-fixture");
  const result = await page.evaluate(async () => {
    // Mock only the recorder/device boundary; actual app module and IndexedDB.
    const ctx = new AudioContext();
    await ctx.resume();
    const source = ctx.createOscillator(),
      dest = ctx.createMediaStreamDestination();
    source.connect(dest);
    source.start();
    navigator.mediaDevices.getUserMedia = async () => dest.stream;
    window.MediaRecorder = class {
      static isTypeSupported() {
        return true;
      }
      state = "inactive";
      onstop = null;
      ondataavailable = null;
      start() {
        this.state = "recording";
      }
      pause() {
        this.state = "paused";
      }
      resume() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["SYNTHETIC AUDIO FIXTURE"], { type: "audio/webm" }),
        });
        queueMicrotask(() => this.onstop?.(new Event("stop")));
      }
    };
    const r = await import("/src/recording.ts");
    const controller = await r.startRecording("mic", () => {});
    const pair = await Promise.race([
      Promise.all([controller.stop(), controller.stop()]),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    if (!pair) return { retained: false, concurrentHung: true };
    const [f, repeated] = pair,
      sessions = await r.listRecoverableSessions();
    if (!sessions.length) return { retained: false, size: f.size };
    const recovered = await r.recoverSession(sessions[0].id),
      after = await r.listRecoverableSessions();
    const second = await r.recoverSession(sessions[0].id);
    await r.discardSession(sessions[0].id);
    await ctx.close();
    return {
      concurrentHung: false,
      repeated: repeated.size,
      retained: true,
      size: f.size,
      recovered: recovered.size,
      after: after.length,
      repeat: second.size,
      discarded: (await r.listRecoverableSessions()).length,
    };
  });
  assert.equal(
    result.concurrentHung,
    false,
    "stop/unmount racing must share one finalization rather than hanging the original stop",
  );
  assert.equal(
    result.retained,
    true,
    "stopping must retain IndexedDB original until receipt",
  );
  assert.ok(result.size > 0);
  assert.equal(result.recovered, result.size);
  assert.equal(result.after, 1, "recover must be non-destructive");
  assert.equal(result.repeat, result.size);
  assert.equal(result.discarded, 0);
  console.log(
    "PASS synthetic boundary / real recorder IDB stop, recover twice, explicit discard",
    result,
  );
  const storageFailure = await page.evaluate(async () => {
    const ctx = new AudioContext(),
      dest = ctx.createMediaStreamDestination(),
      osc = ctx.createOscillator();
    osc.connect(dest);
    osc.start();
    await ctx.resume();
    navigator.mediaDevices.getUserMedia = async () => dest.stream;
    const r = await import("/src/recording.ts");
    let notified = false;
    const controller = await r.startRecording("mic", () => {}, {
      onStorageError: () => {
        notified = true;
      },
    });
    const native = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const req = native.apply(this, args);
      if (this.name === "chunks")
        req.addEventListener("success", () => req.transaction.abort());
      return req;
    };
    let outcome;
    try {
      outcome = await Promise.race([
        controller.stop().then(
          () => "false-success",
          () => "rejected",
        ),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 1500)),
      ]);
    } finally {
      IDBObjectStore.prototype.put = native;
      await ctx.close();
    }
    return {
      outcome,
      notified,
      retained: (await r.listRecoverableSessions()).some(
        (s) => s.id === controller.sessionId,
      ),
    };
  });
  assert.equal(
    storageFailure.outcome,
    "rejected",
    "IDB abort must reject stop, never hang or report success",
  );
  assert.equal(storageFailure.notified, true);
  assert.equal(storageFailure.retained, true);
  console.log(
    "PASS recorder IDB abort surfaces error and retains session",
    storageFailure,
  );
  const quota = await page.evaluate(async () => {
    const ctx = new AudioContext(),
      dest = ctx.createMediaStreamDestination();
    await ctx.resume();
    navigator.mediaDevices.getUserMedia = async () => dest.stream;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "sessions")
        throw new DOMException(
          "SYNTHETIC quota exhausted",
          "QuotaExceededError",
        );
      return put.apply(this, args);
    };
    let rejected = false;
    try {
      const r = await import("/src/recording.ts");
      await r.startRecording("mic", () => {});
    } catch {
      rejected = true;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const stopped = dest.stream
      .getTracks()
      .every((t) => t.readyState === "ended");
    await ctx.close();
    return { rejected, stopped };
  });
  assert.equal(quota.rejected, true);
  assert.equal(
    quota.stopped,
    true,
    "failed initial IDB commit must release captured media devices",
  );
  console.log("PASS start quota failure is visible and releases device", quota);
} finally {
  await browser.close();
  await server.close();
}
