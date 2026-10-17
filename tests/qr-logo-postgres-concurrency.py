"""Real competing sessions for row locks and first-completion replay.

Imported only by qr-logo-local-postgres.py; accepts its disposable container name.
No host ports, remote DB configuration, or credentials are used.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import time
import uuid


def check_concurrency(container: str, log_dir: Path, *, docker_command: list[str], docker_env: dict[str, str]) -> None:
    if not re.fullmatch(r"qr-logo-local-[0-9a-f]{12}", container):
        raise ValueError("concurrency tests require the harness's disposable container")
    log_path = log_dir / "concurrency.log"
    commands: list[list[str]] = []
    workers: list[subprocess.Popen] = []

    def command(*, app: str = "qr-logo-observer", statement: str | None = None) -> list[str]:
        result = [*docker_command, "exec", "-i", "-e", f"PGAPPNAME={app}", container,
                  "psql", "-X", "-h", "127.0.0.1", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At"]
        if statement is not None:
            result += ["-c", statement]
        commands.append(result)
        return result

    def record(label: str, stdout: str, stderr: str = "") -> None:
        with log_path.open("a", encoding="utf-8") as log:
            log.write(f"--- {label} ---\n{stdout}{stderr}")

    def sql(statement: str) -> str:
        result = subprocess.run(command(statement=statement), text=True, capture_output=True, timeout=15, env=docker_env)
        record(statement, result.stdout, result.stderr)
        if result.returncode:
            raise AssertionError(result.stderr)
        return result.stdout.strip()

    def row(statement: str) -> dict:
        return json.loads(sql(statement))

    def holder(statement: str) -> subprocess.Popen:
        worker = subprocess.Popen(command(app="qr-logo-holder"), stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=docker_env)
        workers.append(worker)
        assert worker.stdin is not None
        worker.stdin.write("begin;\n" + statement + ";\nselect 'LOCK_READY';\n")
        worker.stdin.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            ready = sql("select count(*) from pg_stat_activity where application_name='qr-logo-holder' and state='idle in transaction' and query like '%LOCK_READY%'")
            if ready == "1":
                record("holder ready", statement + "\n")
                return worker
            if worker.poll() is not None:
                break
            time.sleep(0.05)
        raise AssertionError("lock holder never became ready")

    def launch(app: str, statement: str) -> subprocess.Popen:
        worker = subprocess.Popen(command(app=app, statement=statement), stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=docker_env)
        workers.append(worker)
        return worker

    def waiting(apps: list[str]) -> None:
        names = ",".join("'" + app + "'" for app in apps)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            value = sql(f"select count(*) from pg_stat_activity where application_name in ({names}) and wait_event_type='Lock'")
            if int(value) == len(apps):
                record("verified lock wait", ", ".join(apps) + "\n")
                return
            time.sleep(0.05)
        raise AssertionError(f"expected all competing sessions to wait on locks: {apps}")

    def release(worker: subprocess.Popen) -> None:
        assert worker.stdin is not None
        worker.stdin.write("commit;\n\\q\n")
        worker.stdin.flush()
        stdout, stderr = worker.communicate(timeout=15)
        record("holder released", stdout, stderr)
        if worker.returncode:
            raise AssertionError(stderr)

    def finish(worker: subprocess.Popen, *, error: str | None = None) -> dict | None:
        stdout, stderr = worker.communicate(timeout=15)
        record("worker completed", stdout, stderr)
        if error:
            assert worker.returncode != 0 and error in stderr, (stdout, stderr)
            return None
        assert worker.returncode == 0, (stdout, stderr)
        return json.loads(stdout.strip())

    try:
        own, item, event = (str(uuid.uuid4()) for _ in range(3))
        code = uuid.uuid4().hex[:12]
        initial = row(f"select public.kotonoha_qr('create','{own}','{item}',jsonb_build_object('code','{code}','title','Lock test','targetUrl','https://example.com/lock'))")
        lock = holder(f"select id from kotonoha.qr_links where id='{item}' for update")
        logo = launch("qr-logo-update-wait", f"select public.kotonoha_qr('logo','{own}','{item}','{{\"logoId\":\"line-ios\"}}')")
        scan = launch("qr-logo-scan-wait", f"select public.kotonoha_qr_scan_unique('{code}','{event}')")
        waiting(["qr-logo-update-wait", "qr-logo-scan-wait"])
        release(lock)
        updated, scanned = finish(logo), finish(scan)
        assert updated is not None and updated["logo_id"] == "line-ios"
        assert scanned is not None and scanned["targetUrl"] == initial["target_url"]
        current = row(f"select to_jsonb(l) from kotonoha.qr_links l where id='{item}'")
        assert current["logo_id"] == "line-ios" and current["scan_count"] == 1
        for key in ["id", "owner_id", "code", "target_url", "created_at", "active", "deleted_at"]:
            assert current[key] == initial[key], key
        print("PASS: logo update and scan wait for the same parent row, then preserve both effects", flush=True)

        lock = holder(f"select public.kotonoha_qr_lifecycle('trash','{own}','{item}')")
        logo = launch("qr-logo-trash-wait", f"select public.kotonoha_qr('logo','{own}','{item}','{{\"logoId\":null}}')")
        waiting(["qr-logo-trash-wait"])
        release(lock)
        finish(logo, error="TRASHED")
        assert sql(f"select logo_id from kotonoha.qr_links where id='{item}'") == "line-ios"
        print("PASS: a logo update waiting behind trash rechecks the locked row and cannot mutate", flush=True)

        item = str(uuid.uuid4())
        args = json.dumps({"title": "Competing completion", "fileName": "menu.pdf", "mime": "application/pdf", "size": 100, "logoId": "instagram-gradient"})
        row(f"select public.kotonoha_qr_file('init','{own}','{item}','{args}')")
        lock = holder(f"select id from kotonoha.qr_files where id='{item}' for update")
        completions = []
        for index in range(2):
            code = uuid.uuid4().hex[:12]
            payload = json.dumps({"code": code, "targetUrl": "https://marugo-s.github.io/multiapp/?file=" + code})
            completions.append(launch(f"qr-logo-complete-{index}", f"select public.kotonoha_qr_file('complete','{own}','{item}','{payload}')"))
        waiting(["qr-logo-complete-0", "qr-logo-complete-1"])
        release(lock)
        results = [finish(worker) for worker in completions]
        assert all(isinstance(result, dict) and result.get("id") == item and result.get("logo_id") == "instagram-gradient" for result in results), "both competing first completions must return the frozen-logo link, never null"
        assert results[0] == results[1], "competing completion must return the same persisted identity"
        assert sql(f"select count(*) from kotonoha.qr_links where id='{item}'") == "1"
        print("PASS: competing first completions return the same persisted frozen-logo link", flush=True)
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.kill()
                worker.communicate(timeout=10)
        (log_dir / "concurrency-commands.json").write_text(json.dumps(commands, indent=2) + "\n")
