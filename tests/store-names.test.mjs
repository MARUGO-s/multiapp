import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  GROUP_STORE_NAMES,
  STORE_NAME_GUIDANCE,
  applyStoreNameFixes,
} from "../supabase/functions/_shared/store-names.mjs";
import {
  AllFormatsMinutesSchema,
  minutesResult,
  parseMinutes,
  summaryInput,
} from "../supabase/functions/_shared/summary.mjs";
import { createDemo } from "../server/demo.mjs";
import { minutesBundle } from "./fixtures/minutes-bundle.mjs";

test("store list holds every group store from the company site, in katakana", () => {
  assert.equal(GROUP_STORE_NAMES.length, 24);
  assert.equal(new Set(GROUP_STORE_NAMES).size, 24);
  for (const name of ["マルゴ", "マルゴ セカンド", "マルゴ オット", "クラウディア2", "ミタン", "ブルネロ", "サンナナイチ バル", "バルペロタ"])
    assert.ok(GROUP_STORE_NAMES.includes(name), name);
  // Keywords for GPT Transcribe must be single-line and free of < >.
  for (const name of GROUP_STORE_NAMES) assert.doesNotMatch(name, /[<>\r\n]/);
  assert.doesNotMatch(GROUP_STORE_NAMES.join(""), /ぺ/, "katakana ペ, not hiragana ぺ");
});

test("minutes prompt carries the store list and the rules for misheard names", () => {
  const meeting = { ...createDemo(), template: "standard" };
  const system = summaryInput(meeting)[0].content;
  assert.ok(system.includes(STORE_NAME_GUIDANCE));
  for (const name of GROUP_STORE_NAMES) assert.ok(system.includes(name), name);
  assert.match(system, /丸5/);
  assert.match(system, /地名だけの言及/);
});

test("output schema asks for store-name fixes limited to the official names", () => {
  const schema = z.toJSONSchema(AllFormatsMinutesSchema);
  assert.ok(schema.required.includes("storeNameFixes"));
  const item = schema.properties.storeNameFixes.items;
  assert.deepEqual(item.required, ["heard", "store"]);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.properties.store.enum, [...GROUP_STORE_NAMES]);
});

test("misheard store names are corrected in the transcript, longest first, in one pass", () => {
  const transcript = "小暮さんの店舗、丸5セカンドと丸5オットは原価率が低い。丸5も見習う。丸の内も人員不足。";
  const { transcript: fixed, applied } = applyStoreNameFixes(transcript, [
    { heard: "丸5", store: "マルゴ" },
    { heard: "丸5セカンド", store: "マルゴ セカンド" },
    { heard: "丸5オット", store: "マルゴ オット" },
  ]);
  assert.equal(fixed, "小暮さんの店舗、マルゴ セカンドとマルゴ オットは原価率が低い。マルゴも見習う。丸の内も人員不足。");
  assert.deepEqual(applied, [
    { heard: "丸5セカンド", store: "マルゴ セカンド", count: 1 },
    { heard: "丸5オット", store: "マルゴ オット", count: 1 },
    { heard: "丸5", store: "マルゴ", count: 1 },
  ]);
});

test("fixes that are unsafe or not in the transcript change nothing", () => {
  const transcript = "マルゴ丸の内と丸の内エリアの話。";
  const { transcript: fixed, applied } = applyStoreNameFixes(transcript, [
    { heard: "丸の内", store: "マルゴ丸の内" }, // part of an official name
    { heard: "マルゴ", store: "焼肉マルゴ" }, // already a correct name
    { heard: "丸5", store: "マルゴ" }, // not in the transcript
    { heard: "話", store: "存在しない店" }, // not a group store
    { heard: "", store: "マルゴ" },
    { heard: "あ".repeat(21), store: "マルゴ" },
    { heard: "話\n", store: "マルゴ" },
    null,
  ]);
  assert.equal(fixed, transcript);
  assert.deepEqual(applied, []);
  assert.deepEqual(applyStoreNameFixes("本文", undefined), { transcript: "本文", applied: [] });
});

test("minutes result returns the corrected transcript and keeps fixes out of the minutes", () => {
  const meeting = { ...createDemo(), template: "standard", isDemo: false, transcript: "話者0: 丸5オットの原価率は27%。" };
  const raw = { ...minutesBundle(meeting.minutes), storeNameFixes: [{ heard: "丸5オット", store: "マルゴ オット" }] };
  const result = minutesResult(meeting, raw);
  assert.equal(result.transcript, "話者0: マルゴ オットの原価率は27%。");
  assert.deepEqual(result.storeNameFixes, [{ heard: "丸5オット", store: "マルゴ オット", count: 1 }]);
  assert.equal(Object.hasOwn(result.minutes, "storeNameFixes"), false);
  assert.deepEqual(result.minutes, parseMinutes(meeting, raw));
});

test("earlier fixes are kept when the minutes are made again", () => {
  const meeting = {
    ...createDemo(), template: "standard", isDemo: false,
    transcript: "丸ごグランデの件。",
    storeNameFixes: [{ heard: "丸5", store: "マルゴ", count: 2 }],
  };
  const raw = { ...minutesBundle(meeting.minutes), storeNameFixes: [{ heard: "丸ごグランデ", store: "マルゴ グランデ" }] };
  assert.deepEqual(minutesResult(meeting, raw).storeNameFixes, [
    { heard: "丸5", store: "マルゴ", count: 2 },
    { heard: "丸ごグランデ", store: "マルゴ グランデ", count: 1 },
  ]);
});

test("responses without fixes, and responses started before this change, leave the transcript alone", () => {
  const meeting = { ...createDemo(), template: "standard", isDemo: false };
  const { storeNameFixes: _none, ...before } = minutesBundle(meeting.minutes);
  for (const raw of [before, minutesBundle(meeting.minutes)]) {
    const result = minutesResult(meeting, raw);
    assert.deepEqual(Object.keys(result), ["minutes"]);
  }
});
