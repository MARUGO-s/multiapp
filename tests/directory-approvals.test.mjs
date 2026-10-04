import test from "node:test";
import assert from "node:assert/strict";
import { canBatch, changeOutcome } from "../src/directory-approval-policy.mjs";
test("approval requires a nonempty bounded set and every row permits the action", () => {
  const row = { control: { actions: ["approve"] } };
  assert.equal(canBatch([], "approve"), false);
  assert.equal(canBatch([row], "approve"), true);
  assert.equal(canBatch([row], "suspend"), false);
  assert.equal(canBatch([row, {}], "approve"), false);
  assert.equal(canBatch(Array(20).fill(row), "approve"), true);
  assert.equal(canBatch(Array(21).fill(row), "approve"), false);
});
test("transport and server failures are uncertain, not unsaved", () => {
  for (const error of [new Error("offline"), { status: 503 }, { status: 200 }])
    assert.equal(changeOutcome(error), "unknown");
  for (const status of [400, 401, 403, 404, 409, 429])
    assert.equal(changeOutcome({ status }), "rejected");
});
