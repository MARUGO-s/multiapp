import test from "node:test";
import assert from "node:assert/strict";
import {
  QR_LOGOS,
  QR_LOGO_CATALOG_HEADER,
  QR_LOGO_CATALOG_VALUE,
  supportsQrLogoPayload,
} from "../supabase/functions/_shared/qr-logos.mjs";

// Exact pre-capability catalog, not derived from today's expanding metadata.
const legacyIds = [
  "instagram-black",
  "instagram-gradient",
  "instagram-white",
  "line-android",
  "line-ios",
  "line-icons8-100",
  "line-icons8-50",
  "instagram-icons8-100",
  "instagram-icons8-50",
  "x-icons8-100",
  "x-icons8-50",
  "facebook-icons8-100",
  "facebook-icons8-48",
  "facebook-icons8-50",
  "facebook-icons8-96",
];

test("catalog capability is ASCII CSV of every bundled ID, not a version or credential", () => {
  assert.equal(QR_LOGO_CATALOG_HEADER, "x-qr-logo-catalog");
  assert.equal(
    QR_LOGO_CATALOG_VALUE,
    QR_LOGOS.map((logo) => logo.id).join(","),
  );
  assert.equal(QR_LOGO_CATALOG_VALUE.split(",").length, 38);
  assert.match(QR_LOGO_CATALOG_VALUE, /^[a-z0-9-]+(?:,[a-z0-9-]+)*$/);
  assert.ok(QR_LOGO_CATALOG_VALUE.length <= 4096);
});

test("no-header payload compatibility is permanently the original 15 IDs plus null/missing", () => {
  assert.equal(legacyIds.length, 15);
  for (const header of [null, undefined]) {
    for (const logo_id of [...legacyIds, null, undefined]) {
      assert.equal(
        supportsQrLogoPayload({ links: [{ logo_id }] }, header),
        true,
      );
    }
    for (const logo_id of [
      "store-marugo-d",
      "future-sns-logo",
      "",
      1,
      false,
      {},
    ]) {
      assert.equal(supportsQrLogoPayload({ logo_id }, header), false);
    }
    assert.equal(supportsQrLogoPayload({ links: [], total: 0 }, header), true);
  }
});

test("capability checks all nested response rows without mutating fields or coercing IDs", () => {
  const data = {
    links: QR_LOGOS.map((logo) => ({ logo_id: logo.id, title: "keep me" })),
    more: { link: { logo_id: "future-logo-v2", id: "stable-request-id" } },
  };
  const before = structuredClone(data);
  assert.equal(supportsQrLogoPayload(data, QR_LOGO_CATALOG_VALUE), false);
  assert.equal(
    supportsQrLogoPayload(data, `${QR_LOGO_CATALOG_VALUE},future-logo-v2`),
    true,
  );
  assert.deepEqual(data, before);
  for (const payload of [
    { logo_id: "store-marugo-d" },
    [{ logo_id: "store-marugo-d" }],
    { link: { logo_id: "store-marugo-d" } },
    { nested: [{ deeper: { logo_id: "store-marugo-d" } }] },
  ]) {
    assert.equal(supportsQrLogoPayload(payload, "line-ios"), false);
    assert.equal(supportsQrLogoPayload(payload, "store-marugo-d"), true);
  }
  assert.equal(supportsQrLogoPayload({ logo_id: 1 }, "1"), false);
  assert.equal(
    supportsQrLogoPayload({ logo_id: "LINE-IOS" }, "line-ios"),
    false,
  );
});

test("malformed or overlong catalog headers fail closed, while null/missing payload logos remain usable", () => {
  const validAtLimit = `line-ios,${"x".repeat(4096 - "line-ios,".length)}`;
  assert.equal(validAtLimit.length, 4096);
  assert.equal(
    supportsQrLogoPayload({ logo_id: "line-ios" }, validAtLimit),
    true,
  );
  for (const header of [
    `${validAtLimit}x`,
    "",
    "line-ios,",
    ",line-ios",
    "line-ios,,store-marugo-d",
    "line-ios,*",
    "line-ios,LINE-IOS",
    "line-ios, x",
    "line-ios,x ",
    "line-ios,https://example.invalid/a",
    "line-ios,../a",
    "line-ios,店舗",
    "line-ios,\nother",
    "line-ios,\u0000",
    1,
    false,
    {},
    [],
  ]) {
    assert.equal(
      supportsQrLogoPayload({ logo_id: "line-ios" }, header),
      false,
      JSON.stringify(header),
    );
    assert.equal(supportsQrLogoPayload({ logo_id: null }, header), true);
    assert.equal(supportsQrLogoPayload({ removed: true }, header), true);
  }
  assert.equal(
    supportsQrLogoPayload({ logo_id: "line-ios" }, "line-ios,line-ios"),
    true,
  );
});
