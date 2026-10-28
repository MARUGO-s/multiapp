// Real browser + MediaRecorder + IndexedDB, synthetic coordinates only; no external I/O.
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = path.resolve(
  process.env.LOCATION_EVIDENCE || "../kotonoha-location-evidence",
);
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "location-fixture",
      configureServer(s) {
        s.middlewares.use("/__location_test", (_q, res) => {
          res.setHeader("Content-Type", "text/html;charset=utf-8");
          res.end(
            '<!doctype html><html lang="ja"><body>架空の位置・録音検証</body></html>',
          );
        });
      },
    },
  ],
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
const results = [];
try {
  for (const scenario of [
    "off",
    "granted",
    "denied",
    "timeout",
    "late-stop",
    "late-cancel",
    "recovery",
    "sealed-recovery",
  ]) {
    const context = await browser.newContext({
      permissions:
        scenario === "granted" || scenario.endsWith("recovery")
          ? ["geolocation"]
          : [],
      geolocation: { latitude: 1.234567, longitude: 2.345678, accuracy: 8 },
    });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/__location_test`);
    if (scenario === "denied") {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Browser.setPermission", {
        permission: { name: "geolocation" },
        setting: "denied",
        origin,
      });
    }
    let result = await page.evaluate(async (scenario) => {
      const recorder = await import("/src/recording.ts");
      const loc = await import("/src/recording-location.mjs");
      let calls = 0,
        callback,
        failure,
        errorCode = null,
        recordingStarted = false;
      const realStart = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...args) {
        realStart.apply(this, args);
        recordingStarted = this.state === "recording";
      };
      const original = navigator.geolocation.getCurrentPosition.bind(
        navigator.geolocation,
      );
      navigator.geolocation.getCurrentPosition = (ok, fail, options) => {
        if (!recordingStarted)
          throw Error("Location requested before recorder actually started");
        calls++;
        callback = ok;
        failure = (error) => {
          errorCode = error.code;
          fail(error);
        };
        if (!["timeout", "late-stop", "late-cancel"].includes(scenario))
          original(ok, failure, options);
      };
      const first = await recorder.startRecording("mic", () => {}, {
        recordLocation: scenario !== "off",
      });
      if (scenario === "off") {
        await new Promise((r) => setTimeout(r, 100));
      } else if (
        ["granted", "recovery", "sealed-recovery"].includes(scenario)
      ) {
        for (let i = 0; i < 100; i++) {
          if ((await recorder.listRecoverableSessions())[0]?.startLocation)
            break;
          await new Promise((r) => setTimeout(r, 25));
        }
      } else if (scenario === "timeout") failure?.({ code: 3 });
      await new Promise((r) => setTimeout(r, 1200));
      if (scenario.endsWith("recovery")) {
        await new Promise((r) => setTimeout(r, 3200));
        if (scenario === "sealed-recovery") await first.stop();
        const before = (await recorder.listRecoverableSessions())[0];
        return { calls, saved: before.startLocation, recoveryId: before.id };
      }
      const file =
        scenario === "late-cancel"
          ? (await first.cancel(), null)
          : await first.stop();
      if (scenario.startsWith("late")) {
        const second = await recorder.startRecording("mic", () => {}, {
          recordLocation: false,
        });
        callback?.({
          coords: { latitude: 1.234567, longitude: 2.345678, accuracy: 8 },
          timestamp: Date.now(),
        });
        await new Promise((r) => setTimeout(r, 1200));
        const secondFile = await second.stop();
        return {
          calls,
          location: file ? loc.getRecordingLocation(file) : null,
          nextLocation: loc.getRecordingLocation(secondFile),
          sessions: (await recorder.listRecoverableSessions()).length,
          bytes: secondFile.size,
        };
      }
      return {
        calls,
        errorCode,
        location: loc.getRecordingLocation(file),
        bytes: file.size,
        sessions: (await recorder.listRecoverableSessions()).length,
      };
    }, scenario);
    if (scenario.endsWith("recovery")) {
      await page.reload();
      result = {
        ...result,
        ...(await page.evaluate(
          async ({ id, interrupted }) => {
            const recorder = await import("/src/recording.ts"),
              loc = await import("/src/recording-location.mjs");
            if (interrupted) {
              let rejected = false;
              try {
                await recorder.recoverSession(id);
              } catch {
                rejected = true;
              }
              if (!rejected)
                throw Error(
                  "unsealed interrupted recording must not become a normal File",
                );
              const sessions = await recorder.listRecoverableSessions();
              const bytes = await new Promise((resolve) => {
                const q = indexedDB.open("kotonoha-recorder");
                q.onsuccess = () => {
                  const db = q.result,
                    req = db
                      .transaction("chunks")
                      .objectStore("chunks")
                      .index("bySession")
                      .getAll(id);
                  req.onsuccess = () => {
                    db.close();
                    resolve(req.result.reduce((n, c) => n + c.blob.size, 0));
                  };
                };
              });
              return {
                partialBlocked: true,
                location: sessions.find((s) => s.id === id)?.startLocation,
                bytes,
                sessions: sessions.length,
              };
            }
            const file = await recorder.recoverSession(id);
            return {
              location: loc.getRecordingLocation(file),
              bytes: file.size,
              sessions: (await recorder.listRecoverableSessions()).length,
            };
          },
          { id: result.recoveryId, interrupted: scenario === "recovery" },
        )),
      };
    }
    assert.equal(
      result.calls,
      scenario === "off" ? 0 : 1,
      `${scenario}: request only at actual start`,
    );
    assert.ok(result.bytes > 0, `${scenario}: recording continues`);
    if (scenario === "recovery")
      assert.equal(
        result.partialBlocked,
        true,
        "interrupted session preserves GPS/raw chunks without normal File recovery",
      );
    if (["granted", "recovery", "sealed-recovery"].includes(scenario)) {
      assert.equal(
        result.location?.latitude,
        1.234567,
        `${scenario}: bound location`,
      );
      assert.equal(result.location.longitude, 2.345678);
      assert.equal(result.location.accuracy, 8);
      assert.ok(Number.isFinite(Date.parse(result.location.capturedAt)));
      if (result.saved) assert.deepEqual(result.saved, result.location);
    } else assert.equal(result.location, null, `${scenario}: no location`);
    if (scenario.startsWith("late")) assert.equal(result.nextLocation, null);
    if (scenario === "denied")
      assert.equal(result.errorCode, 1, "real browser permission denial");
    if (scenario === "timeout")
      assert.equal(result.errorCode, 3, "timeout callback continues recording");
    if (result.sessions !== undefined)
      assert.equal(
        result.sessions,
        scenario === "late-stop" ? 2 : 1,
        "offline originals remain until receipt or explicit discard",
      );
    assert.deepEqual(errors, []);
    results.push({ scenario, pass: true, bytes: result.bytes });
    console.log(`PASS browser ${scenario}`);
    await context.close();
  }
  await writeFile(
    path.join(output, "browser-recording-results.json"),
    JSON.stringify(results, null, 2),
  );
} finally {
  await browser.close();
  await server.close();
}
