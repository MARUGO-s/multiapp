import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UploadSchema,
  uploadDocument,
} from "../supabase/functions/_shared/upload.mjs";
import {
  PatchSchema,
  minutesMarkdownPatch,
} from "../supabase/functions/_shared/domain.mjs";
import { exportMultipleMeetings } from "../src/meeting-exports.mjs";
import { summaryInput } from "../supabase/functions/_shared/summary.mjs";
import { minutesToMarkdown } from "../supabase/functions/_shared/domain.mjs";
export const point = {
  latitude: 35.123456,
  longitude: 139.123456,
  accuracy: 12,
  capturedAt: "2026-10-28T00:00:00.000Z",
};
const plan = () => ({
  metadata: { title: "架空の録音", date: "2026-10-28" },
  sources: [{ name: "sample.webm", size: 100, startLocation: point }],
  parts: [
    {
      name: "recording-1-1.m4a",
      size: 100,
      sourceIndex: 0,
      partNumber: 1,
      duration: 1,
    },
  ],
});
test("録音開始地点を原本sourceと会議に保存し旧uploadも受理する", () => {
  const parsed = UploadSchema.safeParse(plan());
  assert.equal(parsed.success, true, "正当な開始地点つきuploadが受理される");
  const doc = uploadDocument(parsed.data, "sample", "sample");
  assert.deepEqual(doc.sources[0].startLocation, point);
  assert.deepEqual(doc.recordingLocations, [{ sourceIndex: 0, ...point }]);
  const old = plan();
  delete old.sources[0].startLocation;
  assert.equal(UploadSchema.safeParse(old).success, true);
});
test("位置はnull指定で全件削除でき、sourceの重複も消し再送で設定できない", () => {
  const m = uploadDocument(UploadSchema.parse(plan()), "sample", "sample");
  const patch = PatchSchema.safeParse({ recordingLocations: null });
  assert.equal(patch.success, true, "削除専用PATCHを受理する");
  const next = { ...m, ...minutesMarkdownPatch(m, patch.data) };
  assert.deepEqual(next.recordingLocations, []);
  assert.equal(Object.hasOwn(next.sources[0], "startLocation"), false);
  assert.equal(next.sources[0].name, "sample.webm");
  assert.deepEqual(
    minutesMarkdownPatch(next, patch.data),
    minutesMarkdownPatch(m, patch.data),
  );
  for (const value of [[], [point], {}, false, 0, "null"])
    assert.equal(
      PatchSchema.safeParse({ recordingLocations: value }).success,
      false,
    );
  assert.equal(PatchSchema.safeParse({ sources: m.sources }).success, false);
});
test("書き出しJSONを含め全形式とAI入力に録音位置を自動で含めない", () => {
  const m = uploadDocument(UploadSchema.parse(plan()), "sample", "sample");
  m.transcript = "架空の会話";
  m.minutes = {
    summary: "要点",
    topics: [],
    decisions: [],
    actions: [],
    openQuestions: [],
  };
  m.markdown = minutesToMarkdown(m, m.minutes);
  for (const output of [
    summaryInput(m),
    m.markdown,
    m.transcript,
    ...["json", "md", "ics"].map((format) =>
      exportMultipleMeetings([m], format),
    ),
  ]) {
    const value = JSON.stringify(output);
    assert.doesNotMatch(
      value,
      /35\.123456|139\.123456|recordingLocations|startLocation/,
    );
  }
  assert.deepEqual(
    m.sources[0].startLocation,
    point,
    "書き出しは元データを破壊しない",
  );
});
test("位置入力は範囲・型・余分な住所や追跡データを厳密に拒否する", () => {
  for (const bad of [
    null,
    [],
    "point",
    { ...point, latitude: 91 },
    { ...point, longitude: -181 },
    { ...point, latitude: "35" },
    { ...point, accuracy: -1 },
    { ...point, accuracy: Infinity },
    { ...point, capturedAt: "yesterday" },
    { ...point, address: "禁止" },
  ]) {
    const input = plan();
    input.sources[0].startLocation = bad;
    assert.equal(UploadSchema.safeParse(input).success, false);
  }
});
