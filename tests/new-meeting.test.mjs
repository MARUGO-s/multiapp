// Exercise the real form handlers; never call an AI provider or production API.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as formats from "../supabase/functions/_shared/minutes-formats.mjs";
import * as bot from "../supabase/functions/_shared/bot.mjs";

function harness(customTemplates = []) {
  const slots = [];
  let cursor = 0;
  const calls = [];
  const hooks = {
    useEffect() {},
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
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return jsx;
      if (name === "lucide-react")
        return new Proxy({}, { get: () => () => null });
      if (name.endsWith("minutes-formats.mjs")) return formats;
      if (name.endsWith("bot.mjs")) return bot;
      if (name === "./Modal") return { Modal: () => null };
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
        };
      if (name === "./split-recordings.mjs")
        return { VIDEO_EXTENSIONS: [".mp4", ".mov"] };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  function render() {
    cursor = 0;
    return module.exports.NewMeeting(props);
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
  return { props, calls, render, find, change, mode, submit };
}

test("New meeting opens directly on file input without format cards or selector", () => {
  const h = harness();
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
  const h = harness();
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
  const h = harness();
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
  const h = harness([
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
  const h = harness();
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
