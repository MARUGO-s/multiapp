import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence =
  process.env.KOTONOHA_OFFLINE_EVIDENCE ||
  fileURLToPath(new URL("../../kotonoha-offline-evidence/", import.meta.url));
mkdirSync(evidence, { recursive: true });
const suites = [
  "recorder",
  "store",
  "upload",
  "auth",
  "queue",
  "ui",
  "app",
  "http",
  "capability",
  "location-http",
  "review-scope",
  "review-cas",
  "review-integrity",
  "review-inputs",
  "recording-location",
  "recording-location-ui",
  "recording-location-ui-details-1440",
  "recording-location-ui-details-390",
];
const results = [];
for (const suite of suites) {
  const script = suite.startsWith("recording-location-ui-details")
    ? "scripts/test-recording-location-ui-browser.mjs"
    : suite.startsWith("recording-location")
      ? `scripts/test-${suite}-browser.mjs`
      : `scripts/test-offline-${suite}-browser.mjs`;
  const started = Date.now();
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 5_000_000,
    env: {
      ...process.env,
      KOTONOHA_OFFLINE_EVIDENCE: evidence,
      LOCATION_EVIDENCE: evidence,
      KOTONOHA_INTEGRATION_EVIDENCE: evidence,
      LOCATION_UI_MODE: suite.includes("-details-") ? "details" : "record",
      LOCATION_UI_WIDTH: suite.endsWith("-390") ? "390" : "1440",
    },
  });
  const output =
    (result.stdout || "") +
    (result.stderr || "") +
    (result.error ? String(result.error) : "");
  const log = path.join(evidence, `frontend-${suite}-green.log`);
  writeFileSync(log, output);
  const row = {
    suite,
    status: result.status === 0 ? "pass" : "fail",
    exit: result.status,
    durationMs: Date.now() - started,
    log,
  };
  results.push(row);
  console.log(
    `${row.status.toUpperCase()} ${suite} (${row.durationMs}ms) ${log}`,
  );
  if (result.status !== 0) console.error(output);
}
const summary = {
  suites: results.length,
  passed: results.filter((r) => r.status === "pass").length,
  results,
};
writeFileSync(
  path.join(evidence, "frontend-browser-results.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify({ suites: summary.suites, passed: summary.passed }));
if (summary.passed !== summary.suites) process.exitCode = 1;
