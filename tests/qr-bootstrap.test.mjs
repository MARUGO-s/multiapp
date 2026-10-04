import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { isTrackingNavigation } from "../src/qr-routing.mjs";
import { isAccountNavigation } from "../src/qr-account-routing.mjs";
import {
  isDirectoryNavigation,
  directoryIntentKey,
} from "../src/directory-routing.mjs";

const source = ts
  .transpileModule(
    readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  )
  .outputText.replace(/^import .*qr-routing.mjs.*;\s*/m, "")
  .replace(/^import .*qr-account-routing.mjs.*;\s*/m, "")
  .replace(/^import .*directory-routing.mjs.*;\s*/m, "")
  .replaceAll("import.meta.env.BASE_URL", JSON.stringify("/multiapp/"))
  .replaceAll("import(", "loadModule(");
function boot(hash, search = "", intent = "") {
  const root = { innerHTML: "" };
  const scripts = [],
    metadata = [],
    imports = [];
  const handlers = {};
  const location = {
    hash,
    search,
    reloads: 0,
    reload() {
      this.reloads++;
    },
  };
  const document = {
    title: "",
    head: { append: (item) => metadata.push(item) },
    body: { append: (item) => scripts.push(item) },
    createElement: () => ({}),
    getElementById: () => root,
  };
  vm.runInNewContext(source, {
    location,
    URLSearchParams,
    window: {
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
    },
    document,
    isTrackingNavigation,
    isAccountNavigation,
    isDirectoryNavigation,
    directoryIntentKey,
    sessionStorage: { getItem: () => intent },
    loadModule: (name) => {
      imports.push(name);
      return Promise.resolve();
    },
  });
  return { root, scripts, metadata, imports, document, location, handlers };
}
test("QR bootstrap avoids authentication and meeting workspace for root tracking links", () => {
  const state = boot("#abcdefgh1234");
  assert.deepEqual(state.imports, ["./tracking.css"]);
  assert.equal(state.scripts[0].src, "/multiapp/marugo/redirect.js");
  assert.match(state.root.innerHTML, /id="status"/);
  assert.equal(
    state.metadata.find((item) => item.name === "referrer").content,
    "no-referrer",
  );
});
test("Admin directory has a dedicated bootstrap and fixed Google return destination", () => {
  for (const state of [
    boot("", "?admin=users"),
    boot("", "?account=google&code=one-use", "users"),
  ]) {
    assert.deepEqual(state.imports, ["./DirectoryEntry"]);
    assert.equal(state.scripts.length, 0);
    assert.equal(
      state.metadata.find((item) => item.name === "referrer").content,
      "no-referrer",
    );
  }
  assert.deepEqual(boot("", "?account=google&code=one-use").imports, [
    "./Workspace",
  ]);
});
test("Workspace bootstrap keeps the common login and application chooser for the plain root", () => {
  const state = boot("");
  assert.deepEqual(state.imports, ["./Workspace"]);
  assert.equal(state.scripts.length, 0);
});
test("Malformed public links show the redirect error screen, not the login", () => {
  assert.deepEqual(boot("#bad").imports, ["./tracking.css"]);
});
test("Pasting a QR URL into an already-open chooser dispatches the tracking page", () => {
  const state = boot("");
  state.location.hash = "#abcdefgh1234";
  state.handlers.hashchange();
  assert.equal(state.location.reloads, 1);
});
test("Public file viewer bypasses login and does not load meeting workspace", () => {
  const state = boot("", "?file=abcdefgh1234");
  assert.deepEqual(state.imports, ["./PublicQrFile"]);
  assert.equal(state.scripts.length, 0);
  assert.equal(
    state.metadata.find((item) => item.name === "robots").content,
    "noindex, nofollow",
  );
});
test("Auth callbacks take precedence over QR fragments and files without logging tokens", () => {
  for (const [hash, search] of [
    ["#access_token=secret&refresh_token=private&type=recovery", ""],
    ["#abcdefgh1234", "?account=recovery&code=one-use&file=abcdefgh1234"],
  ]) {
    const state = boot(hash, search);
    assert.deepEqual(state.imports, ["./Workspace"]);
    assert.equal(state.scripts.length, 0);
    assert.equal(
      state.metadata.find((item) => item.name === "referrer").content,
      "no-referrer",
    );
    state.location.hash = "";
    state.handlers.hashchange();
    assert.equal(state.location.reloads, 0);
    state.location.search = "";
    state.location.hash = "#abcdefgh1234";
    state.handlers.hashchange();
    assert.equal(state.location.reloads, 1);
  }
});
