import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const read = (name) => readFileSync(path.join(repo, name), "utf8");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceNames = JSON.parse(read("docs/qr-logo-knowledge-extraction.json")).sources;
// Freeze inputs once; concurrent canonical-doc edits must not mutate a running fixture.
const sourceSnapshot = new Map(
  [...sourceNames, "docs/qr-logo-knowledge-extraction.json"].map((name) => [
    name, readFileSync(path.join(repo, name)),
  ]),
);
const stdlibPython = process.env.QR_KNOWLEDGE_STDLIB_PYTHON || "python3";

function copySources(destination) {
  for (const [name, bytes] of sourceSnapshot) {
    const target = path.join(destination, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

function probe(code, python = stdlibPython) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "qr-knowledge-probe-"));
  const fixture = path.join(temporary, "repo");
  copySources(fixture);
  try {
    const result = spawnSync(python, [
      "-B", path.join(repo, "tests/fixtures/qr-knowledge-probe.py"),
      path.join(repo, "scripts/update-qr-knowledge.py"), fixture, temporary,
    ], {
      cwd: temporary,
      input: code,
      encoding: "utf8",
      env: { ...process.env, GRAPHIFY_NO_AUTO_REFRESH: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

for (const name of [...sourceNames, "docs/qr-logo-knowledge-extraction.json"]) {
  test(`knowledge confinement rejects canonical input symlink: ${name}`, () => probe(`
name = ${JSON.stringify(name)}
target = repo / name
target.unlink()
target.symlink_to(root / "unread-external-input")
with capture_unsafe_io(repo) as io, patch.object(exporter, "verify", return_value={}), patch.object(exporter, "update", return_value={}):
    error = rejection(main)
assert error and "Refusing" in error, f"canonical symlink admitted; escaped reads={io}; error={error}"
assert io == [], f"canonical input read before confinement: {io}"
`));
}

test("knowledge confinement rejects a canonical input directory symlink", () => probe(`
(repo / "docs").rename(root / "moved-docs")
(repo / "docs").symlink_to(root / "moved-docs", target_is_directory=True)
with capture_unsafe_io(repo) as io, patch.object(exporter, "update", return_value={}):
    error = rejection(main)
assert error and "Refusing" in error, f"canonical directory admitted; escaped reads={io}; error={error}"
assert io == [], f"canonical directory read before confinement: {io}"
`));

for (const [name, directory, stop] of [
  ["80_リポジトリ文書", true, "detect"],
  ["80_リポジトリ文書/docs/qr-logos.md", false, "detect"],
  ["20_設計", true, "detect"],
  ["00_MARUGO QR.md", false, "detect"],
  ["graphify-out", true, "detect"],
  ["graphify-out/cache", true, "detect"],
  ["graphify-out/graph.json", false, "json"],
  ["graphify-out/graph.html", false, "html"],
]) {
  test(`knowledge confinement rejects output symlink before I/O: ${name}`, () => probe(`
target = app / ${JSON.stringify(name)}
target.parent.mkdir(parents=True, exist_ok=True)
escape = root / "escaped-output"
${directory ? "escape.mkdir()" : ""}
target.symlink_to(escape, target_is_directory=${directory ? "True" : "False"})
with capture_unsafe_io(app) as io, graphify_boundary(stop=${JSON.stringify(stop)}) as calls:
    error = rejection(update)
assert error and "Refusing" in error, f"output symlink admitted; escaped I/O={io}; package calls={calls}; error={error}"
assert io == [] and calls == [], f"output preflight occurred after I/O: {io}, {calls}"
`));
}

for (const dangling of [false, true]) {
  test(`knowledge confinement rejects nonexistent app under ${dangling ? "dangling" : "existing"} symlink ancestor`, () => probe(`
vault.mkdir()
escape = root / "escaped-area"
${dangling ? "" : "escape.mkdir()"}
(vault / exporter.AREA.parts[0]).symlink_to(escape, target_is_directory=True)
assert not app.exists(), "regression requires the app not to exist yet"
with patch.object(exporter, "update", return_value={}) as called:
    error = rejection(main)
assert error and "Refusing" in error, f"nonexistent app admitted through symlink ancestor; update calls={called.call_count}; error={error}"
assert not called.called, "update reached before ancestor confinement"
`));
}


test("QR knowledge extraction has a source-anchored four-file scope", () => {
  const model = JSON.parse(read("docs/qr-logo-knowledge-extraction.json"));
  assert.equal(model.schemaVersion, 1);
  assert.equal(model.method, "host-reviewed-local-extraction");
  assert.deepEqual(model.sources, [
    "docs/qr-logos.md",
    "docs/qr-logo-assets.json",
    "src/qr-image.mjs",
    "supabase/functions/_shared/qr-logos.mjs",
  ]);
  assert.match(model.extractionSpecSha256, /^[a-f0-9]{64}$/);
  const ids = new Set();
  for (const node of model.nodes) {
    assert.match(node.id, /^[a-z0-9_]+$/);
    assert.ok(!ids.has(node.id), `duplicate ${node.id}`);
    ids.add(node.id);
    assert.ok(model.sources.includes(node.source));
    const source = read(node.source);
    assert.ok(
      source.includes(node.selector.text),
      `missing evidence for ${node.id}`,
    );
    assert.ok(["section", "quote", "document"].includes(node.selector.kind));
  }
  for (const edge of model.edges) {
    assert.ok(ids.has(edge.source), `unknown source ${edge.source}`);
    assert.ok(
      ids.has(edge.target) || model.astTargets.includes(edge.target),
      `unknown target ${edge.target}`,
    );
    assert.equal(edge.confidence, "EXTRACTED");
    assert.equal(edge.confidence_score, 1);
    assert.ok(
      read(edge.source_file).includes(edge.evidence),
      `missing edge evidence ${edge.source} -> ${edge.target}`,
    );
  }
});

test("knowledge artifact keys control accepts the complete isolated export", () => probe(`
seed_export()
result = exporter.verify(repo, vault, app, sources, hashes)
assert result["check"] == "PASS" and result["artifact_files"] == len(ARTIFACT_NAMES), result
`));

for (const key of ["absolute", "../../outside.md", "graphify-out/../../outside.md", "graphify-out/unexpected.md", "graphify-out/./graph.json"]) {
  test(`knowledge artifact keys reject unsafe or unexpected manifest entry before reads: ${key}`, () => probe(`
manifest = seed_export()
key = str(root / "outside.md") if ${JSON.stringify(key)} == "absolute" else ${JSON.stringify(key)}
unsafe = app / key
payload = b"capture-only artifact; never read an outside file"
manifest["artifact_hashes"][key] = exporter.sha(payload)
save_export_manifest(manifest)
read_bytes, read_text, is_file = Path.read_bytes, Path.read_text, Path.is_file
reads = []
def capture(path):
    if path == unsafe or path.is_relative_to(app):
        reads.append(str(path))
    return payload if path == unsafe else read_bytes(path)
result = {}
def verify():
    result.update(exporter.verify(repo, vault, app, sources, hashes))
with patch.object(Path, "is_file", lambda path: True if path == unsafe else is_file(path)), patch.object(Path, "read_bytes", capture), patch.object(Path, "read_text", lambda path, *a, **k: "" if path == unsafe else read_text(path, *a, **k)):
    error = rejection(verify)
assert error and ("artifact" in error or "Refusing" in error), f"unsafe manifest admitted; check={result.get('check')}; unsafe_reads={reads.count(str(unsafe))}; last_reads={reads[-2:]}; error={error}"
assert reads == [], f"artifact read before all keys were validated: count={len(reads)}, last={reads[-2:]}"
`));
}

test("knowledge inventory cannot report PASS with empty hashes and all notes absent", () => probe(`
manifest = seed_export()
manifest["artifact_hashes"] = {}
for name in exporter.NOTES:
    (app / name).unlink()
save_export_manifest(manifest)
result = {}
def verify():
    result.update(exporter.verify(repo, vault, app, sources, hashes))
error = rejection(verify)
assert error and "artifact inventory" in error, f"empty inventory accepted; check={result.get('check')}; reported notes={result.get('notes')}; actual notes={sum((app / name).is_file() for name in exporter.NOTES)}"
`));

test("knowledge inventory requires every promised note HTML report sidecar and mirror hash", () => probe(`
admitted = []
for name in ARTIFACT_NAMES:
    manifest = seed_export()
    del manifest["artifact_hashes"][name]
    save_export_manifest(manifest)
    error = rejection(lambda: exporter.verify(repo, vault, app, sources, hashes))
    if not error or "artifact inventory" not in error:
        admitted.append((name, error))
assert admitted == [], f"omitted promised inventory entries admitted: {admitted}"
`));

test("knowledge inventory rejects an omitted inventory with a controlled error", () => probe(`
manifest = seed_export()
del manifest["artifact_hashes"]
save_export_manifest(manifest)
try:
    error = rejection(lambda: exporter.verify(repo, vault, app, sources, hashes))
except KeyError as exc:
    error = f"uncontrolled missing key: {exc}"
assert error and "artifact inventory" in error, f"missing inventory was not rejected with a controlled error: {error}"
`));

test("knowledge inventory verifies every promised file even with a complete inventory", () => probe(`
admitted = []
for name in ARTIFACT_NAMES:
    seed_export()
    (app / name).unlink()
    error = rejection(lambda: exporter.verify(repo, vault, app, sources, hashes))
    if not error or "Stale/missing artifact hash" not in error:
        admitted.append((name, error))
assert admitted == [], f"missing promised files admitted: {admitted}"
`));

test("knowledge inventory reports counts from validated artifacts and remains read-only", () => probe(`
seed_export()
before = {str(p.relative_to(root)): exporter.sha(p.read_bytes()) for p in root.rglob("*") if p.is_file()}
with patch.object(Path, "write_bytes", side_effect=AssertionError("verification wrote bytes")), patch.object(Path, "write_text", side_effect=AssertionError("verification wrote text")), patch.object(Path, "mkdir", side_effect=AssertionError("verification created a directory")):
    result = exporter.verify(repo, vault, app, sources, hashes)
after = {str(p.relative_to(root)): exporter.sha(p.read_bytes()) for p in root.rglob("*") if p.is_file()}
assert before == after
assert result["check"] == "PASS", result
assert result["notes"] == sum((app / name).is_file() for name in exporter.NOTES)
assert result["mirrors"] == sum((app / "80_リポジトリ文書" / name).is_file() for name in exporter.SOURCES)
assert result["artifact_files"] == len(ARTIFACT_NAMES), result
`));

for (const extra of ["unexpected.gdoc", "nested/unexpected.docx", ".hidden", "empty-directory/"]) {
  test(`knowledge detector preflight rejects the entire noncanonical mirror tree: ${extra}`, () => probe(`
extra = app / "80_リポジトリ文書" / ${JSON.stringify(extra)}
${extra.endsWith("/") ? "extra.mkdir(parents=True)" : 'extra.parent.mkdir(parents=True, exist_ok=True)\nextra.write_text("isolated noncanonical file", encoding="utf-8")'}
os.environ["GRAPHIFY_GOOGLE_WORKSPACE"] = "1"
conversions = []
def detector(scan, **kwargs):
    conversions.append(str(extra))
    raise BoundaryReached("converter boundary reached")
with graphify_boundary(detector=detector) as calls:
    error = rejection(update)
assert error and "noncanonical" in error, f"mirror admitted before conversion; package calls={calls}; conversion calls={conversions}; error={error}"
assert calls == [] and conversions == [], "mirror preflight ran after detector/converter"
`));
}

test("knowledge detector explicitly disables Google Workspace despite environment", () => probe(`
os.environ["GRAPHIFY_GOOGLE_WORKSPACE"] = "1"
with graphify_boundary(stop="detect") as calls:
    rejection(update)
assert len(calls) == 1 and calls[0][0] == "detect", calls
assert calls[0][1].get("google_workspace") is False, f"environment can enable Google conversion: {calls}"
`));

// Optional real-package integration: portable default tests need only Node/Python stdlib.
const graphifyPython = process.env.QR_KNOWLEDGE_PYTHON;
test("knowledge detector preflight blocks the installed converter before invocation", {
  skip: graphifyPython ? false : "Set QR_KNOWLEDGE_PYTHON for the installed-detector regression",
}, () => probe(`
import importlib
installed = importlib.import_module("graphify.detect")
importlib.import_module("graphify.cache")
extra = app / "80_リポジトリ文書/unexpected.gdoc"
extra.parent.mkdir(parents=True)
extra.write_text('{"doc_id":"capture-only-never-export"}', encoding="utf-8")
os.environ["GRAPHIFY_GOOGLE_WORKSPACE"] = "1"
with patch.object(installed, "convert_google_workspace_file", return_value=None) as converter, graphify_boundary(detector=installed.detect) as calls:
    error = rejection(update)
assert error and "noncanonical" in error, f"installed detector admitted shortcut; converter calls={converter.call_count}; package calls={calls}; error={error}"
assert converter.call_count == 0 and calls == [], f"installed converter invoked before rejection: {converter.call_args_list}"
`, graphifyPython));
test(
  "QR knowledge exporter builds scoped mirrors and an evidence-bearing Graphify graph",
  {
    skip: graphifyPython
      ? false
      : "Set QR_KNOWLEDGE_PYTHON to a Python with Graphify installed",
  },
  () => {
    const vault = mkdtempSync(
      path.join(os.tmpdir(), "marugo-qr-knowledge-test-"),
    );
    const fixtureRepo = path.join(vault, "fixture-repo");
    copySources(fixtureRepo);
    const app = path.join(vault, "10_アプリ別", "MARUGO QR");
    const run = (...args) =>
      spawnSync(
        graphifyPython,
        [
          path.join(repo, "scripts/update-qr-knowledge.py"),
          "--repo",
          fixtureRepo,
          "--vault",
          vault,
          ...args,
        ],
        {
          cwd: repo,
          encoding: "utf8",
          env: { ...process.env, GRAPHIFY_NO_AUTO_REFRESH: "1", PYTHONDONTWRITEBYTECODE: "1" },
        },
      );
    try {
      const updated = run();
      assert.equal(updated.status, 0, updated.stdout + updated.stderr);
      const manifest = JSON.parse(
        readFileSync(
          path.join(app, "graphify-out/KNOWLEDGE_MANIFEST.json"),
          "utf8",
        ),
      );
      assert.equal(manifest.app, "MARUGO QR");
      assert.equal(
        manifest.source_hashes["docs/qr-logos.md"],
        hash(sourceSnapshot.get("docs/qr-logos.md")),
      );
      for (const source of sourceNames) {
        assert.deepEqual(
          readFileSync(path.join(app, "80_リポジトリ文書", source)),
          sourceSnapshot.get(source),
        );
      }
      for (const note of [
        "00_MARUGO QR.md",
        "20_設計/中央ロゴ_アーキテクチャ.md",
        "60_機能別知識/中央ロゴ.md",
        "70_AI作業環境/知識更新.md",
      ]) {
        assert.ok(
          readFileSync(path.join(app, note), "utf8").includes(
            "[[10_アプリ別/MARUGO QR/",
          ),
        );
      }
      const graph = JSON.parse(
        readFileSync(path.join(app, "graphify-out/graph.json"), "utf8"),
      );
      const ids = new Set(graph.nodes.map((node) => node.id));
      const statusNode = graph.nodes.find(
        (node) => node.id === "docs_qr_logos_status",
      );
      const statusSource = sourceSnapshot.get("docs/qr-logos.md").toString("utf8");
      const evidenceStart = statusSource.indexOf(statusNode.evidence);
      const firstLine = statusSource.slice(0, evidenceStart).split("\n").length;
      const lastLine = statusSource
        .slice(0, evidenceStart + statusNode.evidence.length)
        .split("\n").length;
      assert.equal(
        statusNode.source_location,
        `L${firstLine}-L${lastLine}`,
        "source range must end at the actual evidence, not the next heading",
      );
      const links = graph.links ?? graph.edges;
      assert.ok(ids.size > 25, `only ${ids.size} nodes`);
      assert.ok(links.length > 25, `only ${links.length} edges`);
      for (const edge of links) {
        assert.ok(
          ids.has(edge.source) && ids.has(edge.target),
          "dangling graph edge",
        );
      }
      const decoded = JSON.stringify(graph);
      for (const fact of [
        "QRごとに保存",
        "同じ店舗",
        "総コードワード",
        "面積・幅",
        "クワイエットゾーン",
        "予約セル",
        "復号",
        "計測URL",
      ]) {
        assert.ok(decoded.includes(fact), `missing graph fact ${fact}`);
      }
      assert.ok(
        readFileSync(
          path.join(app, "graphify-out/graph.html"),
          "utf8",
        ).includes("<html"),
      );
      assert.ok(
        readFileSync(
          path.join(app, "graphify-out/GRAPH_REPORT.md"),
          "utf8",
        ).includes("MARUGO QR"),
      );
      const checked = run("--check");
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      assert.match(checked.stdout, /"broken_wikilinks":\s*0/);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  },
);

test(
  "QR knowledge freshness detects source/mirror drift and refreshes only this app",
  {
    skip: graphifyPython
      ? false
      : "Set QR_KNOWLEDGE_PYTHON for the real-package freshness regression",
  },
  () => {
    const vault = mkdtempSync(
      path.join(os.tmpdir(), "marugo-qr-knowledge-freshness-"),
    );
    const fixtureRepo = path.join(vault, "fixture-repo");
    const app = path.join(vault, "10_アプリ別", "MARUGO QR");
    const sentinel = path.join(
      vault,
      "10_アプリ別",
      "unrelated-app",
      "keep.md",
    );
    mkdirSync(path.dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, "Leave this app unchanged.\n");
    copySources(fixtureRepo);
    const memory = path.join(app, "graphify-out/memory/query_poison.md");
    mkdirSync(path.dirname(memory), { recursive: true });
    writeFileSync(memory, "POISON_QUERY_MEMORY_MUST_NOT_BECOME_EVIDENCE\n");
    const run = (...args) =>
      spawnSync(
        graphifyPython,
        [
          path.join(repo, "scripts/update-qr-knowledge.py"),
          "--repo",
          fixtureRepo,
          "--vault",
          vault,
          ...args,
        ],
        {
          cwd: repo,
          encoding: "utf8",
          env: { ...process.env, GRAPHIFY_NO_AUTO_REFRESH: "1", PYTHONDONTWRITEBYTECODE: "1" },
        },
      );
    try {
      let result = run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const graphPath = path.join(app, "graphify-out/graph.json");
      const first = JSON.parse(readFileSync(graphPath, "utf8"));
      const original = readFileSync(
        path.join(fixtureRepo, "docs/qr-logos.md"),
        "utf8",
      );
      writeFileSync(
        path.join(fixtureRepo, "docs/qr-logos.md"),
        original.replace(
          "## 状態\n",
          "## 状態\n\n知識更新回帰テストの新しい状態証跡。\n",
        ),
      );
      result = run("--check");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Stale source/);
      result = run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const updated = JSON.parse(readFileSync(graphPath, "utf8"));
      assert.equal(updated.nodes.length, first.nodes.length);
      assert.ok(
        updated.nodes
          .find((node) => node.id === "docs_qr_logos_status")
          .evidence.includes("知識更新回帰テストの新しい状態証跡。"),
      );
      assert.ok(!JSON.stringify(updated).includes("POISON_QUERY_MEMORY"));
      assert.equal(
        readFileSync(sentinel, "utf8"),
        "Leave this app unchanged.\n",
      );
      const stable = readFileSync(graphPath);
      result = run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(
        readFileSync(graphPath),
        stable,
        "same inputs must yield byte-identical graph JSON",
      );
      writeFileSync(
        path.join(app, "80_リポジトリ文書/docs/qr-logos.md"),
        original + "\nTAMPER\n",
      );
      result = run("--check");
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /Stale\/missing artifact hash|Mirror mismatch/,
      );
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  },
);
