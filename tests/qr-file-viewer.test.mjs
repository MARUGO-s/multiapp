import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

function compile(path, imports, globals = {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL(path, import.meta.url), "utf8")
    .replaceAll("import.meta.env.BASE_URL", '"/multiapp/"');
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    ...globals,
    require(name) {
      if (name === "react/jsx-runtime") return jsx;
      assert.ok(name in imports, `Unexpected import ${name}`);
      return imports[name];
    },
  });
  return module.exports;
}
function nodes(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
async function publicViewer(mime, failure = false) {
  const values = [];
  const effects = [];
  let cursor = 0;
  let root;
  const document = { title: "", getElementById: () => ({}) };
  function Preview() {}
  compile("../src/PublicQrFile.tsx", {
    react: {
      useEffect(fn) { effects.push(fn); },
      useState(initial) {
        const i = cursor++;
        if (!(i in values)) values[i] = initial;
        return [values[i], (value) => {
          values[i] = typeof value === "function" ? value(values[i]) : value;
        }];
      },
    },
    "react-dom/client": { createRoot: () => ({ render: (value) => { root = value; } }) },
    "./PdfPreview": { PdfPreview: Preview },
    "./cloud": { SUPABASE_URL: "https://test.invalid", SUPABASE_PUBLISHABLE_KEY: "test" },
    "./qr-file-viewer.css": {},
  }, {
    document,
    location: { search: "?file=abcdefgh1234" },
    URLSearchParams,
    AbortController,
    AbortSignal,
    async fetch() {
      return {
        ok: !failure,
        json: async () => ({
          title: "internal-name-not-for-display",
          fileName: "private-original-name.pdf",
          size: 1024000,
          mime,
          url: "https://test.invalid/view",
          downloadUrl: "https://test.invalid/download",
          error: failure ? "閲覧を停止しています。" : undefined,
        }),
      };
    },
  });
  const render = () => { cursor = 0; return root.type(); };
  render();
  effects[0]();
  await new Promise((resolve) => setImmediate(resolve));
  return { tree: render(), document, Preview };
}

for (const mime of ["application/pdf", "image/png", "image/jpeg"]) {
  test(`Public ${mime} is view-only without filename, metadata or action links`, async () => {
    const { tree, document, Preview } = await publicViewer(mime);
    const all = nodes(tree);
    assert.equal(document.title, "公開ファイル — MARUGO QR");
    assert.equal(all.some((n) => ["a", "nav", "button", "h1"].includes(n.type)), false);
    const serialized = JSON.stringify(tree);
    assert.doesNotMatch(serialized, /internal-name|private-original|download|MB|別画面|表示を更新/);
    if (mime === "application/pdf") {
      const pdf = all.find((n) => n.type === Preview);
      assert.equal(pdf.props.url, "https://test.invalid/view");
      assert.equal(pdf.props.title, undefined);
    } else {
      const image = all.find((n) => n.type === "img");
      assert.equal(image.props.src, "https://test.invalid/view");
      assert.equal(image.props.alt, "公開画像");
      assert.equal(image.props.referrerPolicy, "no-referrer");
    }
  });
}
test("Public HTML renders in a unique-origin sandbox and not as an image", async () => {
  const { tree, Preview } = await publicViewer("text/html");
  const all = nodes(tree);
  const frame = all.find((n) => n.type === "iframe");
  assert.equal(frame.props.src, "https://test.invalid/view");
  assert.equal(frame.props.referrerPolicy, "no-referrer");
  assert.match(frame.props.sandbox, /\ballow-scripts\b/);
  assert.doesNotMatch(frame.props.sandbox, /allow-same-origin|allow-top-navigation/);
  assert.equal(all.some((n) => n.type === "img" || n.type === Preview), false);
  assert.doesNotMatch(JSON.stringify(tree), /private-original|internal-name|download/);
});
test("Unavailable public file retains error and retry without exposing metadata", async () => {
  const { tree } = await publicViewer("application/pdf", true);
  const all = nodes(tree);
  assert.ok(all.some((n) => n.props?.role === "alert"));
  assert.equal(all.filter((n) => n.type === "button").length, 1);
  assert.doesNotMatch(JSON.stringify(tree), /private-original|internal-name|download/);
});
test("PDF has no action buttons on a single page but keeps multi-page navigation", () => {
  function renderPdf(numPages) {
    let cursor = 0;
    const { PdfPreview } = compile("../src/PdfPreview.tsx", {
      react: {
        useEffect() {},
        useRef: () => ({ current: null }),
        useState(initial) {
          return [cursor++ === 0 ? { numPages } : initial, () => {}];
        },
      },
      "pdfjs-dist/legacy/build/pdf.mjs": { GlobalWorkerOptions: {} },
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url": { default: "test-worker" },
    });
    return PdfPreview({ url: "https://test.invalid/view" });
  }
  assert.equal(nodes(renderPdf(1)).filter((n) => n.type === "button").length, 0);
  const pages = nodes(renderPdf(3));
  const buttons = pages.filter((n) => n.type === "button");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].props.disabled, true);
  assert.equal(buttons[1].props.disabled, false);
  assert.equal(pages.find((n) => n.type === "canvas").props["aria-label"], "公開PDF 1ページ");
});
