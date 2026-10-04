import test from "node:test";
import assert from "node:assert/strict";
import { isDirectoryNavigation } from "../src/directory-routing.mjs";
import { readFileSync } from "node:fs";
test("directory uses only explicit entry or fixed Google return intent", () => {
  assert.equal(isDirectoryNavigation("?admin=users", ""), true);
  assert.equal(
    isDirectoryNavigation("?account=google&code=example", "users"),
    true,
  );
  assert.equal(
    isDirectoryNavigation(
      "?account=google&code=example",
      "https://evil.invalid",
    ),
    false,
  );
  assert.equal(isDirectoryNavigation("?account=recovery", "users"), false);
  assert.equal(isDirectoryNavigation("", "users"), false);
});
test("directory keeps explicit, authenticated change boundaries without browser DB access", () => {
  const handler = readFileSync(
    new URL(
      "../supabase/functions/marugo-directory/handler.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(handler, /req.method !== "GET"/);
  assert.match(handler, /allowed !== true/);
  assert.match(handler, /claims.sub !== user.id/);
  assert.match(handler, /redirect: "error"/);
  const ui = readFileSync(
    new URL("../src/DirectoryEntry.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML/);
  assert.match(ui, /ticket !== epoch.current/);
  assert.match(ui, /アカウント・データは削除しません/);
  assert.match(handler, /marugo_directory_manage_authorized/);
  assert.match(handler, /p_actor: actor/);
});
