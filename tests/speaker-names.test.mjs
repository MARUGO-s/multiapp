import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySpeakerNames,
  cleanSpeakerNames,
  recordingCount,
  speakerKey,
  transcriptSpeakers,
  transcriptWithNames,
} from "../src/speaker-names.mjs";

const two = [
  "【録音 1】",
  "[00:01] 話者0：始めます。",
  "[00:05] 話者1：はい。",
  "[00:09] 話者0：次です。",
  "",
  "【録音 2】",
  "[00:00] 話者0：後半です。",
  "[00:04] 話者10：質問です。",
].join("\n");

test("speakers are listed per recording, because numbers restart in each one", () => {
  assert.deepEqual(transcriptSpeakers(two), [
    { key: "録音1:話者0", recording: 1, speaker: "話者0", turns: 2 },
    { key: "録音1:話者1", recording: 1, speaker: "話者1", turns: 1 },
    { key: "録音2:話者0", recording: 2, speaker: "話者0", turns: 1 },
    { key: "録音2:話者10", recording: 2, speaker: "話者10", turns: 1 },
  ]);
  assert.equal(recordingCount(two), 2);
  assert.deepEqual(transcriptSpeakers("話者0：単独の録音\n話者1：はい"), [
    { key: "録音1:話者0", recording: 1, speaker: "話者0", turns: 1 },
    { key: "録音1:話者1", recording: 1, speaker: "話者1", turns: 1 },
  ]);
  assert.deepEqual(transcriptSpeakers("話者のいない文字起こし"), []);
});

test("downloaded transcript shows names only for the matching recording", () => {
  const names = { [speakerKey(1, "話者0")]: "佐藤", [speakerKey(2, "話者10")]: "鈴木" };
  assert.equal(
    transcriptWithNames(two, names),
    [
      "【録音 1】",
      "[00:01] 佐藤：始めます。",
      "[00:05] 話者1：はい。",
      "[00:09] 佐藤：次です。",
      "",
      "【録音 2】",
      "[00:00] 話者0：後半です。",
      "[00:04] 鈴木：質問です。",
    ].join("\n"),
  );
  // Speaker numbers inside the spoken text are not touched.
  assert.equal(transcriptWithNames("話者0：話者1さんに聞きます", { "録音1:話者0": "佐藤" }), "佐藤：話者1さんに聞きます");
});

test("minutes names follow 「話者N（録音K）」, and bare numbers only with one recording", () => {
  const names = { "録音1:話者0": "佐藤", "録音2:話者0": "田中" };
  const minutes = "| 資料を送る | 話者0（録音1） | 後ほど |\n- 話者0（録音2）が説明した。話者0(録音 1)も同意。";
  assert.equal(applySpeakerNames(minutes, names, 2), "| 資料を送る | 佐藤 | 後ほど |\n- 田中が説明した。佐藤も同意。");
  assert.equal(applySpeakerNames("話者0が説明。話者0（録音2）も。", names, 2), "話者0が説明。田中も。");
  assert.equal(applySpeakerNames("話者0が説明。話者01ではない。", names, 1), "佐藤が説明。話者01ではない。");
  assert.equal(applySpeakerNames("話者1（録音1）", names, 2), "話者1（録音1）", "unnamed speakers keep their number");
  assert.equal(applySpeakerNames("本文", {}, 1), "本文");
  assert.equal(applySpeakerNames(null, names, 1), null);
});

test("blank names are dropped so the number shows again; names are trimmed", () => {
  assert.deepEqual(cleanSpeakerNames({ "録音1:話者0": " 佐藤 ", "録音1:話者1": "  ", "録音2:話者0": "" }), { "録音1:話者0": "佐藤" });
  assert.equal(cleanSpeakerNames({ k: "あ".repeat(150) }).k.length, 100);
});
