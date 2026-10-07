import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AllFormatsMinutesSchema, parseMinutes, summaryInput } from "../supabase/functions/_shared/summary.mjs";
import { minutesDocuments, minutesForFormat, minutesMarkdownPatch, PatchSchema } from "../supabase/functions/_shared/domain.mjs";
import { minutesView } from "../src/minutes-views.mjs";
import { createDemo } from "../server/demo.mjs";
import { minutesBundle } from "./fixtures/minutes-bundle.mjs";

const meeting = () => ({ ...createDemo(), template: "standard", isDemo: false });
function generated() {
  const m = meeting();
  const minutes = parseMinutes(m, minutesBundle(m.minutes));
  return { ...m, minutes, ...minutesDocuments(m, minutes) };
}
test("1入力で3形式を指示し、共通の決定・担当・期限・予定は1組だけ要求する", () => {
  const m = meeting();
  m.transcript = "原文だけの一意な文字列";
  const input = summaryInput(m);
  assert.equal(input.length, 2);
  assert.equal(input.map(i => i.content).join("").split(m.transcript).length - 1, 1);
  assert.match(input[0].content, /1回の応答で同時に作成/);
  const schema = z.toJSONSchema(AllFormatsMinutesSchema);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.formats.required, ["brief", "standard", "detailed"]);
  for (const format of Object.values(schema.properties.formats.properties)) {
    assert.equal(format.additionalProperties, false);
    assert.deepEqual(format.required, ["summary", "topics"]);
    assert.equal(format.properties.actions, undefined);
  }
});
test("3形式を保存し、タブ選択は元データを変更せず共通の作業と日付を維持する", () => {
  const m = generated();
  const before = structuredClone(m);
  for (const format of ["brief", "standard", "detailed"]) {
    const view = minutesView(m, format);
    assert.equal(view.format, format);
    assert.equal(view.available.length, 3);
    assert.equal(view.markdown, m.markdownByFormat[format]);
    assert.equal(minutesForFormat(m.minutes, format).actions, m.minutes.actions);
    assert.equal(minutesForFormat(m.minutes, format).scheduleEvents, m.minutes.scheduleEvents);
    for (const a of m.minutes.actions) {
      assert.ok(view.markdown.includes(a.owner));
      assert.ok(view.markdown.includes(a.due));
    }
  }
  assert.equal(m.markdown, m.markdownByFormat.standard);
  assert.notEqual(m.markdownByFormat.brief, m.markdownByFormat.detailed);
  assert.deepEqual(m, before);
  assert.deepEqual(parseMinutes(m, m.minutes), m.minutes, "Nodeの二重parseでも形式を失わない");
});
test("1形式の編集は別の本文・AI抽出値・完了状態を変更せず、旧クライアントも対応する", () => {
  const m = generated();
  const patch = minutesMarkdownPatch(m, PatchSchema.parse({ markdown: "詳細だけ手動修正", markdownFormat: "detailed" }));
  assert.equal(patch.markdownFormat, undefined);
  const next = { ...m, ...patch };
  assert.equal(minutesView(next, "detailed").markdown, "詳細だけ手動修正");
  assert.equal(minutesView(next, "brief").markdown, m.markdownByFormat.brief);
  assert.equal(next.markdown, m.markdown);
  assert.equal(next.minutes, m.minutes);
  assert.equal(next.completedActions, m.completedActions);
  const oldClient = minutesMarkdownPatch(m, { markdown: "標準の編集" });
  assert.equal(oldClient.markdown, "標準の編集");
  assert.equal(oldClient.markdownByFormat.standard, "標準の編集");
});
test("会議名の変更は全形式の一致する先頭見出しだけ更新する", () => {
  const m = generated();
  const patch = minutesMarkdownPatch(m, { title: "会議名を変更" });
  for (const md of Object.values(patch.markdownByFormat)) assert.ok(md.startsWith("# 会議名を変更\n"));
  assert.equal(patch.markdown, patch.markdownByFormat.standard);
});
test("以前の生成結果と手書き本文は自動変換せず、欠けた形式を偽装しない", () => {
  const m = meeting();
  m.markdown = "手書きの本文";
  assert.equal(minutesView(m, "brief").markdown, "手書きの本文");
  assert.equal(minutesView(m, "brief").format, "standard");
  assert.deepEqual(minutesView(m, "brief").available, []);
  assert.deepEqual(minutesMarkdownPatch(m, { markdown: "旧形式の修正" }), { markdown: "旧形式の修正" });
  assert.throws(() => minutesMarkdownPatch(m, { markdown: "修正", markdownFormat: "brief" }), /Missing minutes format/);
  assert.equal(minutesDocuments(m, parseMinutes(m, m.minutes)).markdownByFormat, null);
});
test("部分的な3形式や不正な編集指定を拒否する", () => {
  const m = meeting(), bundle = minutesBundle(m.minutes);
  delete bundle.formats.brief;
  assert.throws(() => parseMinutes(m, bundle));
  for (const patch of [{ markdownFormat: "brief" }, { markdown: "x", markdownFormat: "invalid" }, { markdownByFormat: { brief: "任意の上書き" } }])
    assert.equal(PatchSchema.safeParse(patch).success, false);
});
