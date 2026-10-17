import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const loader = new URL(
  "./fixtures/qr-logo-startup-loader.mjs",
  import.meta.url,
);
const registerLoader = `data:text/javascript,${encodeURIComponent(
  `import { register } from "node:module"; register(${JSON.stringify(loader.href)});`,
)}`;
const scripts = [
  {
    name: "check-qr-logo-decoding.mjs",
    override: "QR_LOGO_DECODE_OUTPUT",
    directory: "qr-logo-decoding",
  },
  {
    name: "test-qr-logo-browser.mjs",
    override: "QR_LOGO_EVIDENCE",
    directory: "qr-logo-ui-evidence",
    directories: ["screenshots"],
  },
  {
    name: "test-qr-logo-feature-browser.mjs",
    override: "QR_LOGO_EVIDENCE",
    directory: "qr-logo-ui-evidence",
    directories: ["screenshots", "browser-exports"],
  },
];

for (const script of scripts) {
  for (const explicitOutput of [false, true]) {
    test(`${script.name} starts without TMPDIR ${explicitOutput ? "with an explicit output override" : "or an output override"}`, (t) => {
      // The repository is under Hermes scratch locally; never fall back to /tmp.
      const fixture = mkdtempSync(path.join(repo, ".qr-logo-startup-"));
      t.after(() => rmSync(fixture, { recursive: true, force: true }));
      const env = { ...process.env, TMP: fixture, TEMP: fixture };
      delete env.TMPDIR;
      delete env.QR_LOGO_DECODE_OUTPUT;
      delete env.QR_LOGO_EVIDENCE;
      const output = path.join(
        fixture,
        explicitOutput ? "explicit-output" : script.directory,
      );
      if (explicitOutput) env[script.override] = output;
      const result = spawnSync(
        process.execPath,
        [
          ...(script.directories ? ["--import", registerLoader] : []),
          path.join(repo, "scripts", script.name),
        ],
        { cwd: repo, env, encoding: "utf8", timeout: 30_000 },
      );
      const details = result.stdout + result.stderr;
      assert.ifError(result.error);
      assert.equal(result.signal, null, details);
      if (script.directories) {
        assert.equal(result.status, 1, details);
        assert.match(
          result.stderr,
          /Error: QR_LOGO_STARTUP_BROWSER_LAUNCH_REACHED/,
          details,
        );
        assert.doesNotMatch(details, /ERR_INVALID_ARG_TYPE/);
        for (const directory of script.directories)
          assert.equal(existsSync(path.join(output, directory)), true);
      } else {
        assert.equal(result.status, 0, details);
        const report = JSON.parse(result.stdout);
        assert.equal(report.output, output);
        assert.equal(report.completed, QR_LOGOS.length + 1);
        assert.equal(report.allJsQrDecoded, true);
        const manifest = JSON.parse(
          readFileSync(path.join(output, "renderer-results.json"), "utf8"),
        );
        assert.equal(manifest.completed, QR_LOGOS.length + 1);
        assert.deepEqual(
          readdirSync(output)
            .filter((file) => file.endsWith(".png"))
            .sort(),
          ["none.png", ...QR_LOGOS.map((logo) => `${logo.id}.png`)].sort(),
        );
      }
      if (explicitOutput)
        assert.equal(existsSync(path.join(fixture, script.directory)), false);
    });
  }
}
