import test from "node:test";
import assert from "node:assert/strict";
import {
  gourmetManagementUrl,
  GOURMET_USERS_URL,
} from "../src/directory-management-links.mjs";
test("gourmet user management uses a fixed link without transmitting central sessions", () => {
  assert.equal(
    GOURMET_USERS_URL,
    "https://marugo-s.github.io/gourmet/?view=users",
  );
  assert.equal(gourmetManagementUrl("gourmet"), GOURMET_USERS_URL);
  for (const app of [
    "sns",
    "recipe",
    "unassigned",
    "https://evil.invalid",
    null,
  ])
    assert.equal(gourmetManagementUrl(app), null);
  assert.deepEqual(
    [...new URL(GOURMET_USERS_URL).searchParams.keys()],
    ["view"],
  );
});
