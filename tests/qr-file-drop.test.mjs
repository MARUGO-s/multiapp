// Exercise the component's actual event handlers without a browser or network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as validation from "../supabase/functions/_shared/qr-files.mjs";
import * as selection from "../src/qr-file-selection.mjs";
import * as logos from "../supabase/functions/_shared/qr-logos.mjs";
import * as storeNames from "../supabase/functions/_shared/qr-store-name.mjs";

function harness() {
  const slots = [];
  let cursor = 0;
  const calls = [];
  let failure = false;
  const props = {
    busy: false,
    onBusy(value) {
      props.busy = value;
    },
    onCreated(link) {
      calls.push({ created: link });
    },
  };
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
  const module = { exports: {} };
  const code = ts.transpileModule(
    readFileSync(new URL("../src/QrFileUpload.tsx", import.meta.url), "utf8"),
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
    crypto: globalThis.crypto,
    Uint8Array,
    Error,
    Promise,
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return jsx;
      if (name === "lucide-react")
        return { FileUp: () => null, LoaderCircle: () => null };
      if (name.endsWith("qr-files.mjs")) return validation;
      if (name.endsWith("qr-file-selection.mjs")) return selection;
      if (name === "./QrLogoPicker") return { QrLogoPicker: () => null };
      if (name === "./QrStoreNameField")
        return { QrStoreNameField: () => null };
      if (name.endsWith("qr-logos.mjs")) return logos;
      if (name.endsWith("qr-store-name.mjs")) return storeNames;
      if (name === "./qr-api")
        return {
          useQrApi: () => async (path, options) => {
            calls.push({ path, options });
            if (failure) throw new Error("test offline");
            return { link: { id: "test-only", code: "abcdefgh1234" } };
          },
        };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  function render() {
    cursor = 0;
    return module.exports.QrFileUpload(props);
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
  const dropZone = () =>
    find((n) => n.props?.className?.startsWith("qr-file-dropzone"));
  const event = (files) => ({
    dataTransfer: { types: ["Files"], files, dropEffect: "none" },
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  });
  return {
    props,
    calls,
    render,
    find,
    dropZone,
    event,
    setFailure(value) {
      failure = value;
    },
  };
}
const pdf = () =>
  new File(["%PDF-1.4\n"], "メニュー.pdf", { type: "application/pdf" });
test("Dropped files select without publishing, reset consent and bypass empty native file input", async () => {
  const h = harness();
  h.find(
    (n) => n.type === "input" && n.props.type === "checkbox",
  ).props.onChange({ target: { checked: true } });
  const e = h.event([pdf()]);
  h.dropZone().props.onDrop(e);
  assert.equal(e.prevented, true);
  assert.equal(e.stopped, true);
  assert.equal(h.calls.length, 0);
  assert.equal(
    h.find((n) => n.type === "input" && n.props.type === "checkbox").props
      .checked,
    false,
  );
  assert.equal(
    h.find((n) => n.type === "input" && n.props.placeholder).props.value,
    "メニュー",
  );
  const native = h.find((n) => n.type === "input" && n.props.type === "file");
  assert.equal(native.props.required, undefined);
  assert.equal(native.props.hidden, true);
  assert.equal(
    h.find((n) => n.type === "button" && n.props.className === "button primary")
      .props.disabled,
    true,
  );
  h.find(
    (n) => n.type === "input" && n.props.type === "checkbox",
  ).props.onChange({ target: { checked: true } });
  await h.render().props.onSubmit({ preventDefault() {} });
  assert.equal(h.calls[0].path, "/uploads");
  const body = JSON.parse(h.calls[0].options.body);
  assert.equal(body.fileName, "メニュー.pdf");
  assert.equal(body.publishConfirmed, true);
  assert.equal(h.calls[1].created.code, "abcdefgh1234");
});
test("Multiple or invalid dropped files cannot publish; busy/retry cannot replace pending file", async () => {
  const h = harness();
  h.dropZone().props.onDrop(h.event([pdf(), pdf()]));
  assert.match(
    h.find((n) => n.props?.role === "alert").props.children[0],
    /1つずつ/,
  );
  assert.equal(h.calls.length, 0);
  h.dropZone().props.onDrop(h.event([new File(["hello"], "bad.html")]));
  assert.match(
    h.find((n) => n.props?.role === "alert").props.children[0],
    /PDF/,
  );
  h.dropZone().props.onDrop(h.event([pdf()]));
  h.find(
    (n) => n.type === "input" && n.props.type === "checkbox",
  ).props.onChange({ target: { checked: true } });
  h.setFailure(true);
  await h.render().props.onSubmit({ preventDefault() {} });
  const consent = h.find(
    (n) => n.type === "input" && n.props.type === "checkbox",
  ).props;
  assert.equal(consent.checked, true);
  assert.equal(h.dropZone().props["aria-disabled"], true);
  h.dropZone().props.onDrop(
    h.event([new File(["%PDF-1.4"], "replacement.pdf")]),
  );
  h.setFailure(false);
  await h.render().props.onSubmit({ preventDefault() {} });
  assert.equal(JSON.parse(h.calls[1].options.body).fileName, "メニュー.pdf");
  assert.equal(
    JSON.parse(h.calls[1].options.body).id,
    JSON.parse(h.calls[0].options.body).id,
  );
});
test("Nested drag enter/leave highlights the zone without flicker and plain text is ignored", () => {
  const h = harness();
  const e = h.event([pdf()]);
  h.dropZone().props.onDragEnter(e);
  h.dropZone().props.onDragEnter(e);
  h.dropZone().props.onDragLeave(e);
  assert.match(h.dropZone().props.className, /dragging/);
  h.dropZone().props.onDragLeave(e);
  assert.doesNotMatch(h.dropZone().props.className, /dragging/);
  const text = h.event([]);
  text.dataTransfer.types = ["text/plain"];
  h.dropZone().props.onDrop(text);
  assert.equal(text.prevented, false);
  assert.equal(h.calls.length, 0);
  h.props.busy = true;
  const busy = h.event([pdf()]);
  h.dropZone().props.onDragOver(busy);
  assert.equal(busy.prevented, true);
  assert.equal(busy.dataTransfer.dropEffect, "none");
});
