"""Stdlib-only isolated probes for the real QR knowledge generator.

Only package and unsafe-I/O boundaries are mocked. All fixture paths belong to
Node's disposable scratch directory; no installed Graphify or vault is needed.
"""
from contextlib import ExitStack, contextmanager
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
from unittest.mock import patch

script, fixture, temporary = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location("qr_knowledge", script)
assert spec is not None and spec.loader is not None
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
repo = fixture.resolve()
root = temporary.resolve()
vault = root / "vault"
app = vault / exporter.AREA
skill = root / "skill"
source_bytes = {name: (repo / name).read_bytes() for name in exporter.SOURCES}
sources = {name: data.decode("utf-8") for name, data in source_bytes.items()}
hashes = {name: exporter.sha(data) for name, data in source_bytes.items()}
model = json.loads((repo / exporter.MODEL).read_text(encoding="utf-8"))
(skill / "references").mkdir(parents=True)
(skill / "references/extraction-spec.md").write_bytes(b"isolated extraction spec\n")
model["extractionSpecSha256"] = exporter.sha(b"isolated extraction spec\n")
(repo / exporter.MODEL).write_text(json.dumps(model, ensure_ascii=False), encoding="utf-8")
canonical_bytes = {**source_bytes, exporter.MODEL: (repo / exporter.MODEL).read_bytes()}


class BoundaryReached(Exception):
    pass


def main(check=False):
    args = [str(script), "--repo", str(repo), "--vault", str(vault), "--skill-dir", str(skill)]
    if check:
        args.append("--check")
    with patch.object(sys, "argv", args):
        return exporter.main()


def update():
    return exporter.update(repo, vault, app, model, sources, hashes, skill)


def rejection(call):
    try:
        call()
    except ValueError as exc:
        return str(exc)
    except BoundaryReached:
        return None
    return None


@contextmanager
def capture_unsafe_io(allowed_root):
    """Record attempted escaped I/O without following the offending symlink."""
    events = []
    originals = {name: getattr(Path, name) for name in ("read_bytes", "read_text", "write_bytes", "write_text", "mkdir")}

    def wrap(name):
        def invoke(path, *args, **kwargs):
            if path.is_relative_to(allowed_root) and not path.resolve().is_relative_to(allowed_root):
                events.append((name, str(path)))
                if name == "read_bytes":
                    return canonical_bytes.get(path.relative_to(repo).as_posix(), b"") if path.is_relative_to(repo) else b""
                if name == "read_text":
                    return canonical_bytes[path.relative_to(repo).as_posix()].decode("utf-8") if path.is_relative_to(repo) else ""
                return None
            return originals[name](path, *args, **kwargs)
        return invoke

    with ExitStack() as stack:
        for name in originals:
            stack.enter_context(patch.object(Path, name, wrap(name)))
        yield events


@contextmanager
def graphify_boundary(*, stop="html", detector=None):
    """Exercise real update control flow, replacing the unavailable package only."""
    calls = []
    semantic = exporter.materialize(repo, model, sources, hashes)
    cached = []

    class Graph:
        def __init__(self):
            self.graph = {}
        def number_of_nodes(self):
            return len(semantic["nodes"])
        def number_of_edges(self):
            return len(semantic["edges"])

    def detect(scan, **kwargs):
        calls.append(("detect", kwargs))
        if detector:
            return detector(scan, **kwargs)
        if stop == "detect":
            raise BoundaryReached("detector called")
        return {"files": {"document": [str(scan / p) for p in exporter.SOURCES]}}

    def check_cache(*args, **kwargs):
        if cached:
            return semantic["nodes"], semantic["edges"], semantic["hyperedges"], []
        return [], [], [], [str(repo / name) for name in exporter.SOURCES[:2]]

    def save_cache(*args, **kwargs):
        cached.append(True)
        return 2

    def to_json(graph, communities, output_path, *, force=False, community_labels=None, original_links=None):
        calls.append(("to_json", output_path))
        Path(output_path).write_text("{}", encoding="utf-8")
        if stop == "json":
            raise BoundaryReached("JSON write attempted")
        return True

    def to_html(graph, communities, output_path, *, community_labels=None):
        calls.append(("to_html", output_path))
        Path(output_path).write_text("<html></html>", encoding="utf-8")
        raise BoundaryReached("HTML write attempted")

    def unused(*args, **kwargs):
        return {}

    modules = {"graphify": sys.modules.get("graphify", types.ModuleType("graphify"))}
    boundaries = {
        "detect": {"detect": detect, "save_manifest": unused},
        "extract": {"extract": lambda *a, **k: {"nodes": [], "edges": []}},
        "cache": {"check_semantic_cache": check_cache, "save_semantic_cache": save_cache},
        "build": {"build_from_json": lambda *a, **k: Graph()},
        "cluster": {"cluster": lambda *a, **k: {0: [n["id"] for n in semantic["nodes"]]}, "score_all": unused},
        "analyze": {name: unused for name in ("god_nodes", "surprising_connections", "suggest_questions")},
        "export": {"to_json": to_json, "to_html": to_html},
        "report": {"generate": lambda *a, **k: "isolated report"},
        "diagnostics": {"diagnose_extraction": unused},
    }
    for name, members in boundaries.items():
        module = types.ModuleType("graphify." + name)
        if module.__name__ in sys.modules:
            module.__dict__.update(vars(sys.modules[module.__name__]))
        module.__dict__.update(members)
        modules[module.__name__] = module
    with patch.dict(sys.modules, modules):
        yield calls


# Independent contract inventory: do not derive expected artifacts from the manifest.
REPORT_NAMES = (
    ".graphify_detect.json", ".graphify_ast.json", ".graphify_chunk_01.json",
    ".graphify_semantic.json", ".graphify_extract.json", ".graphify_labels.json",
    ".graphify_analysis.json", "DIAGNOSTICS.json", "SOURCE_INTEGRITY.json",
    ".graphify_python", ".graphify_root", "manifest.json",
    "graph.json", "graph.html", "GRAPH_REPORT.md",
)
ARTIFACT_NAMES = (*exporter.NOTES, *("80_リポジトリ文書/" + name for name in exporter.SOURCES),
                  *("graphify-out/" + name for name in REPORT_NAMES))


def seed_export():
    """A minimal valid verification fixture, not a replacement Graphify export."""
    out = app / "graphify-out"
    out.mkdir(parents=True, exist_ok=True)
    for name in ARTIFACT_NAMES:
        target = app / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("{}\n", encoding="utf-8")
    for name, data in source_bytes.items():
        (app / "80_リポジトリ文書" / name).write_bytes(data)
    for name, text in exporter.notes(repo, app, sources, sys.executable).items():
        (app / name).write_text(text, encoding="utf-8")
    status = exporter.select(sources[exporter.SOURCES[0]], {"kind": "section", "text": "## 状態"})[0]
    provenance = {"source_file": exporter.SOURCES[0], "source_sha256": hashes[exporter.SOURCES[0]], "source_location": "L1-L1"}
    graph = {"nodes": [
        {**provenance, "id": "docs_qr_logos_doc", "evidence": sources[exporter.SOURCES[0]]},
        {**provenance, "id": "docs_qr_logos_status", "evidence": status},
    ], "links": [{**provenance, "source": "docs_qr_logos_doc", "target": "docs_qr_logos_status"}],
        "graph": {"source_hashes": hashes}}
    (out / "graph.json").write_text(json.dumps(graph, ensure_ascii=False), encoding="utf-8")
    (out / "graph.html").write_text("<html></html>\n", encoding="utf-8")
    (out / "GRAPH_REPORT.md").write_text("# MARUGO QR isolated report\n", encoding="utf-8")
    manifest = {"schemaVersion": 1, "app": exporter.APP, "python": sys.executable,
                "graphify_version": "isolated-verification-fixture", "source_hashes": hashes,
                "input_hashes": {**hashes, exporter.MODEL: exporter.sha((repo / exporter.MODEL).read_bytes()),
                                 exporter.SCRIPT: exporter.sha(script.read_bytes())},
                "artifact_hashes": {name: exporter.sha((app / name).read_bytes()) for name in ARTIFACT_NAMES},
                "topology_edges": 1, "communities": 1,
                "semantic_cache": {"hits": 0, "saved": 2, "readback_files": 2}}
    save_export_manifest(manifest)
    return manifest


def save_export_manifest(manifest):
    (app / "graphify-out/KNOWLEDGE_MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")


exec(sys.stdin.read())
