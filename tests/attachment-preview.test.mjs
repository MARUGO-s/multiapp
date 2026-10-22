import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_TEXT_PREVIEW,
  decodePreviewText,
  parseCsv,
  previewKind,
} from "../src/attachment-preview.mjs";

test("images, PDF, CSV and TXT open in the app; Office files stay download-only", () => {
  for (const name of ["a.jpg", "a.JPEG", "a.png", "a.gif", "a.webp", "a.heic", "a.heif"])
    assert.equal(previewKind(name), "image", name);
  assert.equal(previewKind("資料.PDF"), "pdf");
  assert.equal(previewKind("売上.csv"), "csv");
  assert.equal(previewKind("メモ.txt"), "text");
  for (const name of ["a.xlsx", "a.xls", "a.docx", "a.doc", "a.pptx", "a.ppt", "a.svg", "a.html", "noext"])
    assert.equal(previewKind(name), null, name);
});

test("text is read as UTF-8, and Excel's Shift_JIS CSV is read too", () => {
  const utf8 = new TextEncoder().encode("店舗,売上\nマルゴ,120");
  assert.equal(decodePreviewText(utf8).text, "店舗,売上\nマルゴ,120");
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  assert.equal(decodePreviewText(bom).text, "店舗,売上\nマルゴ,120");
  // 「店舗」 in Shift_JIS.
  const sjis = new Uint8Array([0x93, 0x58, 0x95, 0xdc, 0x2c, 0x41]);
  assert.equal(decodePreviewText(sjis).text, "店舗,A");
});

test("very long text is cut for display and says so", () => {
  const long = new TextEncoder().encode("あ".repeat(MAX_TEXT_PREVIEW + 10));
  const { text, truncated } = decodePreviewText(long);
  assert.equal(text.length, MAX_TEXT_PREVIEW);
  assert.equal(truncated, true);
  assert.equal(decodePreviewText(new TextEncoder().encode("短い")).truncated, false);
});

test("CSV keeps quoted commas, quotes and line breaks in a cell", () => {
  const { rows, truncated } = parseCsv('品目,備考\n"玉ねぎ, 淡路","""特選"""\n"人参","2行\n目"\n');
  assert.deepEqual(rows, [["品目", "備考"], ["玉ねぎ, 淡路", '"特選"'], ["人参", "2行\n目"]]);
  assert.equal(truncated, false);
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n").rows, [["a", "b"], ["1", "2"]]);
});

test("CSV display is limited to a fixed number of rows", () => {
  const csv = Array.from({ length: 30 }, (_, i) => `${i},x`).join("\n");
  const { rows, truncated } = parseCsv(csv, 10);
  assert.equal(rows.length, 10);
  assert.equal(truncated, true);
});
