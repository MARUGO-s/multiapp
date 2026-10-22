import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  attachmentTypes,
  isImageAttachment,
  validateAttachmentBytes,
  validateAttachments,
} from "../supabase/functions/_shared/attachments.mjs";

const bytes = (...parts) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const samples = {
  "photo.jpg": bytes([0xff, 0xd8, 0xff, 0xe0], "JFIF"),
  "photo.JPEG": bytes([0xff, 0xd8, 0xff, 0xe1], "Exif"),
  "board.png": bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "IHDR"),
  "anim.gif": bytes("GIF89a", [1, 0, 1, 0]),
  "old.gif": bytes("GIF87a", [1, 0, 1, 0]),
  "slide.webp": bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "),
  "iphone.heic": bytes([0, 0, 0, 24], "ftypheic", [0, 0, 0, 0]),
  "iphone.HEIF": bytes([0, 0, 0, 24], "ftypmif1", [0, 0, 0, 0]),
};

test("images can be attached with their MIME types", () => {
  assert.equal(attachmentTypes[".jpg"], "image/jpeg");
  assert.equal(attachmentTypes[".jpeg"], "image/jpeg");
  assert.equal(attachmentTypes[".png"], "image/png");
  assert.equal(attachmentTypes[".gif"], "image/gif");
  assert.equal(attachmentTypes[".webp"], "image/webp");
  assert.equal(attachmentTypes[".heic"], "image/heic");
  assert.equal(attachmentTypes[".heif"], "image/heif");
  const f = { id: randomUUID(), size: 1000 };
  assert.doesNotThrow(() => validateAttachments(Object.keys(samples).slice(0, 5).map((name) => ({ ...f, name }))));
});

test("image contents must match their extension", () => {
  for (const [name, data] of Object.entries(samples))
    assert.doesNotThrow(() => validateAttachmentBytes(name, data), name);
  const pdf = new TextEncoder().encode("%PDF-1.7");
  for (const name of Object.keys(samples))
    assert.throws(() => validateAttachmentBytes(name, pdf), /画像の形式を確認できません/, name);
  // A PNG renamed to .jpg, and a WebP container that is not WebP.
  assert.throws(() => validateAttachmentBytes("x.jpg", samples["board.png"]), /画像/);
  assert.throws(() => validateAttachmentBytes("x.webp", bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")), /画像/);
  assert.throws(() => validateAttachmentBytes("x.heic", bytes([0, 0, 0, 24], "ftypisom")), /画像/);
});

test("SVG and other active formats stay refused", () => {
  const f = { id: randomUUID(), size: 100 };
  for (const name of ["logo.svg", "page.html", "a.exe", "x.bmp", "x.tiff"])
    assert.throws(() => validateAttachments([{ ...f, name }]), /画像（JPEG・PNG・GIF・WebP・HEIC）/, name);
});

test("image attachments are recognised for the icon", () => {
  assert.equal(isImageAttachment("写真.JPG"), true);
  assert.equal(isImageAttachment("iphone.heic"), true);
  assert.equal(isImageAttachment("資料.pdf"), false);
  assert.equal(isImageAttachment("logo.svg"), false);
});

import { readFileSync } from "node:fs";
test("the storage bucket migration allows exactly the attachment MIME types", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261022093000_kotonoha_attachment_images.sql", import.meta.url), "utf8");
  assert.match(sql, /where id = 'kotonoha-documents';/);
  const allowed = [...sql.matchAll(/'([a-z]+\/[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(allowed)].sort(), [...new Set(Object.values(attachmentTypes))].sort());
  assert.doesNotMatch(sql, /svg/i);
});
