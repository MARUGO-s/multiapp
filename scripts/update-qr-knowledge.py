#!/usr/bin/env python3
"""Export only MARUGO QR's reviewed four-file corpus; --check needs only stdlib.

Update: GRAPHIFY_NO_AUTO_REFRESH=1 <graphify-python> scripts/update-qr-knowledge.py
Check:  python3 scripts/update-qr-knowledge.py --check
No APIs, credentials, runtime edits, or other apps' exports are used.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shlex
import sys

APP = "MARUGO QR"
AREA = Path("10_アプリ別") / APP
MODEL = "docs/qr-logo-knowledge-extraction.json"
SCRIPT = "scripts/update-qr-knowledge.py"
SOURCES = (
    "docs/qr-logos.md",
    "docs/qr-logo-assets.json",
    "src/qr-image.mjs",
    "supabase/functions/_shared/qr-logos.mjs",
)
NOTES = (
    "00_MARUGO QR.md",
    "20_設計/中央ロゴ_アーキテクチャ.md",
    "60_機能別知識/中央ロゴ.md",
    "70_AI作業環境/知識更新.md",
)
GRAPH_ARTIFACTS = (
    ".graphify_detect.json", ".graphify_ast.json", ".graphify_chunk_01.json",
    ".graphify_semantic.json", ".graphify_extract.json", ".graphify_labels.json",
    ".graphify_analysis.json", "DIAGNOSTICS.json", "SOURCE_INTEGRITY.json",
    ".graphify_python", ".graphify_root", "manifest.json", "graph.json", "graph.html", "GRAPH_REPORT.md",
)
ARTIFACTS = frozenset((*NOTES, *("80_リポジトリ文書/" + name for name in SOURCES),
                       *("graphify-out/" + name for name in GRAPH_ARTIFACTS)))


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def confined(root: Path, path: Path) -> Path:
    """Reject symlink components (including dangling ones) before any file I/O."""
    if not path.is_relative_to(root) or not path.resolve().is_relative_to(root):
        raise ValueError(f"Refusing path outside explicit root {root}: {path}")
    current = root
    for part in path.relative_to(root).parts:
        current /= part
        if current.is_symlink():
            raise ValueError(f"Refusing symlink path component: {current}")
    return path


def preflight_paths(repo: Path, vault: Path, app: Path) -> None:
    if app != vault / AREA:
        raise ValueError("Refusing output outside this app's vault area")
    confined(vault, app)  # Check ancestors even when app.exists() is false.
    for name in (MODEL, *SOURCES):
        confined(repo, repo / name)

    def walk(path: Path) -> None:
        confined(app, path)
        if path.is_dir():
            for child in path.iterdir():
                walk(child)

    # Graphify writes its own caches, backups, HTML and JSON, bypassing write().
    # Inspect every existing component, not just the generator's final filenames.
    walk(app)


def preflight_mirror(app: Path, *, complete: bool = False) -> None:
    mirror = confined(app, app / "80_リポジトリ文書")
    directories = {parent.as_posix() for name in SOURCES for parent in Path(name).parents}
    found = set()

    def walk(path: Path) -> None:
        confined(app, path)
        name = path.relative_to(mirror).as_posix()
        if path.is_dir() and name in directories:
            for child in path.iterdir():
                walk(child)
        elif path.is_file() and name in SOURCES:
            found.add(name)
        else:
            raise ValueError(f"Refusing noncanonical mirror entry before detection: {name}")

    if mirror.exists():
        walk(mirror)
    if complete and found != set(SOURCES):
        raise ValueError("Missing canonical mirror files before detection")


def dump(path: Path, data, *, root: Path) -> None:
    write(path, json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", root=root)


def write(path: Path, data: str | bytes, *, root: Path) -> None:
    confined(root, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = data.encode("utf-8") if isinstance(data, str) else data
    if not path.exists() or path.read_bytes() != content:
        path.write_bytes(content)


def snapshot(root: Path) -> dict:
    if not root.is_dir():
        raise ValueError(f"Installed Graphify skill not found: {root}")
    return {str(p.relative_to(root)): sha(p.read_bytes()) for p in sorted(root.rglob("*")) if p.is_file()}


def select(text: str, selector: dict) -> tuple[str, str]:
    anchor = selector["text"]
    if text.count(anchor) != 1:
        raise ValueError(f"Missing/ambiguous extraction anchor; host review needed: {anchor!r}")
    start = text.index(anchor)
    end = start + len(anchor)
    if selector["kind"] == "document":
        start, end = 0, len(text)
    elif selector["kind"] == "section":
        level = len(anchor) - len(anchor.lstrip("#"))
        match = re.search(r"^#{1," + str(level) + r"} ", text[end:], re.M)
        end = end + match.start() if match else len(text)
    elif selector["kind"] != "quote":
        raise ValueError("Unknown selector kind")
    evidence = text[start:end].rstrip()
    end = start + len(evidence)
    return evidence, f"L{text.count(chr(10), 0, start) + 1}-L{text.count(chr(10), 0, end) + 1}"


def materialize(repo: Path, model: dict, sources: dict, hashes: dict) -> dict:
    nodes, edges = [], []
    for rule in model["nodes"]:
        evidence, location = select(sources[rule["source"]], rule["selector"])
        node = {k: v for k, v in rule.items() if k not in ("source", "selector")}
        node.update(source_file=str(repo / rule["source"]), source_location=location,
                    source_sha256=hashes[rule["source"]], evidence=evidence, _origin="semantic")
        nodes.append(node)
    for rule in model["edges"]:
        source = rule["source_file"]
        evidence, location = select(sources[source], {"kind": "quote", "text": rule["evidence"]})
        edges.append({**rule, "source_file": str(repo / source), "source_location": location,
                      "source_sha256": hashes[source], "evidence": evidence, "weight": 1.0, "_origin": "semantic"})
    catalog = model["catalog"]
    source = catalog["source"]
    raw = sources[source]
    metadata = json.loads(raw)
    entries = metadata["entries"]
    if len(entries) != metadata["assetCount"] or len({entry["id"] for entry in entries}) != len(entries):
        raise ValueError("Catalog count/ID integrity failure")
    if sum(entry["assetBytes"] for entry in entries) != metadata["assetTotalBytes"]:
        raise ValueError("Catalog byte total mismatch")
    for entry in entries:
        if not re.fullmatch(r"[a-z0-9-]+", entry["id"]):
            raise ValueError("Invalid catalog ID")
        match = re.search(r'"id"\s*:\s*' + re.escape(json.dumps(entry["id"])), raw)
        if match is None:
            raise ValueError("Catalog entry evidence is missing")
        start = raw.rfind("{", 0, match.start())
        parsed, length = json.JSONDecoder().raw_decode(raw[start:])
        if parsed != entry:
            raise ValueError("Cannot locate exact catalog entry evidence")
        evidence = raw[start:start + length]
        location = f"L{raw.count(chr(10), 0, start) + 1}-L{raw.count(chr(10), 0, start + length) + 1}"
        nid = catalog["nodePrefix"] + entry["id"].replace("-", "_")
        nodes.append({"id": nid, "label": entry["id"] + " / " + entry["sourceFilename"],
                      "file_type": "concept", "source_file": str(repo / source),
                      "source_location": location, "source_sha256": hashes[source],
                      "evidence": evidence, "catalog_entry": entry, "_origin": "semantic"})
        edges.append({"source": catalog["documentId"], "target": nid, "relation": "contains",
                      "confidence": "EXTRACTED", "confidence_score": 1.0, "weight": 1.0,
                      "source_file": str(repo / source), "source_location": location,
                      "source_sha256": hashes[source], "evidence": evidence, "_origin": "semantic"})
    return {"nodes": nodes, "edges": edges, "hyperedges": [], "input_tokens": 0, "output_tokens": 0}


def link(note: str, label: str) -> str:
    return f"[[{AREA.as_posix()}/{note.removesuffix('.md')}|{label}]]"


def notes(repo: Path, app: Path, sources: dict, python: str) -> dict:
    doc = sources[SOURCES[0]]
    section = lambda heading: select(doc, {"kind": "section", "text": heading})[0]
    canonical = link("80_リポジトリ文書/docs/qr-logos.md", "正本ミラー：中央ロゴ仕様・検証・反映状況")
    home = link(NOTES[0], "MARUGO QR入口")
    architecture = link(NOTES[1], "中央ロゴのアーキテクチャ")
    feature = link(NOTES[2], "中央ロゴ機能")
    workflow = link(NOTES[3], "Obsidian・Graphify更新")
    report = link("graphify-out/GRAPH_REPORT.md", "Graphify監査レポート")
    command = f"GRAPHIFY_NO_AUTO_REFRESH=1 {shlex.quote(python)} scripts/update-qr-knowledge.py"
    return {
        NOTES[0]: "# MARUGO QR\n\n" + section("## 状態") + "\n\n"
        + f"- {feature}\n- {architecture}\n- {canonical}\n- {workflow}\n- {report}\n\n"
        + "このアプリの中央ロゴ機能だけを対象とする生成ノート。正本以外のアプリ・本番環境は変更しない。\n",
        NOTES[1]: "# 中央ロゴのアーキテクチャ\n\n"
        + f"{home} / {feature} / {canonical}\n\n" + section("## 実装境界") + "\n\n"
        + "## Graphifyで直接抽出するコード\n\n"
        + "- `src/qr-image.mjs` — QR描画、予約セル保護、合成後の復号。\n"
        + "- `supabase/functions/_shared/qr-logos.mjs` — 固定ID・PNG名・ID検証。\n\n"
        + "上記2ファイルのASTと正本2文書だけを抽出する。UI・API・SQLの実装詳細は文書記載の契約であり、"
        + "それらの全コードを抽出・検証したという意味ではない。コード原文も `80_リポジトリ文書/` に同じパスで複写する。\n",
        NOTES[2]: "# 中央ロゴ：共有保存と読み取り安全策\n\n"
        + f"{home} / {architecture} / {canonical}\n\n"
        + "\n\n".join(section(h) for h in ("## 状態", "## 確認済みの要件", "## 調査と安全上の限界",
                                                    "## 素材と公開範囲", "## 検証証跡（実行済み分のみ）", "## 反映とロールバック"))
        + "\n\n検証・反映状況は正本の該当節を毎回再抽出する。文書にない候補版の結果や本番反映を推定しない。\n",
        NOTES[3]: "# MARUGO QR 知識更新\n\n" + f"{home} / {architecture} / {feature} / {canonical} / {report}\n\n"
        + "## 正本と範囲\n\n"
        + f"リポジトリ: `{repo}`\n\n"
        + "\n".join(f"- `{source}`" for source in SOURCES) + "\n\n"
        + f"文書意味抽出ルール: `{MODEL}`。ホストLLMが実際の文書から抽出した関係と一意の根拠アンカーを保存する。"
        + "文書全体・状態節・検証節は現在の本文を再読し、行範囲とSHA-256を付ける。要件のアンカーが失われたら停止し、"
        + "ホストが根拠と関係を再レビューする。新しい意味関係を自動推測する生成器ではない。\n\n"
        + "## 更新・検査\n\nリポジトリで実行:\n\n```sh\n" + command + "\n" + command + " --check\n"
        + f"QR_KNOWLEDGE_PYTHON={shlex.quote(python)} node --test tests/qr-knowledge.test.mjs\n```\n\n"
        + "`--vault <vault-root>` で共有Vaultを指定できる。出力先は必ず `10_アプリ別/MARUGO QR`。"
        + "`--check` はPython標準ライブラリだけで動作し、書き込まない。通常のNodeテストはGraphifyやVaultを必要としない。\n\n"
        + "## 監査と限界\n\n"
        + "正本ミラーは4ファイルをバイト一致で検査する。全管理対象成果物のハッシュ、Vault内wikilink、"
        + "グラフのノード/辺の端点・正本ハッシュ・日本語の根拠を確認する。"
        + "コードはGraphify AST、文書/素材台帳は意味抽出とJSONの実データをGraphifyのキャッシュ/ビルドに渡す。"
        + "生成された問答や他アプリのファイルは入力しない。\n\n"
        + "Graphifyの単純有向グラフでは同一端点のcontains/calls等が1本に集約される場合がある。"
        + "`graph.json`は元の全関係を保持し、レポートにJSON関係数と表示用トポロジーの辺数を別記する。"
        + "HTMLはGraphify標準の外部vis-networkスクリプトを参照するため、完全オフライン表示は保証しない。"
        + "生成器はネットワーク通信・アップロードを行わず、資格情報を読み込まない。\n\n"
        + "ホストLLM抽出のトークン使用量は取得できない。Graphifyの0カウンターは未計測のプレースホルダーで、"
        + "LLMコスト0の証明ではない。再生成自体は保存済みの根拠とルールを再生し、外部LLMは呼ばない。"
        + "本番反映の成否は正本を更新する担当者の実際の読み戻し証跡で別途判断する。\n",
    }


def wikilinks(vault: Path, paths: list[Path]) -> tuple[int, list]:
    count, broken = 0, []
    for path in paths:
        if path.suffix != ".md":
            continue
        for target in re.findall(r"\[\[([^\]\n]+)\]\]", path.read_text(encoding="utf-8")):
            name = target.split("|", 1)[0].split("#", 1)[0]
            count += 1
            if not name:
                continue
            candidate = vault / name
            if not candidate.is_file() and not Path(str(candidate) + ".md").is_file():
                broken.append({"note": str(path.relative_to(vault)), "target": name})
    return count, broken


def verify(repo: Path, vault: Path, app: Path, sources: dict, hashes: dict) -> dict:
    preflight_paths(repo, vault, app)
    out = app / "graphify-out"
    manifest_path = out / "KNOWLEDGE_MANIFEST.json"
    if not manifest_path.is_file():
        raise ValueError("Export missing: run the update command first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_inputs = {**hashes, MODEL: sha((repo / MODEL).read_bytes()), SCRIPT: sha(Path(__file__).read_bytes())}
    if manifest["input_hashes"] != expected_inputs:
        raise ValueError("Stale source/model/generator hash: rerun update")
    artifacts = manifest.get("artifact_hashes")
    if not isinstance(artifacts, dict):
        raise ValueError("Invalid artifact inventory")
    # Validate ALL literal keys and resolved paths before reading even one artifact.
    for name in artifacts:
        if (not isinstance(name, str) or name not in ARTIFACTS or Path(name).is_absolute()
                or any(part in ("", ".", "..") for part in name.split("/"))):
            raise ValueError(f"Refusing unsafe/unexpected artifact key: {name!r}")
    if set(artifacts) != ARTIFACTS:
        raise ValueError(f"Incomplete artifact inventory; missing: {sorted(ARTIFACTS - set(artifacts))}")
    paths = {name: confined(app, app / name) for name in artifacts}
    validated = {}
    for name, expected in artifacts.items():
        path = paths[name]
        if not path.is_file() or sha(path.read_bytes()) != expected:
            raise ValueError(f"Stale/missing artifact hash: {name}")
        validated[name] = path
    mirrors = 0
    for source in SOURCES:
        if validated["80_リポジトリ文書/" + source].read_bytes() != (repo / source).read_bytes():
            raise ValueError(f"Mirror mismatch: {source}")
        mirrors += 1
    count, broken = wikilinks(vault, list(validated.values()))
    if broken:
        raise ValueError("Broken wikilinks: " + json.dumps(broken, ensure_ascii=False))
    graph = json.loads(validated["graphify-out/graph.json"].read_text(encoding="utf-8"))
    nodes, edges = graph["nodes"], graph.get("links", graph.get("edges", []))
    ids = {node["id"] for node in nodes}
    if len(ids) != len(nodes) or not nodes or not edges:
        raise ValueError("Empty graph or duplicate node IDs")
    if any(edge["source"] not in ids or edge["target"] not in ids for edge in edges):
        raise ValueError("Dangling graph endpoints")
    if graph.get("graph", {}).get("source_hashes") != hashes:
        raise ValueError("Graph source hashes disagree")
    for item in [*nodes, *edges]:
        source = item.get("source_file", "")
        if not source and item.get("external"):
            continue
        if source not in hashes or item.get("source_sha256") != hashes[source]:
            raise ValueError(f"Missing/stale graph provenance: {source}")
        if not item.get("source_location"):
            raise ValueError("Missing graph source location")
        evidence = item.get("evidence")
        if evidence and evidence not in sources[source]:
            raise ValueError("Graph evidence not present in canonical source")
    decoded = json.dumps(graph, ensure_ascii=False)
    facts = {
        "shared_per_qr": "QRごとに保存", "same_store": "同じ店舗", "h_codewords": "総コードワード",
        "not_area_ratio": "面積・幅", "quiet_zones": "クワイエットゾーン", "reserved_patterns": "予約セル",
        "decode_gate": "復号", "tracking_url": "計測URL",
    }
    fact_results = {key: token in decoded for key, token in facts.items()}
    if not all(fact_results.values()):
        raise ValueError("Missing decoded Japanese graph facts")
    status = select(sources[SOURCES[0]], {"kind": "section", "text": "## 状態"})[0]
    status_node = next(n for n in nodes if n["id"] == "docs_qr_logos_status")
    if status_node.get("evidence") != status:
        raise ValueError("Graph release/testing status differs from canonical status")
    return {"app": APP, "check": "PASS", "mirrors": mirrors, "notes": sum(name in NOTES for name in validated),
            "wikilinks": count, "broken_wikilinks": 0, "nodes": len(nodes), "edges": len(edges),
            "topology_edges": manifest["topology_edges"], "communities": manifest["communities"],
            "source_hashes": hashes, "japanese_facts": fact_results, "canonical_status": status,
            "graphify_version": manifest["graphify_version"], "python": manifest["python"],
            "semantic_cache": manifest["semantic_cache"], "artifact_files": len(validated)}


def update(repo: Path, vault: Path, app: Path, model: dict, sources: dict, hashes: dict, skill: Path) -> dict:
    preflight_paths(repo, vault, app)
    preflight_mirror(app)
    before = snapshot(skill)
    spec = skill / "references/extraction-spec.md"
    if sha(spec.read_bytes()) != model["extractionSpecSha256"]:
        raise ValueError("Graphify extraction spec changed; re-review the extraction model")
    out = app / "graphify-out"
    os.environ["GRAPHIFY_NO_AUTO_REFRESH"] = "1"
    os.environ["GRAPHIFY_OUT"] = str(out)
    # These are actual installed Graphify APIs; no hand-built replacement graph.
    from graphify.detect import detect, save_manifest
    from graphify.extract import extract
    from graphify.cache import check_semantic_cache, save_semantic_cache
    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes, surprising_connections, suggest_questions
    from graphify.export import to_json, to_html
    from graphify.report import generate
    from graphify.diagnostics import diagnose_extraction

    out.mkdir(parents=True, exist_ok=True)
    generated = []
    for source in SOURCES:
        target = app / "80_リポジトリ文書" / source
        write(target, (repo / source).read_bytes(), root=app)
        generated.append(target)
    for name, text in notes(repo, app, sources, sys.executable).items():
        write(app / name, text, root=app)
        generated.append(app / name)
    preflight_mirror(app, complete=True)
    detected = detect(app / "80_リポジトリ文書", cache_root=app, gitignore=False, google_workspace=False)
    accepted = {str((app / "80_リポジトリ文書" / p).resolve()) for p in SOURCES}
    outside = [f for files in detected["files"].values() for f in files if str(Path(f).resolve()) not in accepted]
    if outside:
        raise ValueError(f"Detector admitted noncanonical input: {outside}")
    # JSON artwork metadata is a semantic document, not executable code.
    files = {"code": [str(repo / p) for p in SOURCES[2:]], "document": [str(repo / p) for p in SOURCES[:2]]}
    detection = {**detected, "files": files, "total_files": len(SOURCES), "scan_root": str(repo),
                 "source_allowlist": list(SOURCES), "detector_scan_root": str(app / "80_リポジトリ文書")}
    semantic = materialize(repo, model, sources, hashes)
    cached_nodes, cached_edges, cached_hyperedges, uncached = check_semantic_cache(
        files["document"], root=repo, prompt_file=spec, cache_root=app)
    cached = {"nodes": cached_nodes, "edges": cached_edges, "hyperedges": cached_hyperedges}
    # A changed host-reviewed rule is not a reusable extraction just because file bytes match.
    expected = {kind: semantic[kind] for kind in cached}
    if not uncached and cached != expected:
        uncached = list(files["document"])
    fresh = {kind: [row for row in semantic[kind] if row.get("source_file") in uncached]
             for kind in ("nodes", "edges", "hyperedges")}
    saved = save_semantic_cache(fresh["nodes"], fresh["edges"], fresh["hyperedges"], root=repo,
                                allowed_source_files=uncached, prompt_file=spec, cache_root=app) if uncached else 0
    # Read back through Graphify's prompt-keyed protocol; never claim unstamped docs.
    ns, es, hs, remaining = check_semantic_cache(files["document"], root=repo, prompt_file=spec, cache_root=app)
    if remaining or {"nodes": ns, "edges": es, "hyperedges": hs} != expected:
        raise ValueError("Graphify semantic cache readback differs from extracted evidence")
    ast = extract([Path(p) for p in files["code"]], cache_root=app, root=repo, parallel=False)
    if ast.get("failed_sources"):
        raise ValueError("Graphify AST extraction failed")
    for item in [*ast["nodes"], *ast["edges"]]:
        source = Path(item["source_file"])
        source = str(source.relative_to(repo)) if source.is_absolute() else source.as_posix()
        item["source_file"] = str(repo / source)
        item["source_sha256"] = hashes[source]
        if "confidence" in item:
            item["confidence_score"] = 1.0
        if item.get("source_location"):
            location = re.match(r"L(\d+)", item["source_location"])
            if location is None:
                raise ValueError("Graphify AST source location format changed")
            line = int(location.group(1))
            item["evidence"] = sources[source].splitlines()[line - 1]
    merged = {"nodes": ast["nodes"] + semantic["nodes"], "edges": ast["edges"] + semantic["edges"],
              "hyperedges": semantic["hyperedges"], "input_tokens": 0, "output_tokens": 0}
    graph = build_from_json(merged, root=repo, directed=True, dedup=False)
    if not graph.number_of_nodes():
        raise ValueError("Empty Graphify graph")
    graph.graph.update(source_hashes=hashes, app=APP, semantic_model_sha256=sha((repo / MODEL).read_bytes()),
                       token_accounting="Host extraction usage unavailable; placeholder counters are not measured cost")
    communities = cluster(graph)
    cohesion = score_all(graph, communities)
    # Deterministic labels derive from actual members, without inventing relations.
    labels = {}
    for cid, members in communities.items():
        if "docs_qr_logo_assets_doc" in members:
            labels[cid] = "静的ロゴ素材台帳"
        elif "docs_qr_logos_doc" in members:
            labels[cid] = "中央ロゴ要件と安全策"
        elif "supabase_functions_shared_qr_logos_findqrlogo" in members:
            labels[cid] = "共有ロゴIDカタログ"
        else:
            labels[cid] = "QR描画と復号ゲート"
    gods = god_nodes(graph)
    surprises = surprising_connections(graph, communities)
    questions = suggest_questions(graph, communities, labels)
    diagnostics = diagnose_extraction(merged, directed=True, root=repo)
    # Preserve literal parallel contains/calls relationships in JSON, not just topology.
    exported_links = [{**edge, "source_file": str(Path(edge["source_file"]).relative_to(repo))}
                      for edge in merged["edges"]]
    if not to_json(graph, communities, str(confined(app, out / "graph.json")), force=True,
                   community_labels=labels, original_links=exported_links):
        raise ValueError("Graphify JSON export refused")
    report = generate(graph, communities, cohesion, labels, gods, surprises, detection,
                      {"input": 0, "output": 0}, str(repo), suggested_questions=questions)
    report += ("\n\n## MARUGO QR scoped export audit\n\n"
               f"- Canonical corpus: {len(SOURCES)} files; no other app is scanned.\n"
               f"- AST: {len(ast['nodes'])} nodes / {len(ast['edges'])} relationships.\n"
               f"- Semantic documents/catalog: {len(semantic['nodes'])} nodes / {len(semantic['edges'])} relationships.\n"
               f"- graph.json retains {len(merged['edges'])} literal relationships; HTML/report topology has {graph.number_of_edges()} edges.\n"
               "- Duplicate endpoint relations can collapse in the simple visualization topology; all original relations remain in graph.json.\n"
               "- Host extraction token usage is unavailable. Zero counters above are placeholders, not a measured zero-token claim. No remote API was called.\n"
               "- Source/status evidence is from canonical docs, not proof of production deployment.\n\n"
               + select(sources[SOURCES[0]], {"kind": "section", "text": "## 状態"})[0] + "\n")
    write(out / "GRAPH_REPORT.md", report, root=app)
    if not to_html(graph, communities, str(confined(app, out / "graph.html")), community_labels=labels):
        raise ValueError("Graphify HTML export failed")
    sidecars = {".graphify_detect.json": detection, ".graphify_ast.json": ast,
                ".graphify_chunk_01.json": semantic, ".graphify_semantic.json": semantic,
                ".graphify_extract.json": merged, ".graphify_labels.json": labels,
                ".graphify_analysis.json": {"communities": communities, "cohesion": cohesion, "gods": gods,
                                            "surprises": surprises, "questions": questions},
                "DIAGNOSTICS.json": diagnostics,
                "SOURCE_INTEGRITY.json": {"source_hashes": hashes, "skill_before": before,
                                          "skill_after": snapshot(skill), "extraction_spec_sha256": sha(spec.read_bytes())}}
    if sidecars["SOURCE_INTEGRITY.json"]["skill_after"] != before:
        raise ValueError("Installed Graphify skill changed during export")
    for name, data in sidecars.items():
        dump(out / name, data, root=app)
    write(out / ".graphify_python", sys.executable + "\n", root=app)
    write(out / ".graphify_root", str(repo) + "\n", root=app)
    save_manifest(files, manifest_path=str(confined(app, out / "manifest.json")), root=repo,
                  scan_corpus={p for values in files.values() for p in values})
    generated += [out / name for name in (*sidecars, ".graphify_python", ".graphify_root", "manifest.json",
                                         "graph.json", "graph.html", "GRAPH_REPORT.md")]
    manifest = {"schemaVersion": 1, "app": APP, "python": sys.executable,
                "graphify_version": importlib.metadata.version("graphifyy"), "source_hashes": hashes,
                "input_hashes": {**hashes, MODEL: sha((repo / MODEL).read_bytes()), SCRIPT: sha(Path(__file__).read_bytes())},
                "artifact_hashes": {str(p.relative_to(app)): sha(p.read_bytes()) for p in sorted(generated)},
                "semantic_cache": {"hits": len(files["document"]) - len(uncached), "saved": saved,
                                   "readback_files": len(files["document"]) - len(remaining)},
                "topology_edges": graph.number_of_edges(), "communities": len(communities)}
    dump(out / "KNOWLEDGE_MANIFEST.json", manifest, root=app)
    return verify(repo, vault, app, sources, hashes)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--vault", type=Path, default=Path(os.environ.get("OBSIDIAN_VAULT_PATH",
                        str(Path.home() / "Library/CloudStorage/Dropbox/web/アプリ知識"))))
    parser.add_argument("--skill-dir", type=Path, default=Path.home() / ".Codex/skills/graphify")
    parser.add_argument("--check", action="store_true", help="Read-only stdlib freshness/integrity check")
    args = parser.parse_args()
    repo, vault = args.repo.resolve(), args.vault.resolve()
    app = vault / AREA
    preflight_paths(repo, vault, app)
    model = json.loads((repo / MODEL).read_text(encoding="utf-8"))
    if model["schemaVersion"] != 1 or tuple(model["sources"]) != SOURCES:
        raise ValueError("Only the reviewed four canonical sources are allowed")
    sources = {name: (repo / name).read_text(encoding="utf-8") for name in SOURCES}
    hashes = {name: sha((repo / name).read_bytes()) for name in SOURCES}
    materialize(repo, model, sources, hashes)  # validate all anchors before any write
    result = verify(repo, vault, app, sources, hashes) if args.check else update(
        repo, vault, app, model, sources, hashes, args.skill_dir.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, ImportError) as exc:
        print(f"QR knowledge export: {exc}", file=sys.stderr)
        raise SystemExit(1)
