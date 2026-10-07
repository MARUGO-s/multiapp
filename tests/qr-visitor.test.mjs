import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validVisitorId,
  visitorHash,
} from "../supabase/functions/_shared/qr-visitor.mjs";
const id = "00000000-0000-4000-8000-0000000000ab";
test("Visitor input is an optional UUIDv4, never arbitrary identity or IP", () => {
  for (const value of [undefined, null, id, id.toUpperCase()])
    assert.equal(validVisitorId(value), true);
  for (const value of [
    "",
    "192.0.2.1",
    "someone@example.com",
    7,
    [],
    {},
    "00000000-0000-1000-8000-0000000000ab",
  ])
    assert.equal(validVisitorId(value), false);
});
test("Only stable per-QR hashes enter storage; bots/unknown identity remain null", async () => {
  const a = await visitorHash("abcdefgh1234", id, "mobile");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(
    a,
    await visitorHash("abcdefgh1234", id.toUpperCase(), "desktop"),
  );
  assert.notEqual(a, await visitorHash("otherqr12345", id, "mobile"));
  assert.notEqual(
    a,
    await visitorHash(
      "abcdefgh1234",
      "00000000-0000-4000-8000-0000000000ac",
      "mobile",
    ),
  );
  assert.equal(await visitorHash("abcdefgh1234", id, "bot"), null);
  assert.equal(await visitorHash("abcdefgh1234", null, "mobile"), null);
  assert.equal(await visitorHash("abcdefgh1234", undefined, "mobile"), null);
});
