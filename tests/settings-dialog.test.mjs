// Real React form handlers, with an in-memory API stub and synthetic keys only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

function harness(overrides = {}) {
  const slots = [];
  let cursor = 0;
  let failure = false;
  const calls = [],
    saved = [];
  const props = {
    settings: {
      configured: true,
      geminiConfigured: true,
      model: "gpt-6-sol",
      transcriptionModel: "gemini-3.5-transcribe",
      ...overrides,
    },
    onClose() {},
    onSave: (value) => saved.push(value),
    onRequestNotification() {},
    notificationPermission: "granted",
  };
  const module = { exports: {} };
  const source = ts.transpileModule(
    readFileSync(new URL("../src/SettingsDialog.tsx", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    Error,
    Promise,
    requestAnimationFrame: (callback) => callback(),
    require(name) {
      if (name === "react")
        return {
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
        };
      if (name === "react/jsx-runtime") return jsx;
      if (name === "lucide-react")
        return new Proxy({}, { get: () => () => null });
      if (name === "./Modal") return { Modal: () => null };
      if (name === "./cloud") return { isCloud: true };
      if (name === "./api")
        return {
          api: async (path, options) => {
            calls.push({ path, body: JSON.parse(options.body) });
            if (failure) throw new Error("設定を保存できませんでした。");
            return {
              ...props.settings,
              ...JSON.parse(options.body),
              configured: true,
            };
          },
        };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  function render() {
    cursor = 0;
    return module.exports.SettingsDialog(props);
  }
  function all(predicate, node = render()) {
    if (!node || typeof node !== "object") return [];
    return [
      ...(predicate(node) ? [node] : []),
      ...[node.props?.children]
        .flat(Infinity)
        .filter((child) => child !== undefined)
        .flatMap((child) => all(predicate, child)),
    ];
  }
  const keys = () =>
    all((n) => n.type === "input" && n.props.type === "password");
  const details = () => all((n) => n.type === "details");
  const select = (value) =>
    all(
      (n) =>
        n.type === "input" &&
        n.props.type === "radio" &&
        n.props.value === value,
    )[0].props.onChange();
  const submit = () =>
    all((n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  return {
    props,
    calls,
    saved,
    render,
    all,
    keys,
    details,
    select,
    submit,
    fail: (value) => {
      failure = value;
    },
  };
}

test("Configured API inputs and explanations are folded; keys are never prefilled", () => {
  const h = harness();
  assert.deepEqual(
    h.details().map((n) => n.props.open),
    [false, false],
  );
  assert.deepEqual(
    h.keys().map((n) => n.props.value),
    ["", ""],
  );
  assert.equal(
    h.all((n) => n.type === "input" && n.props.type === "radio").length,
    5,
  );
  h.details()[0].props.onToggle({ currentTarget: { open: true } });
  assert.deepEqual(
    h.details().map((n) => n.props.open),
    [true, false],
  );
  h.details()[0].props.onToggle({ currentTarget: { open: false } });
  assert.equal(h.details()[0].props.open, false);
});

test("Unconfigured OpenAI opens; choosing unconfigured Gemini reveals its required key", () => {
  const h = harness({
    configured: false,
    geminiConfigured: false,
    transcriptionModel: "gpt-transcribe",
  });
  assert.deepEqual(
    h.details().map((n) => n.props.open),
    [true, false],
  );
  assert.equal(h.keys()[0].props.required, true);
  assert.equal(h.keys()[1].props.required, false);
  h.select("gemini-3.5-transcribe");
  assert.deepEqual(
    h.details().map((n) => n.props.open),
    [true, true],
  );
  assert.equal(h.keys()[1].props.required, true);
  const alreadySelected = harness({ geminiConfigured: false });
  assert.equal(alreadySelected.details()[1].props.open, true);
});

test("Model-only saves omit both keys and preserve stored credentials", async () => {
  const h = harness();
  h.select("gpt-6-luna");
  h.select("gpt-transcribe");
  await h.submit();
  assert.deepEqual(h.calls, [
    {
      path: "/settings",
      body: { model: "gpt-6-luna", transcriptionModel: "gpt-transcribe" },
    },
  ]);
  assert.equal(h.saved.length, 1);
  assert.deepEqual(
    h.keys().map((n) => n.props.value),
    ["", ""],
  );
});

test("Replacement keys remain on failure and clear only after a successful save", async () => {
  const h = harness();
  h.keys()[0].props.onChange({
    target: { value: "  sk-synthetic-test-only-key  " },
  });
  h.keys()[1].props.onChange({
    target: { value: "  AIza-synthetic-test-only-key  " },
  });
  h.fail(true);
  await h.submit();
  assert.equal(h.saved.length, 0);
  assert.match(h.keys()[0].props.value, /synthetic/);
  assert.match(
    h.all((n) => n.props?.role === "alert")[0].props.children,
    /保存できません/,
  );
  h.fail(false);
  await h.submit();
  assert.equal(h.calls[1].body.apiKey, "sk-synthetic-test-only-key");
  assert.equal(h.calls[1].body.geminiApiKey, "AIza-synthetic-test-only-key");
  assert.equal(h.saved.length, 1);
  assert.deepEqual(
    h.keys().map((n) => n.props.value),
    ["", ""],
  );
});

test("Invalid input hidden in a collapsed section is revealed and focused without sending", () => {
  const h = harness();
  for (const index of [0, 1]) {
    let prevented = false,
      focused = false;
    h.keys()[index].props.onInvalid({
      preventDefault() {
        prevented = true;
      },
      currentTarget: {
        focus() {
          focused = true;
        },
      },
    });
    assert.equal(prevented, true);
    assert.equal(focused, true);
    assert.equal(h.details()[index].props.open, true);
    assert.match(
      h.all((n) => n.props?.role === "alert")[0].props.children,
      /20文字以上/,
    );
  }
  assert.equal(h.calls.length, 0);
});
