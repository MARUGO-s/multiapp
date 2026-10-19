import test from "node:test";
import assert from "node:assert/strict";
import { selectedQrFile, isFileDrag } from "../src/qr-file-selection.mjs";
const pdf = { name: "メニュー.pdf", size: 1234 };
test("Picker and drop share selection restrictions without changing file identity", () => {
  assert.equal(selectedQrFile([pdf]), pdf);
  assert.equal(selectedQrFile({ 0: pdf, length: 1 }), pdf);
  assert.equal(selectedQrFile([]), null);
  assert.equal(selectedQrFile(null), null);
  assert.throws(() => selectedQrFile([pdf, pdf]), /1つずつ/);
  assert.equal(selectedQrFile([{ name: "page.html", size: 100 }]).name, "page.html");
  assert.throws(
    () => selectedQrFile([{ name: "logo.svg", size: 100 }]),
    /PDF/,
  );
  assert.throws(
    () => selectedQrFile([{ name: "photo.png", size: 21 * 1024 * 1024 }]),
    /20MB/,
  );
  assert.throws(
    () => selectedQrFile([{ name: "folder.pdf", size: 0 }]),
    /20MB/,
  );
  assert.throws(() => selectedQrFile([pdf], true), /処理中/);
});
test("Only file drags are intercepted; text and URL drags remain ordinary inputs", () => {
  assert.equal(isFileDrag({ types: ["Files"] }), true);
  assert.equal(isFileDrag({ types: ["text/uri-list", "Files"] }), true);
  assert.equal(isFileDrag({ types: ["text/plain"] }), false);
  assert.equal(isFileDrag({ types: ["text/uri-list"] }), false);
  assert.equal(isFileDrag(null), false);
});
