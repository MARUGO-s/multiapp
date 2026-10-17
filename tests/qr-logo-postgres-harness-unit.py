#!/usr/bin/env python3
"""Portable subprocess-boundary regressions; never invokes a real Docker CLI."""
from __future__ import annotations

from contextlib import nullcontext, redirect_stdout
import io
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
LOCAL_ENDPOINT = "unix:///mock-local/docker.sock"
REMOTE_ENDPOINT = "ssh://mock-remote.invalid"


class StopAfterLaunch(RuntimeError):
    pass


class FakeWorker:
    def __init__(self):
        self.stdin = io.StringIO()
        self.returncode = None

    def poll(self):
        return self.returncode

    def kill(self):
        self.returncode = -9

    def communicate(self, timeout=None):
        return "", ""


class FakeDocker:
    def __init__(self, endpoint: str = LOCAL_ENDPOINT, *, forbid_daemon: bool = False,
                 stop_at_launch: bool = False, fail_launch: bool = False,
                 cleanup_unavailable: bool = False, fail_logs: bool = False):
        self.endpoint = endpoint
        self.forbid_daemon = forbid_daemon
        self.calls: list[dict] = []
        self.container: str | None = None
        self.stop_at_launch = stop_at_launch
        self.popen_count = 0
        self.fail_launch = fail_launch
        self.launched_name: str | None = None
        self.cleanup_unavailable = cleanup_unavailable
        self.data_path: Path | None = None
        self.fail_logs = fail_logs

    def run(self, command: list[str], **kwargs) -> subprocess.CompletedProcess:
        assert command[0] == "docker", command
        arguments = command[1:]
        if arguments[:1] == ["--host"]:
            arguments = arguments[2:]
        self.calls.append({"command": command[:], "arguments": arguments,
                           "env": dict(kwargs.get("env", os.environ)), "kind": "run"})
        if arguments[:2] == ["context", "inspect"]:
            return subprocess.CompletedProcess(command, 0, self.endpoint + "\n", "")
        if self.forbid_daemon:
            raise RuntimeError("mock blocked a daemon operation: " + " ".join(arguments))
        if arguments[:1] == ["run"]:
            self.container = arguments[arguments.index("--name") + 1]
            self.launched_name = self.container
            mount = arguments[arguments.index("--mount") + 1]
            self.data_path = Path(mount.split("source=", 1)[1].split(",target=", 1)[0])
            if self.fail_launch:
                return subprocess.CompletedProcess(command, 125, "", "mock CLI failed after container creation/start\n")
        if self.cleanup_unavailable and arguments[:1] in [["rm"], ["container"]]:
            return subprocess.CompletedProcess(command, 1, "", "mock Docker daemon unavailable\n")
        if self.fail_logs and arguments[:1] == ["logs"]:
            raise OSError("mock log collection failed")
        if arguments[:1] == ["rm"]:
            self.container = None
        if arguments[:2] == ["container", "inspect"] and self.container is None:
            return subprocess.CompletedProcess(command, 1, "[]\n", "Error: No such container: " + arguments[-1] + "\n")
        if arguments[:2] == ["container", "ls"]:
            return subprocess.CompletedProcess(command, 0, (self.container + "\n") if self.container else "", "")
        if arguments[:1] == ["exec"] and "-c" in arguments:
            statement = arguments[arguments.index("-c") + 1]
            stdout = "1\n" if "pg_stat_activity" in statement else '{"target_url":"https://example.com/lock"}\n'
            return subprocess.CompletedProcess(command, 0, stdout, "")
        return subprocess.CompletedProcess(command, 0, "", "")

    def popen(self, command: list[str], **kwargs):
        assert command[0] == "docker", command
        arguments = command[1:]
        if arguments[:1] == ["--host"]:
            arguments = arguments[2:]
        self.calls.append({"command": command[:], "arguments": arguments,
                           "env": dict(kwargs.get("env", os.environ)), "kind": "Popen"})
        self.popen_count += 1
        if not self.stop_at_launch:
            raise AssertionError("unexpected Popen in mocked Docker boundary: " + " ".join(command))
        if self.popen_count == 1:
            return FakeWorker()
        raise StopAfterLaunch("both concurrency Popen paths observed")

    @property
    def daemon_calls(self) -> list[dict]:
        return [call for call in self.calls if call["arguments"][:2] != ["context", "inspect"]]


class HarnessTestCase(unittest.TestCase):
    def setUp(self) -> None:
        scratch = Path.home() / ".hermes/cache/scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="qr-logo-harness-unit-", dir=scratch)
        self.addCleanup(self.temporary.cleanup)
        self.scratch = Path(self.temporary.name)
        self.log_dir = self.scratch / "evidence"

    def invoke(self, docker: FakeDocker, environment: dict[str, str], *, concurrency: bool = False,
               fail_launch_log: bool = False):
        main = runpy.run_path(str(ROOT / "tests/qr-logo-local-postgres.py"))["main"]
        argv = ["qr-logo-local-postgres.py", "--log-dir", str(self.log_dir),
                "--sql", "tests/qr-logo-database.sql"]
        if concurrency:
            argv.append("--concurrency")
        output = io.StringIO()
        error = None
        original_open = Path.open
        log_failed = False

        def open_path(path, *args, **kwargs):
            nonlocal log_failed
            if path == self.log_dir / "postgres.log" and docker.launched_name and not log_failed:
                log_failed = True
                raise OSError("mock log append failed after successful docker run")
            return original_open(path, *args, **kwargs)

        log_io = mock.patch.object(Path, "open", open_path) if fail_launch_log else nullcontext()
        with mock.patch.dict(os.environ, environment, clear=True), \
                mock.patch.dict(main.__globals__, {"SCRATCH": self.scratch}), \
                mock.patch.object(sys, "argv", argv), \
                mock.patch.object(subprocess, "run", side_effect=docker.run), \
                mock.patch.object(subprocess, "Popen", side_effect=docker.popen), \
                log_io, \
                redirect_stdout(output):
            try:
                main()
            except Exception as caught:
                error = caught
        return error, output.getvalue()


class DockerEndpointTests(HarnessTestCase):
    def test_remote_context_overrides_local_host_before_daemon_io(self) -> None:
        docker = FakeDocker(REMOTE_ENDPOINT, forbid_daemon=True)
        error, _ = self.invoke(docker, {"DOCKER_CONTEXT": "mock-remote", "DOCKER_HOST": LOCAL_ENDPOINT})
        self.assertEqual(docker.daemon_calls, [], "a remote effective context reached daemon I/O")
        self.assertIsInstance(error, RuntimeError)
        self.assertIn("non-local", str(error))

    def test_context_metadata_resolves_host_only_or_selected_default_without_daemon_io(self) -> None:
        for environment in [{"DOCKER_HOST": REMOTE_ENDPOINT}, {"DOCKER_CONTEXT": "mock-remote"}, {}]:
            with self.subTest(environment=environment):
                docker = FakeDocker(REMOTE_ENDPOINT, forbid_daemon=True)
                error, _ = self.invoke(docker, environment)
                self.assertEqual(len(docker.calls), 1)
                self.assertEqual(docker.calls[0]["arguments"][:2], ["context", "inspect"])
                self.assertEqual(docker.calls[0]["env"], environment)
                self.assertIsInstance(error, RuntimeError)
                self.assertIn("non-local", str(error))

    def test_nonlocal_or_incomplete_unix_endpoints_are_rejected_before_daemon_io(self) -> None:
        for endpoint in ["unix://mock-remote.invalid/docker.sock", "unix://", "tcp://mock-remote.invalid:2375", REMOTE_ENDPOINT]:
            with self.subTest(endpoint=endpoint):
                docker = FakeDocker(endpoint, forbid_daemon=True)
                error, _ = self.invoke(docker, {})
                self.assertEqual(docker.daemon_calls, [], "only an absolute local Unix socket may reach daemon I/O")
                self.assertIsInstance(error, RuntimeError)
                self.assertIn("non-local", str(error))

    def test_every_daemon_call_pins_verified_endpoint_with_clean_environment(self) -> None:
        docker = FakeDocker(stop_at_launch=True)
        environment = {"DOCKER_CONTEXT": "mock-local", "DOCKER_HOST": REMOTE_ENDPOINT,
                       "DOCKER_TLS": "1", "DOCKER_TLS_VERIFY": "1", "DOCKER_CERT_PATH": "/mock-certs"}
        error, _ = self.invoke(docker, environment, concurrency=True)
        self.assertIsInstance(error, StopAfterLaunch)
        self.assertEqual(docker.popen_count, 2, "exercise holder and competing-worker Popen paths")
        self.assertTrue(any(call["arguments"][:2] == ["container", "inspect"] for call in docker.calls))
        for call in docker.daemon_calls:
            self.assertEqual(call["command"][:3], ["docker", "--host", LOCAL_ENDPOINT], call["command"])
            self.assertTrue(environment.keys().isdisjoint(call["env"]), call["command"])


class ContainerCleanupTests(HarnessTestCase):
    def test_failed_launch_still_removes_exact_disposable_container(self) -> None:
        docker = FakeDocker(fail_launch=True)
        error, _ = self.invoke(docker, {})
        self.assertIsInstance(error, subprocess.CalledProcessError)
        self.assertIsNone(docker.container, "docker run created a container before failing; cleanup must still run")
        assert docker.launched_name is not None
        self.assertRegex(docker.launched_name, r"^qr-logo-local-[0-9a-f]{12}$")
        removals = [call["arguments"] for call in docker.calls if call["arguments"][:1] == ["rm"]]
        self.assertEqual(removals, [["rm", "--force", docker.launched_name]])
        self.assertTrue((self.log_dir / "commands.json").exists())

    def test_successful_launch_followed_by_log_io_error_still_cleans_up(self) -> None:
        docker = FakeDocker()
        error, output = self.invoke(docker, {}, fail_launch_log=True)
        self.assertIsInstance(error, OSError)
        self.assertIn("log append failed", str(error))
        self.assertIsNone(docker.container)
        self.assertIn("container removed=True", output)
        assert docker.data_path is not None
        self.assertFalse(docker.data_path.exists())

    def test_success_keeps_isolation_and_verifies_exact_name_absence(self) -> None:
        docker = FakeDocker()
        error, output = self.invoke(docker, {"DOCKER_HOST": LOCAL_ENDPOINT})
        self.assertIsNone(error)
        launch = next(call["arguments"] for call in docker.calls if call["arguments"][:1] == ["run"])
        self.assertIn("--pull=never", launch)
        self.assertEqual(launch[launch.index("--network") + 1], "none")
        self.assertFalse({"-p", "-P", "--publish", "--publish-all"}.intersection(launch))
        self.assertIn("postgres:17", launch)
        assert docker.data_path is not None
        self.assertTrue(docker.data_path.is_relative_to(self.scratch))
        self.assertFalse(docker.data_path.exists())
        self.assertEqual(docker.calls[-1]["arguments"], ["container", "ls", "--all", "--filter",
                         f"name=^/{docker.launched_name}$", "--format", "{{.Names}}"])
        self.assertIsNone(docker.container)
        self.assertIn("container removed=True", output)

    def test_unavailable_daemon_is_not_confirmed_absence(self) -> None:
        docker = FakeDocker(cleanup_unavailable=True)
        error, output = self.invoke(docker, {})
        self.assertIsInstance(error, RuntimeError, "a failed inspection is not proof of absence")
        self.assertIn("verify", str(error))
        self.assertNotIn("container removed=True", output)
        self.assertIsNotNone(docker.container)
        assert docker.data_path is not None
        self.assertTrue(docker.data_path.is_dir(), "retain DB files until container absence is confirmed")
        self.assertTrue((self.log_dir / "commands.json").exists(), "preserve commands even when cleanup verification fails")

    def test_log_collection_failure_cannot_skip_scoped_cleanup(self) -> None:
        docker = FakeDocker(fail_logs=True)
        error, output = self.invoke(docker, {})
        self.assertIsInstance(error, OSError)
        self.assertIsNone(docker.container, "log collection must not prevent container removal")
        removals = [call["arguments"] for call in docker.calls if call["arguments"][:1] == ["rm"]]
        self.assertEqual(removals, [["rm", "--force", docker.launched_name]])
        self.assertIn("container removed=True", output)
        assert docker.data_path is not None
        self.assertFalse(docker.data_path.exists())
        self.assertTrue((self.log_dir / "commands.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
