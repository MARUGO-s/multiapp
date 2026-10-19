import test from "node:test";
import assert from "node:assert/strict";
import {
  fileSpecification,
  matchesFileSignature,
  QR_FILE_MAX_BYTES,
} from "../supabase/functions/_shared/qr-files.mjs";
test("QR publication allows PDF/JPEG/PNG/HTML and caps file size", () => {
  assert.equal(fileSpecification("案内.PDF", 100).mime, "application/pdf");
  assert.equal(fileSpecification("写真.jpeg", 100).extension, "jpg");
  assert.equal(
    fileSpecification("写真.png", QR_FILE_MAX_BYTES).mime,
    "image/png",
  );
  assert.equal(fileSpecification("案内.HTML", 100).mime, "text/html");
  assert.equal(fileSpecification("page.htm", 100).extension, "html");
  for (const name of [
    "logo.svg",
    "file.psd",
    "../file.pdf",
    "foo\\file.pdf",
    "bad\nname.pdf",
  ])
    assert.throws(() => fileSpecification(name, 100));
  for (const size of [0, -1, 1.5, NaN, "100", QR_FILE_MAX_BYTES + 1])
    assert.throws(() => fileSpecification("a.pdf", size));
});
test("QR file contents must match the extension; scripts and PSD are rejected", () => {
  assert.equal(
    matchesFileSignature(
      "application/pdf",
      new TextEncoder().encode("%PDF-1.7"),
    ),
    true,
  );
  assert.equal(
    matchesFileSignature("image/jpeg", new Uint8Array([255, 216, 255, 0])),
    true,
  );
  assert.equal(
    matchesFileSignature(
      "image/png",
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    ),
    true,
  );
  for (const mime of ["application/pdf", "image/jpeg", "image/png"])
    assert.equal(
      matchesFileSignature(mime, new TextEncoder().encode("<html>8BPS")),
      false,
    );
  for (const value of ["<!DOCTYPE html>", " <html lang=\"ja\">", "\uFEFF<html>"])
    assert.equal(
      matchesFileSignature("text/html", new TextEncoder().encode(value)),
      true,
    );
  for (const value of ["hello", "%PDF-1.7", "<svg></svg>\u0000", ""])
    assert.equal(
      matchesFileSignature("text/html", new TextEncoder().encode(value)),
      false,
    );
});
