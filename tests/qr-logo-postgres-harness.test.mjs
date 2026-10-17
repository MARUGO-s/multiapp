import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("./qr-logo-postgres-harness-unit.py", import.meta.url));

test("disposable PostgreSQL harness safety (mocked Docker I/O)", (t) => {
  const result = spawnSync("python3", ["-B", helper], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  t.diagnostic(result.stderr.trim());
});
