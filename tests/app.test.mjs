import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { get as httpGet } from "node:http";
import { createApp } from "../server/app.mjs";
import { createDemo } from "../server/demo.mjs";
import { MeetingStore } from "../server/store.mjs";
import { createAI } from "../server/ai.mjs";
import { summaryRange } from "../supabase/functions/_shared/insights.mjs";
import { MAX_FILE_SIZE } from "../server/domain.mjs";
import { aacFixture } from "./fixtures/aac.mjs";
import { splitRecordings } from "../src/split-recordings.mjs";
import { randomUUID } from "node:crypto";
import { documentFixtures } from "./fixtures/documents.mjs";
import { attachmentDigest } from "../supabase/functions/_shared/attachments.mjs";
import {
  calendarMeeting,
  calendarEvent,
  editFields,
} from "./fixtures/calendar.mjs";
import { allCalendarEvents, eventKey } from "../supabase/functions/_shared/calendar.mjs";
import { summaryInput } from "../supabase/functions/_shared/summary.mjs";

test("再生成時に詳しさを変更・保存し、文字起こしは再利用する", async (t) => {
  const seen = [];
  let transcriptions = 0;
  const { request, store, waitForJobs, dataDir } = await setup(t, {
    apiKey: key,
    aiFactory: () => ({
      async transcribe() { transcriptions++; throw new Error("再文字起こし不要"); },
      async summarize(meeting) {
        seen.push(meeting.template);
        assert.equal(meeting.transcript, "保存済みの会話");
        assert.match(summaryInput(meeting)[0].content, { detailed: /背景、理由、異論も詳しく/, brief: /要点を簡潔に/, standard: /要点を適度に詳しく/ }[meeting.template]);
        return { ...sampleMinutes, summary: `再生成：${meeting.template}` };
      },
    }),
  });
  const meeting = { ...createDemo(), isDemo: false, source: "audio", audioFile: "already.wav", transcript: "保存済みの会話", tags: ["既存タグ"], completedActions: [0] };
  await store.save(meeting);
  const route = `/meetings/${meeting.id}/retry`;
  for (const body of [JSON.stringify({template: "detailed"}), JSON.stringify({template: "standard"}), JSON.stringify({template: "brief"}), undefined]) {
    const response = await request(route, { method: "POST", body });
    assert.equal(response.status, 202);
    await waitForJobs();
    const saved = store.get(meeting.id);
    assert.equal(saved.status, "done");
    assert.match(saved.markdown, new RegExp(`再生成：${saved.template}`));
    assert.deepEqual(saved.tags, ["既存タグ"]);
    assert.deepEqual(saved.completedActions, []);
  }
  assert.deepEqual(seen, ["detailed", "standard", "brief", "brief"]);
  assert.equal(transcriptions, 0);
  const reloaded = new MeetingStore(path.join(dataDir, "meetings"));
  await reloaded.init();
  assert.equal(reloaded.get(meeting.id).template, "brief");
  const before = structuredClone(store.get(meeting.id));
  for (const body of ['{"template":"invalid"}', '{"template":null}', '{"template":"standard","status":"done"}', 'null']) {
    assert.equal((await request(route, { method: "POST", body })).status, 400);
    assert.deepEqual(store.get(meeting.id), before);
  }
  assert.equal(seen.length, 4);
});

test("会議一覧と詳細で分割録音の合計時間を返し、内部音声情報は公開しない", async (t) => {
  const { request, store } = await setup(t);
  const meeting = { ...createDemo(), duration: null, uploadPlan: [{}, {}], audioParts: [{ duration: 600 }, { duration: 33.626122 }] };
  await store.save(meeting);
  const detail = await (await request(`/meetings/${meeting.id}`)).json();
  const list = await (await request("/meetings")).json();
  for (const result of [detail, list.find(m => m.id === meeting.id)]) {
    assert.equal(result.duration, 633.626122);
    assert.equal(result.audioParts, undefined);
    assert.equal(result.uploadPlan, undefined);
  }
  assert.equal(store.get(meeting.id).duration, null);
});

test("予定と議事録本文の手動編集を永続化し、再生成でも予定の変更を保持する", async (t) => {
  const { request, store, waitForJobs, dataDir } = await setup(t, {
    apiKey: key,
    aiFactory: () => ({ summarize: async () => calendarMeeting().minutes }),
  });
  const m = calendarMeeting();
  await store.save(m);
  const route = `/meetings/${m.id}`,
    id = eventKey(calendarEvent),
    edit = {
      ...editFields(calendarEvent),
      date: "2026-10-16",
      location: "オンライン",
    };
  const patch = (body) => ({ method: "PATCH", body: JSON.stringify(body) });
  assert.equal(
    (await request(`${route}/calendar/${id}`, patch(edit))).status,
    200,
  );
  const saved = await (await request(route)).json();
  assert.equal(saved.calendarOverrides[id].event.date, edit.date);
  assert.equal(saved.markdown, m.markdown);
  assert.equal(
    (
      await request(
        route,
        patch({ markdown: "# 手動修正した議事録\n決定事項を追記" }),
      )
    ).status,
    200,
  );
  assert.equal(
    store.get(m.id).markdown,
    "# 手動修正した議事録\n決定事項を追記",
  );
  assert.equal(
    store.get(m.id).calendarOverrides[id].event.location,
    "オンライン",
  );
  const reloaded = new MeetingStore(path.join(dataDir, "meetings"));
  await reloaded.init();
  assert.deepEqual(
    reloaded.get(m.id).calendarOverrides,
    store.get(m.id).calendarOverrides,
  );
  assert.equal(
    (
      await request(
        `${route}/calendar/${id}`,
        patch({ ...edit, endTime: "12:00" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await request(`${route}/calendar/0000000000000000`, patch(edit))).status,
    404,
  );
  assert.equal(
    (await request(`${route}/retry`, { method: "POST" })).status,
    202,
  );
  await waitForJobs();
  assert.equal(store.get(m.id).calendarOverrides[id].event.date, "2026-10-16");
  await store.save({ ...store.get(m.id), status: "analyzing" });
  assert.equal(
    (await request(`${route}/calendar/${id}`, patch(edit))).status,
    409,
  );
  await store.save({ ...store.get(m.id), status: "done" });
  assert.equal(
    (await request(`${route}/calendar/${id}`, { method: "DELETE" })).status,
    200,
  );
  assert.deepEqual(store.get(m.id).calendarOverrides, {});
});

test("個別・複数予定の削除と復元は会議録を残して永続化する", async (t) => {
  const { request, store, dataDir } = await setup(t);
  const meeting = calendarMeeting();
  const second = { ...calendarEvent, title: "追加の予定" };
  meeting.minutes.scheduleEvents.push(second);
  await store.save(meeting);
  const route = `/meetings/${meeting.id}/calendar`;
  const ids = [calendarEvent, second].map(eventKey);
  for (const id of ids) {
    const response = await request(`${route}/${id}/hide`, { method: "POST" });
    assert.equal(response.status, 200);
  }
  assert.equal(allCalendarEvents(store.list()).length, 0);
  assert.equal(store.get(meeting.id).minutes.scheduleEvents.length, 2);
  const reopened = new MeetingStore(path.join(dataDir, "meetings"));
  await reopened.init();
  assert.equal(allCalendarEvents(reopened.list()).length, 0);
  assert.equal((await request(`${route}/${ids[0]}/restore`, { method: "POST" })).status, 200);
  assert.equal(allCalendarEvents(store.list()).length, 1);
  assert.equal((await request(`${route}/${ids[0]}/restore`, { method: "POST" })).status, 404);
  assert.equal((await request(`${route}/0000000000000000/hide`, { method: "POST" })).status, 404);
  await store.save({ ...store.get(meeting.id), status: "analyzing" });
  assert.equal((await request(`${route}/${ids[1]}/restore`, { method: "POST" })).status, 409);
});

const sampleMinutes = createDemo().minutes;
const key = "sk-test-only-not-a-real-api-key";

test("資料を全件保存後に会話だけを解析し、原本ダウンロード・再生成・関連解除・復元用保持ができる", async (t) => {
  const fixtures = documentFixtures(),
    attachmentPlan = await Promise.all(fixtures.map(async (f) => ({
      id: randomUUID(),
      name: f.name,
      size: f.size,
      sha256: await attachmentDigest(await f.arrayBuffer()),
    })));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let summaries = 0;
  const { request, store, dataDir, waitForJobs } = await setup(t, {
    apiKey: key,
    aiFactory: () => ({
      transcribe: async () => {
        throw new Error("Text-only meeting must not transcribe");
      },
      summarize: async (...args) => {
        summaries++;
        assert.equal(args.length, 2, "attachments are not passed to the AI");
        assert.equal(typeof args[1], "function");
        await gate;
        return sampleMinutes;
      },
    }),
  });
  try {
    const created = await request("/uploads", {
      method: "POST",
      body: JSON.stringify({
        metadata: { title: "資料付き会議", date: "2026-09-23" },
        sources: [],
        parts: [],
        transcript: "会議では開始日を10月15日に決定。予算60万円。広告は保留。",
        attachments: attachmentPlan,
      }),
    });
    assert.equal(created.status, 201);
    const draft = await created.json();
    const route = `/meetings/${draft.id}`;
    const upload = (file, id) => {
      const form = new FormData();
      form.set("attachment", file);
      form.set("id", id);
      return request(`${route}/attachments`, { method: "POST", body: form });
    };
    assert.equal(
      (await request(`${route}/complete`, { method: "POST" })).status,
      409,
    );
    assert.equal((await upload(fixtures[0], randomUUID())).status, 400);
    const sameContentDifferentName = new File(
      [await fixtures[0].arrayBuffer()], "別名.pdf", { type: "application/pdf" });
    for (const [i, file] of fixtures.entries()) {
      const result = await upload(i === 0 ? sameContentDifferentName : file, attachmentPlan[i].id);
      assert.equal(result.status, 201, await result.clone().text());
      const body = await result.json();
      assert.equal(body.attachments[i].name, file.name);
      assert.equal(body.attachments[i].localFile, undefined);
      assert.equal(body.attachmentPlan, undefined);
    }
    assert.equal(summaries, 0);
    assert.equal((await upload(fixtures[0], attachmentPlan[0].id)).status, 409);
    const downloaded = await request(
      `${route}/attachments/${attachmentPlan[0].id}`,
    );
    assert.match(downloaded.headers.get("content-disposition"), /attachment/);
    assert.deepEqual(
      new Uint8Array(await downloaded.arrayBuffer()),
      new Uint8Array(await fixtures[0].arrayBuffer()),
    );
    assert.equal(
      (await request(`${route}/complete`, { method: "POST" })).status,
      202,
    );
    assert.equal(
      (await upload(new File(["hello"], "note.txt"), randomUUID())).status,
      409,
    );
    assert.equal(
      (
        await request(`${route}/attachments/${attachmentPlan[0].id}`, {
          method: "DELETE",
        })
      ).status,
      409,
    );
    release();
    await waitForJobs();
    assert.equal(store.get(draft.id).status, "done");
    assert.equal(summaries, 1);
    assert.equal(store.get(draft.id).minutes.documentReview, undefined);
    assert.doesNotMatch(store.get(draft.id).markdown, /添付資料との照合/);
    assert.equal(store.get(draft.id).attachments.length, 3);
    const removed = await request(
      `${route}/attachments/${attachmentPlan[0].id}`,
      { method: "DELETE" },
    );
    assert.equal(removed.status, 200);
    const result = await removed.json();
    assert.equal(result.minutesStale, false);
    assert.equal(result.attachments.length, 2);
    assert.equal(result.removedAttachments, undefined);
    assert.equal(
      (await request(`${route}/attachments/${attachmentPlan[0].id}`)).status,
      404,
    );
    assert.equal(
      (await readdir(path.join(dataDir, "attachments"))).length,
      3,
      "unlinked document is retained",
    );
    const added = await upload(
      new File(["追加の参考資料"], "note.txt"),
      randomUUID(),
    );
    assert.equal(added.status, 201);
    assert.equal((await added.json()).minutesStale, false);
    assert.equal(
      (await request(`${route}/retry`, { method: "POST" })).status,
      202,
    );
    await waitForJobs();
    assert.equal(summaries, 2);
    assert.equal(store.get(draft.id).minutesStale, false);
    assert.equal(store.get(draft.id).minutes.documentReview, undefined);
    const saved = store.get(draft.id);
    assert.equal((await request(route, { method: "DELETE" })).status, 204);
    for (const f of [...saved.attachments, ...saved.removedAttachments])
      assert.ok(
        (await readFile(path.join(dataDir, "trash", draft.id, f.localFile)))
          .length,
      );
  } finally {
    release();
  }
});

test("偽装資料・容量超過は保存せず、保存済み資料があっても会話だけで議事録を作る", async (t) => {
  const { request, store, waitForJobs, dataDir } = await setup(t, {
    apiKey: key,
    aiFactory: () => ({ summarize: async () => sampleMinutes }),
  });
  const meeting = {
    ...createDemo(),
    id: randomUUID(),
    isDemo: false,
    status: "done",
    attachments: [],
  };
  await store.save(meeting);
  const route = `/meetings/${meeting.id}/attachments`;
  const upload = (file) => {
    const form = new FormData();
    form.set("id", randomUUID());
    form.set("attachment", file);
    return request(route, { method: "POST", body: form });
  };
  assert.equal((await upload(new File(["not pdf"], "fake.pdf"))).status, 400);
  assert.equal(
    (await upload(new File([new Uint8Array(10_000_001)], "too-big.txt")))
      .status,
    400,
  );
  assert.deepEqual(await readdir(path.join(dataDir, "attachments")), []);
  assert.equal((await upload(documentFixtures()[0])).status, 201);
  assert.equal(
    (await request(`/meetings/${meeting.id}/retry`, { method: "POST" })).status,
    202,
  );
  await waitForJobs();
  assert.equal(store.get(meeting.id).status, "done");
  assert.equal(store.get(meeting.id).transcript, meeting.transcript);
  assert.equal(store.get(meeting.id).minutes.documentReview, undefined);
  assert.equal(store.get(meeting.id).attachments.length, 1);
});

test("段階アップロードは全音声保存後だけ開始し、順序・欠損・二重完了を検証する", async (t) => {
  const calls = [];
  const { request, waitForJobs, store } = await setup(t, {
    apiKey: key,
    aiFactory: () => ({
      transcribe: async (file) => {
        calls.push(file);
        return { transcript: `会話${calls.length}` };
      },
      summarize: async () => sampleMinutes,
    }),
  });
  const file = new File([aacFixture, aacFixture], "前後.aac");
  const parts = await splitRecordings([file], () => {}, { durationLimit: 0.1 });
  const manifest = {
    metadata: { title: "分割統合", date: "2026-09-23" },
    sources: [{ name: file.name, size: file.size }],
    parts: parts.map(({ name, blob, sourceIndex, partNumber, duration }) => ({
      name,
      size: blob.size,
      sourceIndex,
      partNumber,
      duration,
    })),
  };
  const response = await request("/uploads", {
    method: "POST",
    body: JSON.stringify(manifest),
  });
  assert.equal(response.status, 201);
  const draft = await response.json();
  assert.equal(draft.uploadPlan, undefined);
  assert.equal(
    (await request(`/meetings/${draft.id}/complete`, { method: "POST" }))
      .status,
    409,
  );
  for (const [i, p] of parts.entries()) {
    assert.equal(
      (
        await request(`/meetings/${draft.id}/parts?index=${i}`, {
          method: "POST",
          body: p.blob,
          headers: { "Content-Type": p.blob.type },
        })
      ).status,
      200,
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(
    (await request(`/meetings/${draft.id}/complete`, { method: "POST" }))
      .status,
    202,
  );
  await waitForJobs();
  assert.equal(store.get(draft.id).status, "done");
  assert.equal(calls.length, parts.length);
  assert.equal(
    (await request(`/meetings/${draft.id}/complete`, { method: "POST" }))
      .status,
    202,
  );
  assert.equal(calls.length, parts.length);
  assert.ok(store.get(draft.id).transcript.endsWith(`会話${parts.length}`));
});

test("追加AI機能: 現在の接続設定・期間・使用料・タグの再読込を検証する", async (t) => {
  const calls = [];
  let incomplete = false;
  const { request, store, dataDir } = await setup(t, {
    aiFactory: (apiKey, model, options) => createAI(apiKey, model, { ...options, fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ body, authorization: new Headers(init.headers).get("authorization") });
      return Response.json({ id: `insight-${calls.length}`, status: incomplete ? "incomplete" : "completed",
        usage: { input_tokens: 1000, output_tokens: 200 },
        output: [{ type: "message", content: [{ type: "output_text", text: body.text ? '{"tags":["企画","進捗","企画"]}' : "## 要約\n保存済み本文のサマリー" }] }],
      });
    } }),
  });
  const post = (body) => ({ method: "POST", body: JSON.stringify(body) });
  assert.equal((await request("/summary", post({ period: "year" }))).status, 400);
  assert.equal((await (await request("/summary", post({ period: "month" }))).json()).meetingCount, 0);
  const meeting = { ...createDemo(), isDemo: false, source: "text", markdown: "# 手動修正した原文", analysisId: randomUUID() };
  await store.save(meeting);
  await store.save(createDemo());
  assert.equal((await request("/summary", post({ period: "month" }))).status, 428);
  await request("/settings", { method: "PUT", body: JSON.stringify({ apiKey: key, model: "gpt-6-luna" }) });
  const result = await request("/summary", post({ period: "month" }));
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal((await result.json()).meetingCount, 1);
  assert.equal(calls[0].body.model, "gpt-6-luna");
  assert.equal(calls[0].authorization, `Bearer ${key}`);
  assert.match(calls[0].body.input[1].content, /手動修正した原文/);
  assert.deepEqual((await (await request("/suggest-tags", post({ meetingId: meeting.id }))).json()).tags, ["企画", "進捗"]);
  assert.equal((await request("/suggest-tags", post({ meetingId: "bad" }))).status, 400);
  assert.equal((await request(`/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ tags: [" 企画 ", "進捗", "企画"] }) })).status, 200);
  const reloaded = new MeetingStore(path.join(dataDir, "meetings"));
  await reloaded.init();
  assert.deepEqual(reloaded.get(meeting.id).tags, ["企画", "進捗"]);
  assert.equal((await request(`/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ tags: [""] }) })).status, 400);
  const month = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(new Date());
  const usage = await (await request(`/usage?month=${month}`)).json();
  assert.equal(usage.eventCount, 2);
  assert.deepEqual(usage.events.map((e) => e.operation).sort(), ["summary", "tags"]);
  assert.equal(usage.events.find(e => e.operation === "tags").parentRunId, meeting.analysisId);
  assert.equal(usage.events.find(e => e.operation === "tags").runId, meeting.analysisId);
  assert.ok(usage.totalUsd > 0);
  const prior = summaryRange("lastMonth");
  await store.save({ ...meeting, id: randomUUID(), date: prior.end });
  const previous = await (await request("/summary", post({ period: "lastMonth" }))).json();
  assert.equal(previous.start, prior.start);
  assert.equal(previous.end, prior.end);
  assert.equal(previous.meetingCount, 1);
  const custom = await (await request("/summary", post({ period: "custom", start: prior.end, end: prior.end }))).json();
  assert.equal(custom.start, prior.end);
  assert.equal(custom.end, prior.end);
  assert.equal(custom.meetingCount, 1);
  const countBeforeInvalid = calls.length;
  for (const body of [{ period: "custom" }, { period: "custom", start: "2026-02-30", end: "2026-03-01" }, { period: "custom", start: "2026-03-01", end: "2026-02-28" }, { period: "custom", start: "9999-01-01", end: "9999-01-02" }]) {
    assert.equal((await request("/summary", post(body))).status, 400);
  }
  assert.equal(calls.length, countBeforeInvalid);
  incomplete = true;
  assert.equal((await request("/summary", post({ period: "month" }))).status, 502);
  assert.equal(store.get(meeting.id).markdown, "# 手動修正した原文");
});

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kotonoha-test-"));
  const context = await createApp({ dataDir, ...options });
  const server = context.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await context.waitForJobs();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, options = {}) {
    return fetch(`${base}/api${route}`, {
      ...options,
      headers: {
        "X-Kotonoha": "1",
        ...(options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
    });
  }
  return { ...context, dataDir, request, base };
}
function payload({
  audio = false,
  transcript = "会議の公開日は10月15日に決定しました。",
  extension = "wav",
  size = 44,
} = {}) {
  const form = new FormData();
  form.set("title", "テスト会議");
  form.set("date", "2026-09-23");
  form.set("participants", "田中、佐藤");
  if (audio)
    form.set(
      "audio",
      new Blob([new Uint8Array(size)], { type: "audio/wav" }),
      `meeting.${extension}`,
    );
  else form.set("transcript", transcript);
  return form;
}

test("APIキー未設定では会議を送信せず、サンプルだけ利用できる", async (t) => {
  const { request, store } = await setup(t);
  const result = await request("/meetings", {
    method: "POST",
    body: payload(),
  });
  assert.equal(result.status, 428);
  assert.equal(store.list().length, 0);
  const demo = await (await request("/demo", { method: "POST" })).json();
  assert.equal(demo.isDemo, true);
  assert.equal(demo.status, "done");
  const second = await (await request("/demo", { method: "POST" })).json();
  assert.equal(second.id, demo.id);
});

test("キーを返却・永続化せず、AIモデル設定のみ再起動後も保持する", async (t) => {
  const { request, dataDir } = await setup(t);
  const response = await request("/settings", {
    method: "PUT",
    body: JSON.stringify({ apiKey: key, model: "gpt-6-sol" }),
  });
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.configured, true);
  assert.equal(config.model, "gpt-6-sol");
  assert.ok(!JSON.stringify(config).includes(key));
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8")),
    {
      model: "gpt-6-sol",
      transcriptionModel: "gpt-transcribe",
    },
  );
  const missingGemini = await request("/settings", {
    method: "PUT",
    body: JSON.stringify({
      model: "gpt-6-sol",
      transcriptionModel: "gemini-3.5-transcribe",
    }),
  });
  assert.equal(missingGemini.status, 428);
  const geminiKey = "AIza-test-only-not-a-real-gemini-key";
  const gemini = await request("/settings", {
    method: "PUT",
    body: JSON.stringify({
      model: "gpt-6-sol",
      transcriptionModel: "gemini-3.5-transcribe",
      geminiApiKey: geminiKey,
    }),
  });
  assert.equal(gemini.status, 200);
  assert.equal((await gemini.json()).geminiConfigured, true);
  assert.ok(
    !(await readFile(path.join(dataDir, "config.json"), "utf8")).includes(
      geminiKey,
    ),
  );
  const invalid = await request("/settings", {
    method: "PUT",
    body: JSON.stringify({ model: "gpt-4.1-mini" }),
  });
  assert.equal(invalid.status, 400);
  const restarted = await createApp({ dataDir });
  assert.equal(restarted.store.list().length, 0);
});

test("旧設定のgpt-4o-transcribeは起動を止めずGPT Transcribeとして扱う", async (t) => {
  const { request, dataDir } = await setup(t, {
    transcriptionModel: "gpt-4o-transcribe",
  });
  assert.equal(
    (await (await request("/settings")).json()).transcriptionModel,
    "gpt-transcribe",
  );
  await writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ model: "gpt-6-sol", transcriptionModel: "gpt-4o-transcribe" }),
  );
  const restarted = await createApp({
    dataDir,
    transcriptionModel: "gemini-3.5-transcribe",
  });
  const server = restarted.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const settings = await (
    await fetch(`http://127.0.0.1:${server.address().port}/api/settings`, {
      headers: { "X-Kotonoha": "1" },
    })
  ).json();
  assert.equal(settings.transcriptionModel, "gpt-transcribe");
  const unknownDir = await mkdtemp(path.join(tmpdir(), "kotonoha-test-"));
  t.after(() => rm(unknownDir, { recursive: true, force: true }));
  await assert.rejects(
    createApp({ dataDir: unknownDir, transcriptionModel: "whisper-1" }),
    /TRANSCRIPTION_MODEL must be one of gpt-transcribe, gemini-3.5-transcribe/,
  );
});
test("録音を文字起こしして議事録まで作成し、音声を再生できる", async (t) => {
  const calls = [];
  const { request, waitForJobs } = await setup(t, {
    apiKey: key,
    aiFactory: (receivedKey, model) => {
      assert.equal(receivedKey, key);
      assert.equal(model, "gpt-6-astra");
      return {
        async transcribe(file) {
          calls.push("transcribe");
          assert.equal((await readFile(file)).length, 44);
          return {
            transcript: "公開日を10月15日に決定します。",
            segments: [],
            duration: null,
          };
        },
        async summarize(meeting) {
          calls.push("summarize");
          assert.equal(meeting.transcript, "公開日を10月15日に決定します。");
          return sampleMinutes;
        },
      };
    },
  });
  const created = await request("/meetings", {
    method: "POST",
    body: payload({ audio: true }),
  });
  assert.equal(created.status, 202);
  const accepted = await created.json();
  await waitForJobs();
  const meeting = await (await request(`/meetings/${accepted.id}`)).json();
  assert.deepEqual(calls, ["transcribe", "summarize"]);
  assert.equal(meeting.status, "done");
  assert.match(meeting.markdown, /## 決定事項/);
  assert.equal(meeting.hasAudio, true);
  assert.equal(meeting.transcriptionModel, "gpt-transcribe");
  assert.equal(meeting.minutesModel, "gpt-6-astra");
  assert.equal(meeting.audioFile, undefined);
  const range = await request(`/meetings/${meeting.id}/audio`, {
    headers: { Range: "bytes=0-9" },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 10);
});

test("Geminiで完了しなかった録音はGPT Transcribeに切り替え、切り替えを記録する", async (t) => {
  const models = [];
  const { request, waitForJobs } = await setup(t, {
    apiKey: key,
    geminiApiKey: "AIza-test-only-not-a-real-gemini-key",
    transcriptionModel: "gemini-3.5-transcribe",
    aiFactory: (_key, _model, _options, { transcriptionModel }) => ({
      async transcribe(_file, onUsage) {
        models.push(transcriptionModel);
        if (transcriptionModel === "gemini-3.5-transcribe")
          throw Object.assign(new Error("Gemini transcription did not complete"), {
            code: "GEMINI_TRANSCRIPT_INCOMPLETE",
            provider: "gemini",
            geminiStatus: "incomplete",
          });
        await onUsage({ usage: { seconds: 60 } });
        return { transcript: "GPTで文字起こししました。", segments: [], duration: null };
      },
      summarize: async () => sampleMinutes,
    }),
  });
  const created = await request("/meetings", {
    method: "POST",
    body: payload({ audio: true }),
  });
  assert.equal(created.status, 202);
  const { id } = await created.json();
  await waitForJobs();
  const meeting = await (await request(`/meetings/${id}`)).json();
  assert.equal(meeting.status, "done", meeting.error);
  assert.equal(meeting.transcript, "GPTで文字起こししました。");
  assert.deepEqual(models, ["gemini-3.5-transcribe", "gpt-transcribe"]);
  assert.deepEqual(
    meeting.recordings.map((r) => r.fallbackModel),
    ["gpt-transcribe"],
  );
  const month = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
  }).format(new Date());
  const usage = await (await request(`/usage?month=${month}&page=0`)).json();
  assert.ok(usage.events.some((event) =>
    event.meetingId === id && event.kind === "transcription" &&
    event.model === "gpt-transcribe"));
});

test("解析失敗後も文字起こしを保持し、Solへ変更して音声認識を繰り返さず再試行する", async (t) => {
  let transcriptions = 0;
  let attempts = 0;
  const models = [];
  const { request, waitForJobs } = await setup(t, {
    apiKey: key,
    aiFactory: (_key, model) => ({
      async transcribe() {
        transcriptions++;
        return { transcript: "認識済みの会話", segments: [], duration: null };
      },
      async summarize() {
        models.push(model);
        if (++attempts === 1)
          throw Object.assign(new Error("sensitive details"), { status: 429 });
        return sampleMinutes;
      },
    }),
  });
  const created = await (
    await request("/meetings", {
      method: "POST",
      body: payload({ audio: true }),
    })
  ).json();
  await waitForJobs();
  let meeting = await (await request(`/meetings/${created.id}`)).json();
  assert.equal(meeting.status, "error");
  assert.equal(meeting.transcript, "認識済みの会話");
  assert.ok(!meeting.error.includes("sensitive"));
  await request("/settings", {
    method: "PUT",
    body: JSON.stringify({ model: "gpt-6-sol" }),
  });
  const retry = await request(`/meetings/${created.id}/retry`, {
    method: "POST",
  });
  assert.equal(retry.status, 202);
  await waitForJobs();
  meeting = await (await request(`/meetings/${created.id}`)).json();
  assert.equal(meeting.status, "done");
  assert.equal(meeting.minutesModel, "gpt-6-sol");
  assert.equal(transcriptions, 1);
  assert.deepEqual(models, ["gpt-6-astra", "gpt-6-sol"]);
});

test("AACとWAVを順番どおりに1会議へ統合し、個別再生・一括ゴミ箱移動する", async (t) => {
  const calls = [];
  const { request, waitForJobs, dataDir } = await setup(t, {
    apiKey: key,
    aiFactory: () => ({
      async transcribe(file) {
        calls.push(path.extname(file));
        return {
          transcript: file.endsWith(".m4a") ? "前半の議論" : "後半の決定",
        };
      },
      async summarize(meeting) {
        assert.equal(
          meeting.transcript,
          "【録音 1】\n前半の議論\n\n【録音 2】\n後半の決定",
        );
        return sampleMinutes;
      },
    }),
  });
  const form = payload({ audio: true });
  form.delete("audio");
  form.append("audio", new File([aacFixture], "前半.AAC"));
  form.append("audio", new File([new Uint8Array(44)], "後半.wav"));
  const response = await request("/meetings", { method: "POST", body: form });
  assert.equal(response.status, 202);
  const created = await response.json();
  assert.equal(created.audioParts, undefined);
  assert.equal(created.fileName, "前半.AAC");
  await waitForJobs();
  const done = await (await request(`/meetings/${created.id}`)).json();
  assert.equal(done.status, "done");
  assert.deepEqual(
    done.recordings.map((part) => part.transcribed),
    [true, true],
  );
  assert.deepEqual(calls.sort(), [".m4a", ".wav"]);
  const first = await request(`/meetings/${created.id}/audio?part=0`);
  assert.match(first.headers.get("content-type"), /audio\/mp4/);
  assert.equal(
    Buffer.from(await first.arrayBuffer()).toString("ascii", 4, 8),
    "ftyp",
  );
  assert.equal(
    (
      await (
        await request(`/meetings/${created.id}/audio?part=1`)
      ).arrayBuffer()
    ).byteLength,
    44,
  );
  assert.equal(
    (await request(`/meetings/${created.id}/audio?part=2`)).status,
    404,
  );
  assert.equal(
    (await request(`/meetings/${created.id}/audio?part=-1`)).status,
    404,
  );
  await request(`/meetings/${created.id}`, { method: "DELETE" });
  assert.equal((await readdir(path.join(dataDir, "audio"))).length, 0);
  assert.equal(
    (await readdir(path.join(dataDir, "trash", created.id))).length,
    3,
  );
});

test("複数アップロードの途中でAACが不正なら音声も会議も残さない", async (t) => {
  const { request, dataDir, store } = await setup(t, { apiKey: key });
  const form = payload({ audio: true });
  form.append("audio", new File(["invalid AAC"], "broken.aac"));
  const result = await request("/meetings", { method: "POST", body: form });
  assert.equal(result.status, 400);
  assert.match((await result.json()).error, /AACを読み込めません/);
  assert.deepEqual(await readdir(path.join(dataDir, "audio")), []);
  assert.equal(store.list().length, 0);
});

test("テキスト取り込み、議事録編集、アクション完了、文字起こし修正を保存する", async (t) => {
  const { request, waitForJobs } = await setup(t, {
    apiKey: key,
    aiFactory: () => ({
      transcribe: () => assert.fail("text should not be transcribed"),
      summarize: async () => sampleMinutes,
    }),
  });
  const created = await (
    await request("/meetings", { method: "POST", body: payload() })
  ).json();
  await waitForJobs();
  const renamed = await (
    await request(`/meetings/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "  変更後の会議名  " }),
    })
  ).json();
  assert.equal(renamed.title, "変更後の会議名");
  assert.ok(renamed.markdown.startsWith("# 変更後の会議名\n"));
  assert.equal((await (await request("/meetings")).json())[0].title, "変更後の会議名");
  assert.equal((await request(`/meetings/${created.id}`, {
    method: "PATCH", body: JSON.stringify({ title: "   " }),
  })).status, 400);
  const edited = await (
    await request(`/meetings/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ markdown: "# 編集済み", completedActions: [0] }),
    })
  ).json();
  assert.equal(edited.markdown, "# 編集済み");
  assert.deepEqual(edited.completedActions, [0]);
  const renamedAgain = await (
    await request(`/meetings/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "再変更" }),
    })
  ).json();
  assert.equal(renamedAgain.title, "再変更");
  assert.equal(renamedAgain.markdown, "# 編集済み", "手書きの見出しは変更しない");
  const corrected = await (
    await request(`/meetings/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ transcript: "修正後の会話です。" }),
    })
  ).json();
  assert.equal(corrected.minutesStale, true);
  assert.equal(corrected.transcript, "修正後の会話です。");
  const badAction = await request(`/meetings/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ completedActions: [100] }),
  });
  assert.equal(badAction.status, 400);
});

test("処理中の会議に二重の再試行・編集・削除を許可しない", async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { request, waitForJobs } = await setup(t, {
    apiKey: key,
    aiFactory: () => ({
      summarize: async () => {
        await pending;
        return sampleMinutes;
      },
    }),
  });
  const created = await (
    await request("/meetings", { method: "POST", body: payload() })
  ).json();
  try {
    assert.equal(
      (await request(`/meetings/${created.id}/retry`, { method: "POST" }))
        .status,
      409,
    );
    assert.equal(
      (await request(`/meetings/${created.id}`, { method: "DELETE" })).status,
      409,
    );
    assert.equal(
      (
        await request(`/meetings/${created.id}`, {
          method: "PATCH",
          body: JSON.stringify({ markdown: "invalid update" }),
        })
      ).status,
      409,
    );
  } finally {
    release();
    await waitForJobs();
  }
});

test("空入力・非対応拡張子・サイズ超過を拒否し、不要なアップロードを残さない", async (t) => {
  const { request, dataDir } = await setup(t, { apiKey: key });
  for (const body of [
    payload({ transcript: "   " }),
    payload({ audio: true, extension: "exe" }),
    payload({ audio: true, size: 0 }),
    payload({ audio: true, size: MAX_FILE_SIZE + 1 }),
  ]) {
    assert.equal(
      (await request("/meetings", { method: "POST", body })).status,
      400,
    );
  }
  const invalidDate = payload({ audio: true });
  invalidDate.set("date", "2026-02-31");
  assert.equal(
    (await request("/meetings", { method: "POST", body: invalidDate })).status,
    400,
  );
  assert.deepEqual(await readdir(path.join(dataDir, "audio")), []);
});

test("会議を削除するとデータと音声を復元可能なゴミ箱へ移動する", async (t) => {
  const { request, dataDir, waitForJobs } = await setup(t, {
    apiKey: key,
    aiFactory: () => ({
      transcribe: async () => ({
        transcript: "会話",
        segments: [],
        duration: null,
      }),
      summarize: async () => sampleMinutes,
    }),
  });
  const m = await (
    await request("/meetings", {
      method: "POST",
      body: payload({ audio: true }),
    })
  ).json();
  await waitForJobs();
  assert.equal(
    (await request(`/meetings/${m.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal((await request(`/meetings/${m.id}`)).status, 404);
  const deleted = JSON.parse(
    await readFile(path.join(dataDir, "trash", m.id, "meeting.json"), "utf8"),
  );
  assert.equal(deleted.id, m.id);
  assert.equal(
    (await readFile(path.join(dataDir, "trash", m.id, deleted.audioFile)))
      .length,
    44,
  );
});

test("再起動で処理中の記録を再試行可能なエラーに変え、文字起こしを保全する", async (t) => {
  const { store, dataDir } = await setup(t);
  const m = {
    ...createDemo(),
    isDemo: false,
    status: "analyzing",
    transcript: "保存済みの会話",
  };
  await store.save(m);
  const reopened = new MeetingStore(path.join(dataDir, "meetings"));
  await reopened.init();
  assert.equal(reopened.get(m.id).status, "error");
  assert.equal(reopened.get(m.id).transcript, "保存済みの会話");
  assert.match(reopened.get(m.id).error, /再起動/);
});

test("外部サイトからの操作とDNS rebindingを拒否する", async (t) => {
  const { request, base } = await setup(t);
  assert.equal(
    (
      await request("/demo", {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(`${base}/api/demo`, { method: "POST" })).status,
    403,
  );
  const reboundStatus = await new Promise((resolve, reject) => {
    httpGet(
      `${base}/api/meetings`,
      { headers: { Host: "attacker.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).on("error", reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal(
    (
      await request("/settings", {
        headers: { Origin: "http://127.0.0.1:5188" },
      })
    ).status,
    200,
  );
});

test("実際のSDKリクエストはGPT Transcribeと指定のAstra/Sol/Lunaを使用する", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kotonoha-wire-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "meeting.wav");
  await writeFile(file, new Uint8Array(44));
  for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
    const calls = [];
    const ai = createAI(key, model, {
      maxRetries: 0,
      fetch: async (url, init) => {
        if (String(url) === "data:,") return new Response(""); // SDK multipart capability check.
        calls.push(String(url));
        if (String(url).endsWith("/audio/transcriptions")) {
          const form = await new Response(init.body, {
            headers: init.headers,
          }).formData();
          assert.equal(form.get("model"), "gpt-transcribe");
          assert.deepEqual(form.getAll("languages[]"), ["ja"]);
          assert.equal(form.get("language"), null);
          assert.equal(form.get("response_format"), "json");
          assert.equal(form.get("chunking_strategy"), null);
          return Response.json({ text: "文字起こしの本文。" });
        }
        const body = JSON.parse(init.body);
        assert.equal(body.model, model);
        assert.equal(body.store, false);
        assert.equal(body.reasoning.effort, "medium");
        assert.equal(body.text.format.type, "json_schema");
        assert.match(body.input[1].content, /文字起こしの本文/);
        return Response.json({
          id: "resp_test",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              id: "msg_test",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(sampleMinutes),
                  annotations: [],
                },
              ],
            },
          ],
        });
      },
    });
    const transcript = await ai.transcribe(file).catch((error) => {
      throw error.cause || error;
    });
    assert.deepEqual(transcript.segments, []);
    assert.equal(transcript.duration, null);
    const result = await ai.summarize({
      ...createDemo(),
      transcript: transcript.transcript,
    });
    assert.deepEqual(result, sampleMinutes);
    assert.equal(calls.length, 2);
  }
});

test("API使用料を呼び出しごとに保存し、会議削除後も月別に表示する", async (t) => {
  const { request, waitForJobs, store } = await setup(t, {
    apiKey: key,
    aiFactory: () => ({
      async transcribe(_path, onUsage) {
        await onUsage({ usage: { seconds: 60 } });
        return { transcript: "来週始めます。", segments: [], duration: null };
      },
      async summarize(_meeting, onUsage) {
        await onUsage({ usage: { input_tokens: 1000, output_tokens: 200,
          input_tokens_details: { cached_tokens: 0 } } });
        return sampleMinutes;
      },
    }),
  });
  const meeting = await (await request("/meetings", {
    method: "POST", body: payload({ audio: true }),
  })).json();
  await waitForJobs();
  const month = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
  }).format(new Date());
  const route = `/usage?month=${month}&page=0`;
  const usage = await (await request(route)).json();
  assert.equal(usage.eventCount, 2);
  assert.equal(usage.totalUsd, 0.0045 + (1000 * 10 + 200 * 50) / 1_000_000);
  assert.ok(usage.events.every((event) => event.meetingId === meeting.id));
  assert.ok(usage.events.every((event) => event.runId === usage.events[0].runId));
  assert.ok(usage.events[0].runId);
  assert.equal(store.get(meeting.id).analysisId, usage.events[0].runId);
  assert.equal((await (await request(`/meetings/${meeting.id}`)).json()).analysisId, undefined);
  assert.equal((await request(`/meetings/${meeting.id}/retry`, { method: "POST" })).status, 202);
  await waitForJobs();
  const afterRetry = await (await request(route)).json();
  assert.equal(afterRetry.eventCount, 3);
  assert.equal(new Set(afterRetry.events.map((event) => event.runId)).size, 2);
  assert.equal((await request(`/meetings/${meeting.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await (await request(route)).json()).eventCount, 3);
});
