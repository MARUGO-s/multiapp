import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createApp } from "../server/app.mjs";
import { MeetingStore } from "../server/store.mjs";
import { createDemo } from "../supabase/functions/_shared/demo.mjs";
import { summaryInput } from "../supabase/functions/_shared/summary.mjs";

test("Local HTTP: 元のアクセス制限・厳密入力・保存/共有・全件削除・complete再送/再解析非復活", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kotonoha-location-http-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const seen = [];
  const instance = await createApp({
    dataDir,
    apiKey: "fixture-only-no-external-requests",
    aiFactory: () => ({
      async summarize(m) {
        seen.push(summaryInput(m));
        return {
          summary: "架空の要点",
          topics: [],
          decisions: [],
          actions: [],
          openQuestions: [],
        };
      },
      async transcribe() {
        throw Error("unexpected audio processing");
      },
    }),
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = (route, body, headers = {}) =>
    fetch(base + route, {
      method: body === undefined ? "GET" : "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Kotonoha": "1",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const point = {
    latitude: 1.234567,
    longitude: 2.345678,
    accuracy: 8,
    capturedAt: "2026-10-28T01:02:03.000Z",
  };
  const manifest = {
    metadata: { title: "架空の録音位置", date: "2026-10-28" },
    sources: [{ name: "a.webm", size: 100, startLocation: point }],
    parts: [
      {
        name: "recording-1-1.m4a",
        size: 4,
        sourceIndex: 0,
        partNumber: 1,
        duration: 1,
      },
    ],
  };
  const createdResponse = await fetch(`${base}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Kotonoha": "1" },
    body: JSON.stringify(manifest),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.deepEqual(created.recordingLocations, [{ sourceIndex: 0, ...point }]);
  assert.deepEqual(
    instance.store.get(created.id).sources[0].startLocation,
    point,
  );
  assert.equal(
    (await request(`/meetings/${created.id}`, { recordingLocations: null }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/meetings/${created.id}/parts?index=0`, {
        method: "POST",
        headers: {
          "X-Kotonoha": "1",
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array([0, 1, 2, 3]),
      })
    ).status,
    200,
  );
  assert.deepEqual(instance.store.get(created.id).recordingLocations, []);
  assert.equal(
    instance.store.get(created.id).sources[0].startLocation,
    undefined,
    "後続パート再送は位置を戻さない",
  );
  const m = {
    ...createDemo(),
    isDemo: false,
    source: "text",
    sources: [
      { name: "a.webm", size: 100, startLocation: point },
      { name: "b.webm", size: 200, startLocation: point },
    ],
    recordingLocations: [
      { sourceIndex: 0, ...point },
      { sourceIndex: 1, ...point },
    ],
  };
  await instance.store.save(m);
  const route = `/meetings/${m.id}`;
  assert.equal(
    (
      await request(
        route,
        { recordingLocations: null },
        { Origin: "https://untrusted.invalid" },
      )
    ).status,
    403,
  );
  assert.equal(instance.store.get(m.id).recordingLocations.length, 2);
  for (const body of [
    { recordingLocations: [] },
    { recordingLocations: [point] },
    { sources: m.sources },
  ])
    assert.equal((await request(route, body)).status, 400);
  assert.deepEqual(
    (await (await request(route)).json()).recordingLocations,
    m.recordingLocations,
  );
  assert.equal(
    (await request(route, { recordingLocations: null })).status,
    200,
  );
  let saved = await (await request(route)).json();
  assert.deepEqual(saved.recordingLocations, []);
  assert.ok(saved.sources.every((s) => !Object.hasOwn(s, "startLocation")));
  assert.equal(
    (await request(route, { recordingLocations: null })).status,
    200,
    "削除再送は冪等",
  );
  assert.equal(
    (
      await fetch(`${base}${route}/complete`, {
        method: "POST",
        headers: { "X-Kotonoha": "1" },
      })
    ).status,
    202,
  );
  assert.equal(
    (
      await fetch(`${base}${route}/retry`, {
        method: "POST",
        headers: { "X-Kotonoha": "1" },
      })
    ).status,
    202,
  );
  await instance.waitForJobs();
  const reopened = new MeetingStore(path.join(dataDir, "meetings"));
  await reopened.init();
  saved = reopened.get(m.id);
  assert.equal(saved.status, "done");
  assert.deepEqual(saved.recordingLocations, []);
  assert.ok(saved.sources.every((s) => !Object.hasOwn(s, "startLocation")));
  assert.doesNotMatch(
    await readFile(path.join(dataDir, "meetings", `${m.id}.json`), "utf8"),
    /1\.234567|2\.345678|startLocation/,
  );
  assert.doesNotMatch(
    JSON.stringify(seen),
    /1\.234567|2\.345678|recordingLocations|startLocation/,
  );
});
