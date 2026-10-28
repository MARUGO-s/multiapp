import { test } from "node:test";
import assert from "node:assert/strict";
const location = await import("../src/recording-location.mjs").catch(
  () => ({}),
);
const position = {
  coords: { latitude: 1.234567, longitude: 2.345678, accuracy: 8 },
  timestamp: Date.parse("2026-10-28T01:02:03Z"),
};
test("opt-in時だけ単発取得し、stop/cancel後の遅延応答を別録音に適用しない", () => {
  assert.equal(
    typeof location.captureRecordingLocation,
    "function",
    "session scoped capture API",
  );
  const callbacks = [],
    seen = [];
  const geolocation = {
    getCurrentPosition(ok, fail, options) {
      callbacks.push({ ok, fail, options });
    },
  };
  location.captureRecordingLocation({
    enabled: false,
    geolocation,
    onLocation: (p) => seen.push(p),
  });
  assert.equal(callbacks.length, 0);
  const cancel = location.captureRecordingLocation({
    enabled: true,
    geolocation,
    onLocation: (p) => seen.push(["old", p]),
  });
  assert.equal(callbacks.length, 1);
  assert.deepEqual(callbacks[0].options, {
    enableHighAccuracy: false,
    maximumAge: 0,
    timeout: 10000,
  });
  cancel();
  location.captureRecordingLocation({
    enabled: true,
    geolocation,
    onLocation: (p) => seen.push(["new", p]),
  });
  callbacks[0].ok(position);
  assert.deepEqual(seen, []);
  callbacks[1].ok(position);
  assert.deepEqual(seen, [
    [
      "new",
      {
        latitude: 1.234567,
        longitude: 2.345678,
        accuracy: 8,
        capturedAt: "2026-10-28T01:02:03.000Z",
      },
    ],
  ]);
  callbacks[1].ok(position);
  assert.equal(seen.length, 1, "一回のみ");
});
test("Fileの並替え・変換・復元用metadataをsourceIndexに対応付ける", () => {
  assert.equal(
    typeof location.rememberRecordingLocation,
    "function",
    "file association API",
  );
  const a = new File(["a"], "a.webm"),
    b = new File(["b"], "b.webm");
  const point = {
    latitude: 1.234567,
    longitude: 2.345678,
    accuracy: 8,
    capturedAt: "2026-10-28T01:02:03.000Z",
  };
  location.rememberRecordingLocation(a, point);
  const converted = new File(["converted"], "a.m4a");
  location.rememberRecordingLocation(
    converted,
    location.getRecordingLocation(a),
  );
  const payload = JSON.stringify([
    location.getRecordingLocation(b),
    location.getRecordingLocation(converted),
  ]);
  assert.deepEqual(
    location.sourcesWithRecordingLocations([b, converted], payload),
    [
      { name: "b.webm", size: 1 },
      { name: "a.m4a", size: 9, startLocation: point },
    ],
  );
  assert.deepEqual(location.sourcesWithRecordingLocations([a], null), [
    { name: "a.webm", size: 1 },
  ]);
  for (const bad of ["{}", "[{}]", "[]", "[null,null]"])
    assert.throws(() => location.sourcesWithRecordingLocations([a], bad));
});
test("deny・timeout・不正な位置でも例外を漏らさず録音を妨げない", () => {
  for (const errorCode of [1, 3]) {
    let success,
      fail,
      seen = 0;
    location.captureRecordingLocation({
      enabled: true,
      geolocation: {
        getCurrentPosition(ok, bad) {
          success = ok;
          fail = bad;
        },
      },
      onLocation() {
        seen++;
      },
    });
    fail({ code: errorCode });
    success(position);
    assert.equal(seen, 0);
  }
  for (const bad of [
    null,
    {},
    { ...position, timestamp: NaN },
    { ...position, coords: { ...position.coords, latitude: 99 } },
  ]) {
    let callback,
      seen = 0;
    location.captureRecordingLocation({
      enabled: true,
      geolocation: {
        getCurrentPosition(ok) {
          callback = ok;
        },
      },
      onLocation() {
        seen++;
      },
    });
    assert.doesNotThrow(() => callback(bad));
    assert.equal(seen, 0);
  }
  assert.doesNotThrow(() =>
    location.captureRecordingLocation({
      enabled: true,
      geolocation: {
        getCurrentPosition() {
          throw Error("unsupported");
        },
      },
      onLocation() {
        throw Error("unexpected");
      },
    }),
  );
});
