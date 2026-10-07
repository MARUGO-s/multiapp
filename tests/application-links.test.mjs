import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { applicationLinks } from "../src/application-links.mjs";

const expected = [
  "https://marugo-s.github.io/line_report/",
  "https://marugo-s.github.io/app/",
  "https://marugo-s.github.io/management/",
  "https://marugo-s.github.io/line_report/chat.html",
  "https://marugo-s.github.io/line_report/jnm/jnl2txt.html",
  "https://marugo-s.github.io/gourmet/",
  "https://marugo-s.github.io/sns_management/",
];

test("Application launcher preserves all seven exact public destinations without credentials", () => {
  assert.deepEqual(
    applicationLinks.map((app) => app.href),
    expected,
  );
  assert.equal(new Set(applicationLinks.map((app) => app.id)).size, 7);
  for (const app of applicationLinks) {
    const url = new URL(app.href);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "marugo-s.github.io");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.ok(app.name && app.note);
  }
});

test("Launcher preserves seven app links and adds a separate admin-only destination", () => {
  const source = readFileSync(
    new URL("../src/ExternalApplications.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts
    .transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replaceAll(
      "import.meta.env.BASE_URL",
      JSON.stringify("/multiapp/"),
    );
  const module = { exports: {} };
  const dependency = createRequire(import.meta.url);
  new Function("require", "module", "exports", compiled)(
    (name) =>
      name === "./application-links.mjs"
        ? { applicationLinks }
        : dependency(name),
    module,
    module.exports,
  );
  const html = renderToStaticMarkup(
    React.createElement(module.exports.ExternalApplications),
  );
  assert.deepEqual(
    [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
    [...expected, "/multiapp/?admin=users"],
  );
  assert.equal((html.match(/<a /g) || []).length, 8);
  assert.match(html, /登録ユーザー管理（管理者専用）/);
  assert.match(html, /<nav[^>]+aria-labelledby="external-applications-title"/);
  assert.match(html, /id="external-applications-title"/);
  assert.ok(!html.includes('target="_blank"'));
  assert.ok(!html.includes("<form"));
  for (const app of applicationLinks) {
    assert.ok(html.includes(`<strong>${app.name}</strong>`));
    assert.ok(html.includes(`<small>${app.note}</small>`));
  }
});

test("mimiyori launcher describes review and gourmet-site management, not reservations", () => {
  assert.deepEqual(
    applicationLinks.find((app) => app.id === "gourmet"),
    {
      id: "gourmet",
      name: "mimiyori",
      note: "口コミ・グルメサイト管理",
      icon: "gourmet",
      href: "https://marugo-s.github.io/gourmet/",
    },
  );
});

test("SNS launcher opens Instatic TalksX without adding it to shared login", () => {
  assert.deepEqual(
    applicationLinks.find((app) => app.id === "sns"),
    {
      id: "sns",
      name: "Instatic TalksX",
      note: "SNS一括管理",
      icon: "sns",
      href: "https://marugo-s.github.io/sns_management/",
    },
  );
  const authGate = readFileSync(
    new URL("../src/AuthGate.tsx", import.meta.url),
    "utf8",
  );
  assert.match(authGate, /type Application = "kotonoha" \| "qr";/);
  assert.ok(!authGate.includes("sns_management"));
});
