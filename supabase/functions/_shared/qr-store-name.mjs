import { QR_LOGOS } from "./qr-logos.mjs";

export const QR_STORE_NAME_MAX_LENGTH = 80;

// Validate BEFORE trimming: trimming must not silently remove forbidden controls.
// Length counts Unicode code points, not UTF-16 units. Empty means hidden.
// Lone surrogates are not persistable in PostgreSQL JSONB; /u keeps valid pairs.
export function validateStoreName(value) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u.test(value)
  ) {
    throw new Error("INVALID_STORE_NAME");
  }
  const name = value.trim();
  if ([...name].length > QR_STORE_NAME_MAX_LENGTH) {
    throw new Error("INVALID_STORE_NAME");
  }
  return name;
}

// Preserve absence for old clients: SQL distinguishes omitted from explicit null.
// All non-null captions (including empty) require a selected catalog STORE logo.
export function storeNamePayload(input) {
  if (!Object.hasOwn(input, "storeName")) return {};
  const storeName = validateStoreName(input.storeName);
  if (
    storeName !== null &&
    !QR_LOGOS.some((logo) => logo.id === input.logoId && logo.kind === "store")
  ) {
    throw new Error("INVALID_STORE_NAME");
  }
  return { storeName };
}

export function resolveStoreName(logoId, value) {
  const logo = QR_LOGOS.find((entry) =>
    entry.id === logoId && entry.kind === "store"
  );
  if (!logo) return "";
  return validateStoreName(value) ?? logo.label;
}
