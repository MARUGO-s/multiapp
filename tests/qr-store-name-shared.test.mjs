import test from "node:test";
import assert from "node:assert/strict";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";

const moduleUrl = new URL(
  "../supabase/functions/_shared/qr-store-name.mjs",
  import.meta.url,
);
test("store caption rejects lone UTF-16 surrogates that PostgreSQL JSONB cannot persist", async () => {
  const { validateStoreName } = await import(moduleUrl);
  for (
    const value of [
      "\ud800",
      "\udfff",
      "a\ud800b",
      "\ud800\ud800",
      "\udc00\udfff",
    ]
  ) {
    assert.throws(() => validateStoreName(value), /INVALID_STORE_NAME/);
  }
  assert.equal(validateStoreName("\ud83d\ude00"), "😀");
});

test("store caption shared contract: defaults, hidden, custom, strict single-line Unicode", async () => {
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(moduleUrl), "shared caption validator must exist");
  const { QR_STORE_NAME_MAX_LENGTH, validateStoreName, resolveStoreName } =
    await import(moduleUrl);
  assert.equal(QR_STORE_NAME_MAX_LENGTH, 80);
  assert.equal(validateStoreName(undefined), null);
  assert.equal(validateStoreName(null), null);
  assert.equal(validateStoreName("　 店舗 😀  "), "店舗 😀");
  assert.equal(validateStoreName(" ".repeat(100)), "");
  assert.equal(validateStoreName("😀".repeat(80)), "😀".repeat(80));
  for (
    const value of [
      true,
      false,
      0,
      1,
      {},
      [],
      ["storeName"],
      "😀".repeat(81),
      "a".repeat(81),
    ]
  ) {
    assert.throws(
      () => validateStoreName(value),
      /^Error: INVALID_STORE_NAME$/,
    );
  }
  for (
    const code of [
      ...Array.from({ length: 32 }, (_, i) => i),
      ...Array.from({ length: 33 }, (_, i) => 127 + i),
      0x2028,
      0x2029,
    ]
  ) {
    for (
      const value of [
        String.fromCodePoint(code) + "name",
        "name" + String.fromCodePoint(code),
        "a" + String.fromCodePoint(code) + "b",
      ]
    ) {
      assert.throws(
        () => validateStoreName(value),
        /INVALID_STORE_NAME/,
        String(code),
      );
    }
  }
  assert.equal(QR_LOGOS.length, 38);
  for (const logo of QR_LOGOS) {
    const store = logo.kind === "store";
    assert.equal(resolveStoreName(logo.id, null), store ? logo.label : "");
    assert.equal(resolveStoreName(logo.id, undefined), store ? logo.label : "");
    assert.equal(resolveStoreName(logo.id, ""), "");
    assert.equal(resolveStoreName(logo.id, " Custom "), store ? "Custom" : "");
  }
  for (const id of [null, undefined, "", "unknown", "store-forged", {}]) {
    assert.equal(resolveStoreName(id, "caption"), "");
  }
});
