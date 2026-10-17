import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Pages CI actually runs the store-catalog and cached-client Deno regressions", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );
  const command = workflow
    .split(/\r?\n/)
    .find(
      (line) =>
        /^\s*-\s+run:\s+deno\s+test\b/.test(line) &&
        line.includes("--config supabase/functions/marugo-qr/deno.json"),
    );
  assert.ok(command, "actual QR Deno test step is required");
  const files = new Set(command.match(/tests\/[a-z0-9-]+\.test\.ts/g));
  for (const file of [
    "tests/cloud-qr.test.ts",
    "tests/cloud-qr-files.test.ts",
    "tests/cloud-qr-logos.test.ts",
    "tests/cloud-qr-store-logos.test.ts",
    "tests/cloud-qr-catalog-compat.test.ts",
  ])
    assert.ok(files.has(file), `Pages CI omitted ${file}`);
});
