import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/404.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function open(pathname, search = "") {
  let replaced = null;
  const location = {
    pathname,
    search,
    replace(url) {
      replaced = url;
    },
  };
  vm.runInNewContext(script, { location, URLSearchParams });
  return replaced;
}

test("missing HTML card page forwards to the same measured file URL", () => {
  assert.ok(script, "404.html has an inline script");
  assert.equal(open("/s/0xu4TtkOWyR6.html", "?s=q"), "/?s=q#0xu4TtkOWyR6");
  assert.equal(open("/s/0xu4TtkOWyR6.html", "?s=b"), "/?s=b#0xu4TtkOWyR6");
  assert.equal(open("/s/Ab_-cd12EF34.html", ""), "/?s=l#Ab_-cd12EF34");
  assert.equal(open("/s/Ab_-cd12EF34.html", "?s=evil"), "/?s=l#Ab_-cd12EF34");
});

test("project-path deployments keep their base path", () => {
  assert.equal(open("/multiapp/s/0xu4TtkOWyR6.html", "?s=q"), "/multiapp/?s=q#0xu4TtkOWyR6");
});

test("other missing pages are not redirected and never echo the path", () => {
  for (const path of ["/nope", "/s/short.html", "/s/0xu4TtkOWyR6.htm", "/s/0xu4TtkOWyR6.html/x", "//evil.example/s/0xu4TtkOWyR6.html"])
    assert.equal(open(path, "?s=q"), null, path);
  assert.doesNotMatch(html, /innerHTML|document\.write/);
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /noindex/);
});
