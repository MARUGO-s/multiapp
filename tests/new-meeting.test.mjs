// Exercise the real form handlers; never call an AI provider or production API.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as formats from "../supabase/functions/_shared/minutes-formats.mjs";
import * as bot from "../supabase/functions/_shared/bot.mjs";
import * as recordingLocation from "../src/recording-location.mjs";

async function harness(customTemplates = [], transforms = {}, fixture = {}) {
  const slots = [];
  const effects = [];
  const drafts = new Map(
    fixture.draft ? [[fixture.draft.id, fixture.draft]] : [],
  );
  const scope = { ownerId: "synthetic-owner", actorId: "synthetic-actor" };
  const newDraft = () => ({
    id: "synthetic-draft",
    revision: 1,
    scope,
    mode: "file",
    metadata: {
      title: "",
      date: "2026-10-08",
      participants: "",
      template: "standard",
    },
    transcript: "",
    files: [],
    attachments: [],
    sessionIds: [],
    updatedAt: 1,
  });
  let cursor = 0;
  const calls = [];
  const hooks = {
    useEffect(effect, deps) {
      const i = cursor++,
        previous = slots[i];
      if (!previous || deps.some((v, n) => v !== previous[n])) {
        slots[i] = deps;
        effects.push(effect);
      }
    },
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: initial };
      return [
        slots[i].value,
        (value) => {
          slots[i].value =
            typeof value === "function" ? value(slots[i].value) : value;
        },
      ];
    },
    useRef(initial) {
      const i = cursor++;
      slots[i] ??= { current: initial };
      return slots[i];
    },
  };
  const props = {
    settings: { configured: true, geminiConfigured: true, model: "gpt-6-luna" },
    templates: [...formats.defaultMinutesTemplates(), ...customTemplates],
    onCreate: async (data) => {
      calls.push(data);
    },
    onBot: async (request) => {
      calls.push(request);
    },
    onClose() {},
    onSettings() {},
  };
  const module = { exports: {} };
  const code = ts.transpileModule(
    readFileSync(new URL("../src/NewMeeting.tsx", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    FormData,
    File,
    Error,
    Promise,
    require(name) {
      if (name === "./recording-location.mjs") return recordingLocation;
      if (name === "./recording-location.css") return {};
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return jsx;
      if (name === "lucide-react")
        return new Proxy({}, { get: () => () => null });
      if (name.endsWith("minutes-formats.mjs")) return formats;
      if (name.endsWith("bot.mjs")) return bot;
      if (name === "./Modal") return { Modal: () => null };
      if (name === "./api") return { download() {} };
      if (name === "./offline.css") return {};
      // This handler harness tests form/location behavior. Authentication
      // transitions are exercised by the real-browser scope regression.
      if (name === "./offline-authorization")
        return {
          authenticationGeneration: () => 0,
          useAuthenticationGeneration: () => 0,
          assertAuthentication: (generation) => assert.equal(generation, 0),
        };
      if (name === "./offline-store")
        return {
          getDraft: async (id) => drafts.get(id),
          listDrafts: async () => [...drafts.values()],
          saveDraft: async (d) => {
            const current = drafts.get(d.id);
            if (
              current?.attempt ||
              (current?.revision || 0) !== (d.revision || 0)
            )
              throw new Error("revision conflict");
            const next = { ...d, revision: (d.revision || 0) + 1 };
            drafts.set(d.id, next);
            return next;
          },
        };
      if (name === "./upload-recordings")
        return {
          getUploadContext: async () => scope,
          authorizeOfflineDraft: async (d) => {
            assert.deepEqual(d.scope, scope);
            return () => {};
          },
          createOfflineDraft: async () => {
            const d = newDraft();
            drafts.set(d.id, d);
            return d;
          },
          discardOfflineDraft: async (id) => drafts.delete(id),
        };
      if (name === "./Attachments") return { AttachmentPicker: () => null };
      if (name === "./cloud") return { isCloud: true };
      if (name === "./types")
        return {
          today: () => "2026-10-08",
          modelName: () => "GPT",
          transcriptionModelName: () => "OpenAI",
        };
      if (name === "./recording")
        return {
          getRecordingCapabilities: () => ({
            canRecordMic: true,
            canRecordMeeting: false,
          }),
          isMobileDevice: () => false,
          listRecoverableSessions: async () => [],
          ...fixture.recorder,
        };
      if (name === "./split-recordings.mjs")
        return { VIDEO_EXTENSIONS: [".mp4", ".mov"], ...transforms };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  function render() {
    cursor = 0;
    const shell = module.exports.NewMeeting(props);
    const result =
      typeof shell.type === "function" ? shell.type(shell.props) : shell;
    while (effects.length) effects.shift()();
    return result;
  }
  function find(predicate, node = render()) {
    if (!node || typeof node !== "object") return null;
    if (predicate(node)) return node;
    for (const child of [node.props?.children].flat(Infinity)) {
      if (child === undefined) continue;
      const result = find(predicate, child);
      if (result) return result;
    }
    return null;
  }
  function change(predicate, value) {
    find(predicate).props.onChange({ target: { value } });
  }
  function mode(label) {
    find(
      (n) => n.type === "button" && [n.props.children].flat().includes(label),
    ).props.onClick();
  }
  async function submit() {
    await find((n) => n.type === "form").props.onSubmit({
      preventDefault() {},
    });
  }
  for (let i = 0; i < 8; i++) {
    render();
    await Promise.resolve();
  }
  return { props, calls, render, find, change, mode, submit, drafts };
}

test("Recovered session location survives explicit draft metadata and a fresh form/File clone", async () => {
  const point = {
    latitude: 1.234567,
    longitude: 2.345678,
    accuracy: 8,
    capturedAt: "2026-10-28T01:02:03.000Z",
  };
  const file = new File(["SYNTHETIC recovered"], "recovered.webm");
  recordingLocation.rememberRecordingLocation(file, point);
  const h = await harness(
    [],
    {},
    {
      recorder: {
        listRecoverableSessions: async () => [
          {
            id: "session",
            startedAt: 1,
            scope: { ownerId: "synthetic-owner", actorId: "synthetic-actor" },
            integrity: "complete",
            expectedChunks: 1,
            failedIndices: [],
          },
        ],
        recoverSession: async () => file,
      },
    },
  );
  await h
    .find((n) => n.type === "button" && n.props.children === "復元して追加")
    .props.onClick();
  await h.submit();
  assert.deepEqual(JSON.parse(h.calls[0].get("recordingLocations")), [point]);
  const saved = h.drafts.get("synthetic-draft");
  assert.deepEqual(JSON.parse(JSON.stringify(saved.sourceSessions)), [
    "session",
  ]);
  const cloned = {
    ...JSON.parse(JSON.stringify(saved)),
    files: [new File([await file.arrayBuffer()], file.name)],
  };
  assert.equal(
    recordingLocation.getRecordingLocation(cloned.files[0]),
    null,
    "a fresh File has no WeakMap metadata",
  );
  const reloaded = await harness([], {}, { draft: cloned });
  await reloaded.submit();
  assert.deepEqual(JSON.parse(reloaded.calls[0].get("recordingLocations")), [
    point,
  ]);
});

test("Video extraction and automatic compression preserve the located source in the real form", async () => {
  const point = {
    latitude: 1.234567,
    longitude: 2.345678,
    accuracy: 8,
    capturedAt: "2026-10-28T01:02:03.000Z",
  };
  const original = new File(["synthetic video"], "located.mp4");
  recordingLocation.rememberRecordingLocation(original, point);
  const transformed = [];
  const h = await harness([], {
    extractAudio: async (file) => {
      transformed.push(["extract", file.name]);
      const f = new File(["synthetic extracted audio"], "extracted.m4a");
      Object.defineProperty(f, "size", { value: 100_000_001 });
      return f;
    },
    compressAudio: async (file) => {
      transformed.push(["compress", file.name]);
      return new File(["synthetic compressed audio"], "compressed.m4a");
    },
  });
  h.find((n) => n.type === "input" && n.props.type === "file").props.onChange({
    target: { files: [original], value: "selected" },
  });
  for (let i = 0; i < 12; i++) {
    h.render();
    await Promise.resolve();
  }
  await h.submit();
  assert.deepEqual(transformed, [
    ["extract", "located.mp4"],
    ["compress", "extracted.m4a"],
  ]);
  assert.equal(h.calls[0].get("audio").name, "compressed.m4a");
  assert.deepEqual(JSON.parse(h.calls[0].get("recordingLocations")), [point]);
});

test("Location follows append/reorder/remove and persists explicitly outside File objects", async () => {
  const h = await harness();
  const point = {
    latitude: 1.234567,
    longitude: 2.345678,
    accuracy: 8,
    capturedAt: "2026-10-28T01:02:03.000Z",
  };
  const a = new File(["first"], "located.m4a"),
    b = new File(["second"], "plain.m4a"),
    c = new File(["third"], "added.m4a");
  recordingLocation.rememberRecordingLocation(a, point);
  const add = (files) =>
    h
      .find((n) => n.type === "input" && n.props.type === "file")
      .props.onChange({ target: { files, value: "selected" } });
  add([a, b]);
  h.find((n) => n.props?.["aria-label"] === "録音2を上へ").props.onClick();
  add([c]);
  h.find((n) => n.props?.["aria-label"] === "録音1を解除").props.onClick();
  await h.submit();
  assert.deepEqual(
    h.calls[0].getAll("audio").map((f) => f.name),
    ["located.m4a", "added.m4a"],
  );
  assert.deepEqual(JSON.parse(h.calls[0].get("recordingLocations")), [
    point,
    null,
  ]);
  const saved = h.drafts.get("synthetic-draft");
  assert.deepEqual(JSON.parse(JSON.stringify(saved.sourceLocations)), [
    point,
    null,
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.sourceSessions)), [
    null,
    null,
  ]);
});

test("New meeting opens directly on file input without format cards or selector", async () => {
  const h = await harness();
  assert.equal(h.render().props.title, "議事録を作成");
  assert.match(h.render().props.subtitle, /3形式を自動/);
  assert.ok(h.find((n) => n.props?.className?.startsWith("drop-zone")));
  assert.equal(
    h.find((n) => n.type === "select"),
    null,
  );
  assert.equal(
    h.find((n) => n.props?.className === "template-selector"),
    null,
  );
  const options = h.find(
    (n) => n.type === "details" && n.props.className === "new-meeting-options",
  );
  assert.equal(options.props.open, undefined);
});

test("Audio selection and ordering are preserved with the standard initial format", async () => {
  const h = await harness();
  h.find((n) => n.type === "input" && n.props.type === "file").props.onChange({
    target: {
      files: [
        new File(["first"], "前半.m4a"),
        new File(["second"], "後半.m4a"),
      ],
      value: "selected",
    },
  });
  h.find(
    (n) => n.type === "button" && n.props["aria-label"] === "録音2を上へ",
  ).props.onClick();
  await h.submit();
  assert.equal(h.calls[0].get("title"), "前半");
  assert.equal(h.calls[0].get("template"), "standard");
  assert.deepEqual(
    h.calls[0].getAll("audio").map((f) => f.name),
    ["後半.m4a", "前半.m4a"],
  );
});

test("Text submission defaults to standard and preserves date, participants and attachments", async () => {
  const h = await harness();
  h.mode("テキスト");
  h.change((n) => n.type === "input" && n.props.maxLength === 160, "定例会議");
  h.change((n) => n.type === "input" && n.props.type === "date", "2026-10-07");
  h.change(
    (n) => n.type === "input" && n.props.maxLength === 2000,
    "田中、佐藤",
  );
  h.change((n) => n.type === "textarea", "来週までに資料を確認する。");
  const attachment = new File(["test"], "参考.txt", { type: "text/plain" });
  h.find(
    (n) => typeof n.type === "function" && n.props.files && n.props.onChange,
  ).props.onChange([attachment]);
  await h.submit();
  assert.equal(h.calls.length, 1);
  const data = h.calls[0];
  assert.equal(data.get("template"), "standard");
  assert.equal(data.get("title"), "定例会議");
  assert.equal(data.get("date"), "2026-10-07");
  assert.equal(data.get("participants"), "田中、佐藤");
  assert.equal(data.get("transcript"), "来週までに資料を確認する。");
  assert.equal(data.get("attachment").name, "参考.txt");
});

test("Saved custom meeting settings fill metadata without changing the standard initial format", async () => {
  const h = await harness([
    {
      id: "custom",
      name: "週次定例",
      defaultParticipants: "田中",
      templateType: "detailed",
    },
  ]);
  const select = h.find((n) => n.type === "select");
  assert.equal(select.props.children[1].length, 1);
  h.change((n) => n.type === "select", "custom");
  h.mode("テキスト");
  h.change((n) => n.type === "textarea", "進捗を確認した。");
  await h.submit();
  assert.equal(h.calls[0].get("title"), "週次定例");
  assert.equal(h.calls[0].get("participants"), "田中");
  assert.equal(h.calls[0].get("template"), "standard");
});

test("Bot requests use standard too; invalid Meet URLs are rejected without sending", async () => {
  const h = await harness();
  h.mode("Botを呼ぶ");
  h.change(
    (n) => n.type === "input" && n.props.maxLength === 160,
    "オンライン定例",
  );
  h.change(
    (n) => n.type === "input" && n.props.type === "url",
    "https://example.com/",
  );
  await h.submit();
  assert.equal(h.calls.length, 0);
  assert.match(
    h.find((n) => n.props?.role === "alert").props.children,
    /Google Meet/,
  );
  h.change(
    (n) => n.type === "input" && n.props.type === "url",
    "https://meet.google.com/abc-defg-hij",
  );
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].metadata.template, "standard");
  assert.equal(h.calls[0].metadata.title, "オンライン定例");
});
