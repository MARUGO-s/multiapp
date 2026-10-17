// Real TSX render/event/effect handlers; only local I/O boundaries are faked.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as files from "../supabase/functions/_shared/qr-files.mjs";
import * as selection from "../src/qr-file-selection.mjs";
import * as logos from "../supabase/functions/_shared/qr-logos.mjs";

const LogoPicker = function QrLogoPicker() {};
const FileUpload = function QrFileUpload() {};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const row = (overrides = {}) => ({
  id: "link-a",
  code: "abcdefgh1234",
  title: "店頭案内",
  target_url: "https://example.test/menu",
  scan_count: 23,
  active: true,
  created_at: "2026-10-01T00:00:00Z",
  last_accessed_at: null,
  deleted_at: null,
  logo_id: null,
  ...overrides,
});
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(component = "QrPage", options = {}) {
  const state = {
    rows: options.rows || [],
    api: options.api,
    image: options.image,
  };
  const slots = [],
    effects = [],
    timers = new Map(),
    calls = [],
    images = [],
    notices = [];
  let cursor = 0,
    timerId = 0,
    lastTree;
  const props =
    component === "QrPage"
      ? { notify: (value) => notices.push(value), ...options.props }
      : component === "QrFileUpload"
        ? {
            busy: false,
            logoId: null,
            onLogoChange(value) {
              props.logoId = value;
            },
            onBusy(value) {
              props.busy = value;
            },
            onCreated(value) {
              calls.push({ created: value });
            },
            ...options.props,
          }
        : {
            value: null,
            onChange(value) {
              props.value = value;
            },
            ...options.props,
          };
  const changed = (a, b) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!slots[i])
        slots[i] = {
          value: typeof initial === "function" ? initial() : initial,
        };
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
    useId() {
      const i = cursor++;
      return `test-${component}-${i}`;
    },
    useCallback(callback, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps))
        slots[i] = { value: callback, deps };
      return slots[i].value;
    },
    useEffect(callback, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) {
        const old = slots[i];
        slots[i] = { deps, cleanup: old?.cleanup };
        effects.push(() => {
          old?.cleanup?.();
          slots[i].cleanup = callback();
        });
      }
    },
  };
  const api = async (path, request) => {
    calls.push({ path, options: request });
    if (state.api) {
      const result = state.api(path, request);
      if (result !== undefined) return await result;
    }
    if (path.startsWith("/links?"))
      return { links: state.rows, total: state.rows.length };
    if (path.includes("/history?")) return { events: [], total: 0 };
    throw new Error(`Unconfigured local API ${path}`);
  };
  const module = { exports: {} };
  const source = readFileSync(
    new URL(`../src/${component}.tsx`, import.meta.url),
    "utf8",
  ).replaceAll("import.meta.env.BASE_URL", JSON.stringify("/multiapp/"));
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const uploads = [];
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    crypto: globalThis.crypto,
    Uint8Array,
    Error,
    Promise,
    document: { hidden: false },
    window: { addEventListener() {}, removeEventListener() {} },
    setInterval(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    XMLHttpRequest: class {
      upload = {};
      status = 200;
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader() {}
      send(file) {
        uploads.push({ file, url: this.url });
        this.onload();
      }
    },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return jsx;
      if (name === "lucide-react")
        return new Proxy({}, { get: () => () => null });
      if (name === "./cloud") return { isCloud: true };
      if (name === "./qr-api")
        return {
          useQrApi: () => api,
          trackingUrl: (code, source) =>
            `https://local.test/multiapp/?s=${source === "qr" ? "q" : "b"}#${code}`,
        };
      if (name === "./qr-image.mjs")
        return {
          qrImageDataUrl: (...args) => {
            images.push(args);
            return state.image
              ? state.image(...args)
              : Promise.resolve(`data:image/png;local,${args[1] || "none"}`);
          },
        };
      if (name === "qrcode")
        return {
          default: {
            toDataURL: () => Promise.resolve("data:image/png;old-renderer"),
          },
        };
      if (name === "./QrLogoPicker") return { QrLogoPicker: LogoPicker };
      if (name === "./QrFileUpload") return { QrFileUpload: FileUpload };
      if (name === "./QrAnalytics") return { QrAnalytics: () => null };
      if (name === "./Modal") return { Modal: () => null };
      if (name === "./qr-lifecycle.mjs")
        return {
          lifecycleRequest() {
            throw new Error("Not used");
          },
        };
      if (name === "./qr-labels.mjs")
        return { sourceLabels: {}, deviceLabels: {}, browserLabels: {} };
      if (name.endsWith("qr-files.mjs")) return files;
      if (name.endsWith("qr-file-selection.mjs")) return selection;
      if (name.endsWith("qr-logos.mjs")) return logos;
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const flushEffects = () => {
    while (effects.length) effects.shift()();
  };
  const render = (flush = true) => {
    cursor = 0;
    lastTree = module.exports[component](props);
    if (flush) flushEffects();
    return lastTree;
  };
  const all = (predicate, node = render()) => {
    if (!node || typeof node !== "object") return [];
    const matches = predicate(node) ? [node] : [];
    for (const child of [node.props?.children].flat(Infinity)) {
      if (child !== undefined) matches.push(...all(predicate, child));
    }
    return matches;
  };
  const find = (predicate, node) => all(predicate, node)[0] || null;
  const picker = () => find((n) => n.type === LogoPicker);
  return {
    props,
    state,
    calls,
    images,
    uploads,
    notices,
    render,
    all,
    find,
    picker,
    paint: () => render(false),
    flushEffects,
    async settle() {
      for (let i = 0; i < 5; i++) {
        render();
        await tick();
      }
      return render();
    },
    poll() {
      for (const callback of [...timers.values()]) callback();
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}
const submit = (h) =>
  h
    .find((n) => n.type === "form" && n.props.className === "qr-create-card")
    .props.onSubmit({ preventDefault() {} });
const urlFields = (h) => {
  h.find((n) => n.type === "input" && n.props.maxLength === 120).props.onChange(
    { target: { value: "  秋のお知らせ  " } },
  );
  h.find((n) => n.type === "input" && n.props.type === "url").props.onChange({
    target: { value: "  https://example.test/autumn  " },
  });
};
const creationPicker = (h) =>
  h
    .all((n) => n.type === LogoPicker)
    .find((n) => n.props.label !== "登録済みQRのロゴ");
const detailPicker = (h) =>
  h
    .all((n) => n.type === LogoPicker)
    .find((n) => n.props.label === "登録済みQRのロゴ");
const button = (h, text) =>
  h.find(
    (n) =>
      n.type === "button" && [n.props.children].flat(Infinity).includes(text),
  );
const chooseRow = (h, id = "link-a") =>
  h.find((n) => n.type === "button" && n.key === id).props.onClick();
const pdf = (name = "メニュー.pdf") =>
  new File(["%PDF-1.4\n"], name, { type: "application/pdf" });
const selectFile = (h, file) => {
  h.find((n) => n.type === "input" && n.props.type === "file").props.onChange({
    target: { files: [file] },
  });
  h.find(
    (n) => n.type === "input" && n.props.type === "checkbox",
  ).props.onChange({ target: { checked: true } });
};

test("Logo picker renders every allowlisted image with native labeled radio controls and production base", () => {
  assert.ok(
    existsSync(new URL("../src/QrLogoPicker.tsx", import.meta.url)),
    "shared logo picker is implemented",
  );
  const h = harness("QrLogoPicker");
  const radios = h.all((n) => n.type === "input" && n.props.type === "radio");
  assert.equal(radios.length, 16);
  assert.equal(new Set(radios.map((n) => n.props.name)).size, 1);
  assert.equal(radios[0].props.checked, true);
  const images = h.all((n) => n.type === "img");
  assert.equal(images.length, 15);
  for (const logo of logos.QR_LOGOS) {
    const label = h.find(
      (n) =>
        n.type === "label" &&
        h.find(
          (child) => child.type === "input" && child.props.value === logo.id,
          n,
        ),
    );
    assert.ok(label, `${logo.id} has an accessible wrapping label`);
    assert.ok(
      h.find(
        (n) =>
          n.type === "img" && n.props.src === `/multiapp/qr-logos/${logo.file}`,
        label,
      ),
    );
    assert.ok(
      [label.props.children]
        .flat(Infinity)
        .some((n) => n?.props?.children === logo.label),
    );
  }
  radios[1].props.onChange();
  assert.equal(h.props.value, logos.QR_LOGOS[0].id);
  assert.equal(
    h
      .all((n) => n.type === "input" && n.props.type === "radio")
      .filter((n) => n.props.checked).length,
    1,
  );
  h.props.disabled = true;
  assert.equal(h.find((n) => n.type === "fieldset").props.disabled, true);
  h.all(
    (n) => n.type === "input" && n.props.type === "radio",
  )[0].props.onChange();
  assert.equal(
    h.props.value,
    logos.QR_LOGOS[0].id,
    "locked handlers cannot change selection",
  );
});

test("Logo gallery styling keeps compact disclosures, fluid choices and visible keyboard focus", () => {
  const h = harness("QrLogoPicker");
  assert.ok(h.find((n) => n.type === "details"));
  assert.ok(h.find((n) => n.type === "summary"));
  const css = readFileSync(new URL("../src/qr.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.qr-logo-options\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(auto-fit,/,
  );
  assert.match(css, /\.qr-logo-option:focus-within\s*\{[^}]*outline:/);
  assert.match(
    css,
    /\.qr-create-card\s*>\s*\.qr-logo-picker\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
  );
});

test("URL creation snapshots the selected logo and unchanged retries reuse the request ID", async () => {
  const h = harness("QrPage", {
    api(path) {
      if (path === "/links") throw new Error("local offline");
    },
  });
  await h.settle();
  urlFields(h);
  const picker = creationPicker(h);
  assert.ok(picker, "URL creation offers a logo picker");
  assert.equal(picker.props.value, null);
  picker.props.onChange("instagram-gradient");
  await submit(h);
  await submit(h);
  const bodies = h.calls
    .filter((c) => c.path === "/links")
    .map((c) => JSON.parse(c.options.body));
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], {
    id: bodies[0].id,
    title: "秋のお知らせ",
    targetUrl: "https://example.test/autumn",
    logoId: "instagram-gradient",
  });
  assert.deepEqual(bodies[1], bodies[0]);
  creationPicker(h).props.onChange("line-ios");
  await submit(h);
  const changed = JSON.parse(
    h.calls.filter((c) => c.path === "/links")[2].options.body,
  );
  assert.notEqual(changed.id, bodies[0].id);
  assert.equal(changed.logoId, "line-ios");
  assert.match(
    h.find((n) => n.props?.role === "alert").props.children,
    /同じ内容で再試行/,
  );
});

test("Detail logo edits stay drafts across polling and save only the server-confirmed row", async () => {
  const saving = deferred(),
    staleList = deferred();
  let hold = false;
  const original = row();
  const h = harness("QrPage", {
    rows: [original],
    api(path) {
      if (path.endsWith("/logo")) return saving.promise;
      if (path.startsWith("/links?") && hold) {
        hold = false;
        return staleList.promise;
      }
    },
  });
  await h.settle();
  chooseRow(h);
  await h.settle();
  const picker = detailPicker(h);
  assert.ok(picker, "existing QR detail offers a separate editable logo draft");
  assert.equal(picker.props.value, null);
  assert.equal(button(h, "ロゴを保存").props.disabled, true);
  picker.props.onChange("line-ios");
  assert.equal(
    h.calls.filter((c) => c.path?.endsWith("/logo")).length,
    0,
    "selection alone does not persist",
  );
  assert.equal(
    h.find((n) => n.type === "a" && n.props.download).props.href,
    "data:image/png;local,none",
  );
  h.state.rows = [row({ scan_count: 24, logo_id: "instagram-black" })];
  h.poll();
  await h.settle();
  assert.equal(
    detailPicker(h).props.value,
    "line-ios",
    "ten-second polls preserve a pending draft",
  );
  assert.equal(button(h, "ロゴを保存").props.disabled, false);
  hold = true;
  h.poll();
  const result = button(h, "ロゴを保存").props.onClick();
  assert.equal(detailPicker(h).props.disabled, true);
  assert.equal(button(h, "ロゴを保存").props.disabled, true);
  assert.equal(
    h.find((n) => n.props?.["aria-label"] === "QR詳細を閉じる").props.disabled,
    true,
  );
  assert.equal(
    h.find((n) => n.type === "button" && n.key === original.id).props.disabled,
    true,
  );
  const request = h.calls.find((c) => c.path?.endsWith("/logo"));
  assert.equal(request.path, "/links/link-a/logo");
  assert.deepEqual(plain(request.options), {
    method: "PATCH",
    body: JSON.stringify({ logoId: "line-ios" }),
  });
  saving.resolve(row({ logo_id: "line-ios", scan_count: 24 }));
  await result;
  staleList.resolve({ links: [original], total: 1 });
  await h.settle();
  assert.equal(detailPicker(h).props.value, "line-ios");
  assert.equal(button(h, "ロゴを保存").props.disabled, true);
  assert.equal(
    h.find((n) => n.type === "a" && n.props.download).props.href,
    "data:image/png;local,line-ios",
  );
  assert.equal(
    h.find((n) => n.props?.className === "qr-count").props.children[0],
    "24",
  );
  assert.ok(
    h.find(
      (n) =>
        n.type === "input" &&
        n.props.readOnly &&
        n.props.value.endsWith("#abcdefgh1234"),
    ),
  );
  assert.ok(h.notices.some((n) => /ロゴ/.test(n)));
});

test("Late save errors cannot appear in another QR detail", async () => {
  const saving = deferred();
  const h = harness("QrPage", {
    rows: [
      row(),
      row({ id: "link-b", code: "secondqr1234", logo_id: "line-ios" }),
    ],
    api(path) {
      if (path.endsWith("/logo")) return saving.promise;
    },
  });
  await h.settle();
  chooseRow(h);
  await h.settle();
  const chooseOther = h.find((n) => n.type === "button" && n.key === "link-b")
    .props.onClick;
  detailPicker(h).props.onChange("instagram-black");
  const result = button(h, "ロゴを保存").props.onClick();
  chooseOther();
  await h.settle();
  saving.reject(new Error("old detail request failed"));
  await result;
  await h.settle();
  assert.equal(detailPicker(h).props.value, "line-ios");
  assert.equal(
    h.find((n) => n.props?.role === "alert"),
    null,
    "stale errors belong to the original detail, not the current one",
  );
  assert.equal(h.notices.length, 0);
});

test("Logo removal failures keep the saved image and draft until an explicit server confirmation", async () => {
  let reply = 0;
  const legacy = row();
  delete legacy.logo_id;
  const h = harness("QrPage", {
    rows: [row({ logo_id: "instagram-gradient" })],
    api(path) {
      if (!path.endsWith("/logo")) return;
      if (++reply === 1) throw new Error("local save offline");
      if (reply === 2) return legacy;
      return row({ logo_id: null });
    },
  });
  await h.settle();
  chooseRow(h);
  await h.settle();
  detailPicker(h).props.onChange(null);
  await button(h, "ロゴを保存").props.onClick();
  await h.settle();
  assert.equal(detailPicker(h).props.value, null);
  assert.equal(button(h, "ロゴを保存").props.disabled, false);
  assert.match(
    h.find((n) => n.props?.role === "alert").props.children,
    /local save offline/,
  );
  assert.equal(h.notices.length, 0);
  assert.equal(
    h.find((n) => n.type === "a" && n.props.download).props.href,
    "data:image/png;local,instagram-gradient",
  );
  await button(h, "ロゴを保存").props.onClick();
  await h.settle();
  assert.equal(
    h.notices.length,
    0,
    "a legacy/mismatched response is not proof the logo was saved",
  );
  assert.equal(button(h, "ロゴを保存").props.disabled, false);
  assert.ok(h.find((n) => n.props?.role === "alert"));
  assert.equal(
    h.find((n) => n.type === "a" && n.props.download).props.href,
    "data:image/png;local,instagram-gradient",
  );
  await button(h, "ロゴを保存").props.onClick();
  await h.settle();
  assert.equal(h.notices.length, 1);
  assert.equal(button(h, "ロゴを保存").props.disabled, true);
  assert.equal(
    h.find((n) => n.props?.role === "alert"),
    null,
  );
  assert.equal(
    h.find((n) => n.type === "a" && n.props.download).props.href,
    "data:image/png;local,none",
  );
  for (const call of h.calls.filter((c) => c.path?.endsWith("/logo")))
    assert.deepEqual(JSON.parse(call.options.body), { logoId: null });
});

test("Stored logos regenerate through the verified renderer and old PNGs disappear before effects", async () => {
  const nextImage = deferred();
  const h = harness("QrPage", {
    rows: [row({ logo_id: "instagram-gradient" })],
    image(text, logo) {
      return logo === "line-ios"
        ? nextImage.promise
        : Promise.resolve(`data:image/png;local,${logo}`);
    },
  });
  await h.settle();
  chooseRow(h);
  await h.settle();
  assert.equal(
    h.images.length,
    1,
    "saved logos use qrImageDataUrl rather than the legacy QR-only renderer",
  );
  assert.deepEqual(plain(h.images[0]), [
    "https://local.test/multiapp/?s=q#abcdefgh1234",
    "instagram-gradient",
    "/multiapp/",
  ]);
  let download = h.find((n) => n.type === "a" && n.props.download);
  assert.equal(download.props.href, "data:image/png;local,instagram-gradient");
  h.state.rows = [row({ logo_id: "line-ios" })];
  h.poll();
  await tick();
  const paint = h.paint();
  download = h.find((n) => n.type === "a" && n.props.download, paint);
  assert.equal(
    download.props.href,
    undefined,
    "a previous logo image must never remain downloadable for the new saved selection",
  );
  assert.equal(download.props["aria-disabled"], true);
  let prevented = false;
  download.props.onClick({
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  h.flushEffects();
  await h.settle();
  assert.equal(h.images.at(-1)[1], "line-ios");
  nextImage.resolve("data:image/png;local,line-ios");
  await h.settle();
  assert.equal(
    h.find((n) => n.type === "a" && n.props.download).props.href,
    "data:image/png;local,line-ios",
  );
});

test("Renderer failures remain visible without a blank-logo fallback and stale generations are ignored", async () => {
  const first = deferred();
  const h = harness("QrPage", {
    rows: [
      row({ logo_id: "instagram-black" }),
      row({ id: "link-b", code: "secondqr1234", logo_id: "line-ios" }),
    ],
    image(text, logo) {
      return logo === "instagram-black"
        ? first.promise
        : Promise.reject(
            new Error(
              "このQRには中央にロゴを安全に配置できません。「ロゴなし」を選んでください。",
            ),
          );
    },
  });
  await h.settle();
  chooseRow(h);
  await h.settle();
  chooseRow(h, "link-b");
  await h.settle();
  assert.ok(
    h.find((n) => n.props?.role === "alert"),
    "failed logo render exposes an error",
  );
  assert.match(
    h.find((n) => n.props?.role === "alert").props.children,
    /ロゴなし/,
  );
  assert.equal(
    h.find((n) => n.type === "a" && n.props.download).props["aria-disabled"],
    true,
  );
  assert.deepEqual(
    h.images.map((args) => args[1]),
    ["instagram-black", "line-ios"],
    "a logo failure never retries the renderer with null",
  );
  first.resolve("data:image/png;stale,instagram-black");
  await h.settle();
  assert.equal(
    h.find((n) => n.type === "a" && n.props.download).props.href,
    undefined,
  );
  assert.ok(h.find((n) => n.props?.role === "alert"));
  h.unmount();
});

test("Legacy QR rows without logo_id regenerate as no-logo and creation sends an explicit null", async () => {
  const legacy = row();
  delete legacy.logo_id;
  const h = harness("QrPage", {
    rows: [legacy],
    api(path, options) {
      if (path === "/links") return row({ id: JSON.parse(options.body).id });
    },
  });
  await h.settle();
  chooseRow(h);
  await h.settle();
  assert.equal(detailPicker(h).props.value, null);
  assert.equal(h.images[0][1], null);
  urlFields(h);
  await submit(h);
  await h.settle();
  assert.equal(
    JSON.parse(h.calls.find((c) => c.path === "/links").options.body).logoId,
    null,
  );
});

test("Successful creation resets the shared logo without stale refresh clearing the new detail", async () => {
  const creating = deferred(),
    oldList = deferred();
  let holdList = false;
  const h = harness("QrPage", {
    api(path) {
      if (path === "/links") return creating.promise;
      if (path.startsWith("/links?") && holdList) {
        holdList = false;
        return oldList.promise;
      }
    },
  });
  await h.settle();
  urlFields(h);
  const fileForm = () => h.find((n) => n.type === FileUpload);
  assert.equal(
    typeof fileForm().props.onLogoChange,
    "function",
    "file and URL creation share the catalog selection",
  );
  fileForm().props.onLogoChange("line-ios");
  assert.equal(creationPicker(h).props.value, "line-ios");
  holdList = true;
  h.poll();
  const request = submit(h);
  assert.equal(creationPicker(h).props.disabled, true);
  assert.equal(fileForm().props.busy, true);
  creating.resolve(row({ logo_id: "line-ios" }));
  await request;
  oldList.resolve({ links: [], total: 0 });
  await h.settle();
  assert.equal(creationPicker(h).props.value, null);
  assert.equal(fileForm().props.logoId, null);
  assert.equal(
    h.find((n) => n.type === "input" && n.props.type === "url").props.value,
    "",
  );
  assert.ok(
    h.find((n) => n.props?.["aria-label"] === "QRコードの詳細"),
    "an eventually consistent empty list cannot close the created record",
  );
  fileForm().props.onLogoChange("instagram-black");
  fileForm().props.onCreated(
    row({ id: "file-link", code: "filecode1234", logo_id: "instagram-black" }),
  );
  await h.settle();
  assert.equal(
    creationPicker(h).props.value,
    null,
    "successful file creation also resets the shared draft",
  );
  assert.ok(
    h.find(
      (n) =>
        n.type === "a" && n.props.download === "marugo-qr-filecode1234.png",
    ),
  );
});

test("Pending file attempts lock the shared creation picker until discard is confirmed", async () => {
  const discarded = deferred(),
    pendingChanges = [];
  const upload = harness("QrFileUpload", {
    props: {
      logoId: "line-ios",
      onPendingChange(value) {
        pendingChanges.push(value);
      },
    },
    api(path, options) {
      if (path === "/uploads") throw new Error("local unknown result");
      if (options.method === "DELETE") return discarded.promise;
    },
  });
  selectFile(upload, pdf());
  await upload.render().props.onSubmit({ preventDefault() {} });
  await upload.settle();
  assert.equal(
    pendingChanges.at(-1),
    true,
    "parent knows when an upload retry has a frozen selection",
  );
  assert.equal(upload.picker().props.disabled, true);
  const page = harness();
  await page.settle();
  const fileForm = () => page.find((n) => n.type === FileUpload);
  assert.equal(typeof fileForm().props.onPendingChange, "function");
  fileForm().props.onPendingChange(true);
  assert.equal(creationPicker(page).props.disabled, true);
  assert.equal(
    page.find((n) => n.props?.id === "qr-create-link-tab").props.disabled,
    true,
  );
  assert.equal(
    page.find((n) => n.type === "input" && n.props.type === "url").props
      .disabled,
    true,
  );
  const discard = button(upload, "未公開のアップロードを破棄").props.onClick();
  assert.equal(upload.picker().props.disabled, true);
  discarded.resolve({ discarded: true });
  await discard;
  await upload.settle();
  assert.equal(pendingChanges.at(-1), false);
  assert.equal(upload.picker().props.disabled, false);
  fileForm().props.onPendingChange(false);
  assert.equal(creationPicker(page).props.disabled, false);
});

test("File publication freezes logo, title and file for same-ID retries and bodyless completion", async () => {
  let attempt = 0;
  const h = harness("QrFileUpload", {
    props: { logoId: "line-ios" },
    api(path) {
      if (path === "/uploads") {
        if (++attempt === 1) throw new Error("local upload offline");
        return {
          uploadUrl: "https://storage.local.test/upload",
          mime: "application/pdf",
        };
      }
      if (path.endsWith("/complete")) return row({ logo_id: "line-ios" });
    },
  });
  const original = pdf();
  selectFile(h, original);
  assert.ok(h.picker(), "file creation offers the same logo picker");
  assert.equal(h.picker().props.value, "line-ios");
  await h.render().props.onSubmit({ preventDefault() {} });
  assert.equal(
    h.picker().props.disabled,
    true,
    "unknown publication locks the logo until retry/discard",
  );
  assert.equal(
    h.find((n) => n.type === "input" && n.props.type === "file").props.disabled,
    true,
  );
  const first = JSON.parse(h.calls[0].options.body);
  assert.equal(first.logoId, "line-ios");
  h.props.logoId = "instagram-black";
  h.find((n) => n.type === "input" && n.props.maxLength === 120).props.onChange(
    { target: { value: "changed behind disabled input" } },
  );
  h.find((n) => n.type === "input" && n.props.type === "file").props.onChange({
    target: { files: [pdf("other.pdf")] },
  });
  assert.equal(
    h.picker().props.value,
    "line-ios",
    "pending UI describes the frozen attempt",
  );
  await h.render().props.onSubmit({ preventDefault() {} });
  const requests = h.calls.filter((c) => c.path);
  assert.deepEqual(JSON.parse(requests[1].options.body), first);
  assert.equal(h.uploads[0].file, original);
  assert.equal(requests[2].path, `/uploads/${first.id}/complete`);
  assert.deepEqual(plain(requests[2].options), { method: "POST" });
  assert.equal(h.calls.find((c) => c.created).created.logo_id, "line-ios");
  assert.equal(h.picker().props.disabled, false);
});
