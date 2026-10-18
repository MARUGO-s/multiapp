#!/usr/bin/env python3
"""QR-only migration tests in network-isolated disposable PostgreSQL.

Uses an already-installed Docker image (never pulls), no Supabase configuration,
no real credentials, no host ports. DB files and saved logs remain under Hermes
scratch; container is always stopped and removed. Safe baseline RED mode skips
the original logo migration: --baseline; --store-baseline skips only the additive
store catalog extension; --caption-baseline skips only the caption migration.
Extra SQL paths are repository-relative.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
TARGET = MIGRATIONS / "20261017100000_qr_logo_selection.sql"
STORE_TEST = ROOT / "tests/qr-store-logo-database.sql"
SCRATCH = Path.home() / ".hermes/cache/scratch"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--caption-baseline", action="store_true", help="skip only the store caption migration for RED")
    parser.add_argument("--store-baseline", action="store_true", help="exercise store-logo tests against the old SNS-only validator")
    parser.add_argument("--sql", action="append", help="SQL test relative to repository; defaults to logo tests")
    parser.add_argument("--concurrency", action="store_true", help="also exercise real row locks and competing first completions")
    parser.add_argument("--log-dir", type=Path)
    args = parser.parse_args()
    SCRATCH.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix="qr-logo-postgres-", dir=SCRATCH))
    log_dir = (args.log_dir or run_dir).resolve()
    if not log_dir.is_relative_to(SCRATCH.resolve()):
        raise ValueError("logs must remain within Hermes scratch")
    log_dir.mkdir(parents=True, exist_ok=True)
    name = "qr-logo-local-" + uuid.uuid4().hex[:12]
    image = "postgres:17"
    commands: list[list[str]] = []
    docker_command = ["docker"]
    docker_env = os.environ.copy()

    def run(command: list[str], *, sql: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
        command = docker_command + command[1:]
        commands.append(command)
        result = subprocess.run(command, input=sql, text=True, capture_output=True, env=docker_env)
        with (log_dir / "postgres.log").open("a", encoding="utf-8") as log:
            log.write("$ " + " ".join(command) + "\n" + result.stdout + result.stderr)
        if check and result.returncode:
            print(result.stdout + result.stderr, end="", flush=True)
            raise subprocess.CalledProcessError(result.returncode, command)
        return result

    def sql(source: str) -> str:
        result = run(["docker", "exec", "-i", name, "psql", "-X", "-h", "127.0.0.1", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At"], sql=source)
        print(result.stdout, end="", flush=True)
        return result.stdout

    launch_attempted = False
    removed = False
    try:
        endpoint = run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).stdout.strip()
        if not endpoint.startswith("unix:///"):
            raise RuntimeError("refusing a non-local Docker daemon; no DB tests were run")
        docker_command += ["--host", endpoint]
        for variable in ["DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]:
            docker_env.pop(variable, None)
        run(["docker", "image", "inspect", image])
        (run_dir / "data").mkdir()
        launch_attempted = True
        run(["docker", "run", "--pull=never", "--detach", "--name", name,
             "--network", "none", "--mount", f"type=bind,source={run_dir / 'data'},target=/var/lib/postgresql/data",
             "--env", "POSTGRES_HOST_AUTH_METHOD=trust", image, "postgres", "-c", "listen_addresses=127.0.0.1"])

        for _ in range(80):
            ready = run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False)
            if ready.returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("disposable PostgreSQL failed readiness")
        print(f"Disposable PostgreSQL: {name}; data/logs: {run_dir}; no network or published ports", flush=True)
        sql((ROOT / "tests/qr-logo-postgres-bootstrap.sql").read_text())
        for migration in [
            "20261002091255_kotonoha_qr_tracking.sql",
            "20261002094223_qr_daily_analytics.sql",
            "20261002115222_qr_trash.sql",
            "20261002121828_qr_file_publishing.sql",
            "20261003090000_marugo_qr_store_accounts.sql",
            "20261007100000_shared_qr_login.sql",
            "20261007103620_qr_unique_analytics.sql",
        ]:
            print("Applying " + migration, flush=True)
            sql((MIGRATIONS / migration).read_text())
        sql((ROOT / "tests/qr-logo-postgres-legacy.sql").read_text())
        if not args.baseline and TARGET.exists():
            print("Applying " + TARGET.name, flush=True)
            sql(TARGET.read_text())
        else:
            print("New migration skipped/absent: testing pre-feature baseline", flush=True)
        if not args.baseline and TARGET.exists() and STORE_TEST.exists():
            print("Seeding pre-extension SNS rows and catalog snapshots", flush=True)
            sql("\\set qr_store_logo_before true\n" + STORE_TEST.read_text())
            if not args.store_baseline:
                for migration in sorted(MIGRATIONS.glob("*_qr_store_logo_catalog.sql")):
                    print("Applying " + migration.name, flush=True)
                    sql(migration.read_text())
            else:
                print("Store catalog migration skipped: testing SNS-only baseline", flush=True)
        # Catalog-only assertions compare exact pre-caption schemas. Verify them
        # at their migration boundary, then snapshot and exercise the latest chain.
        caption_test = ROOT / "tests/qr-store-name-database.sql"
        if not args.baseline and not args.store_baseline:
            print("Executing tests/qr-store-logo-database.sql (catalog migration boundary)", flush=True)
            sql(STORE_TEST.read_text())
            sql("\\set qr_store_name_before true\n" + caption_test.read_text())
            if not args.caption_baseline:
                for migration in sorted(MIGRATIONS.glob("*_qr_store_name.sql")):
                    print("Applying " + migration.name, flush=True)
                    sql(migration.read_text())
        feature_tests = (["tests/qr-store-logo-database.sql"] if args.baseline or args.store_baseline
                         else ["tests/qr-store-name-database.sql", "tests/qr-store-name-validation.sql"])
        for test in args.sql or feature_tests + [
            "tests/qr-logo-database.sql", "tests/qr-logo-files-database.sql",
            "tests/qr-logo-regression-database.sql", "tests/qr-files.sql", "tests/qr-trash.sql",
            "tests/qr-analytics.sql", "tests/qr-unique.sql", "tests/qr-accounts.sql",
        ]:
            if test == "tests/qr-store-logo-database.sql" and not args.baseline and not args.store_baseline:
                continue  # Already verified before the additive caption DDL.
            path = (ROOT / test).resolve()
            if not path.is_relative_to(ROOT / "tests"):
                raise ValueError("SQL tests must live within repository tests/")
            print("Executing " + str(path.relative_to(ROOT)), flush=True)
            sql(path.read_text())
        if args.concurrency or not args.sql:
            runpy.run_path(str(ROOT / "tests/qr-logo-postgres-concurrency.py"))["check_concurrency"](
                name, log_dir, docker_command=docker_command, docker_env=docker_env)
        print("PASS: all selected PostgreSQL persistence checks", flush=True)
    finally:
        try:
            if launch_attempted:
                try:
                    run(["docker", "logs", name], check=False)
                finally:
                    try:
                        run(["docker", "rm", "--force", name], check=False)
                    finally:
                        result = run(["docker", "container", "inspect", name], check=False)
                        if result.returncode == 0:
                            raise RuntimeError("disposable container cleanup failed")
                        absence = run(["docker", "container", "ls", "--all", "--filter", f"name=^/{name}$", "--format", "{{.Names}}"], check=False)
                        if absence.returncode:
                            raise RuntimeError("cannot verify disposable container absence: Docker daemon or inspection unavailable")
                        if absence.stdout.strip():
                            raise RuntimeError("disposable container cleanup failed")
                        removed = True
                        shutil.rmtree(run_dir / "data")
        finally:
            (log_dir / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
            print(f"Saved PostgreSQL evidence: {log_dir}; disposable container removed={removed}", flush=True)


if __name__ == "__main__":
    main()
