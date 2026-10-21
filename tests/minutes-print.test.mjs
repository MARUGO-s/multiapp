import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function printHiddenSelectors() {
  const hidden = new Set();
  for (const block of css.matchAll(/@media print\s*\{([\s\S]*?)\n\}/g)) {
    for (const rule of block[1].matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/display:\s*none/.test(rule[2])) continue;
      for (const selector of rule[1].split(",")) hidden.add(selector.trim());
    }
  }
  return hidden;
}

test("minutes PDF hides the Bot status box above the minutes", () => {
  assert.ok(printHiddenSelectors().has(".bot-status"));
});

test("minutes PDF keeps hiding the other screen-only panels", () => {
  const hidden = printHiddenSelectors();
  for (const selector of [".sidebar", ".progress-panel", ".notice", ".error-message", ".document-toolbar"])
    assert.ok(hidden.has(selector), selector);
});
