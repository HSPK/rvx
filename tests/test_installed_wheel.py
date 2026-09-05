"""Run with an isolated wheel-installed interpreter, from any writable working directory."""

from __future__ import annotations

from importlib.metadata import distribution, version
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import urllib.request

import rvx
from rvx import RvxError, RvxService, RvxSettings, Source
from rvx.cli import api_request


INSTALLED = Path(rvx.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
SCRIPTS = Path(sys.executable).absolute().parent


@unittest.skipUnless(INSTALLED and os.name == "posix", "requires a noneditable installed RVX wheel")
class InstalledWheelTests(unittest.TestCase):
    def test_metadata_native_namespace_and_entrypoints(self):
        from rvx._native import RvxEngine, RvxSource
        self.assertEqual(RvxEngine.__module__, "rvx._native")
        self.assertEqual(RvxSource.__module__, "rvx._native")
        self.assertTrue(all(callable(value) for value in (Source, RvxService, RvxSettings, RvxError)))
        metadata = distribution("rvx")
        self.assertEqual(metadata.metadata["Author"], "hspk")
        self.assertEqual(metadata.metadata["License-Expression"], "MIT")
        files = {str(path) for path in metadata.files}
        self.assertIn("rvx/_bin/rvxd", files)
        self.assertIn("rvx/_web/index.html", files)
        self.assertFalse(any(path.startswith("src/") for path in files))
        self.assertTrue(any(path.endswith("/licenses/LICENSE") for path in files))
        self.assertTrue(any(path.endswith("/licenses/THIRD_PARTY_NOTICES.md") for path in files))
        self.assertFalse(any("native" in requirement.lower() for requirement in metadata.requires or []))
        for command, name in (
            ([str(SCRIPTS / "rvx")], "rvx"),
            ([str(SCRIPTS / "rvxd")], "rvxd"),
            ([sys.executable, "-I", "-m", "rvx"], "rvx"),
            ([str(Path(rvx.__file__).parent / "_bin" / "rvxd")], "rvxd"),
        ):
            result = subprocess.run(
                [*command, "--version"], capture_output=True, text=True, check=True,
                env={**os.environ, "PATH": str(SCRIPTS)},
            )
            self.assertEqual(result.stdout.strip(), f"{name} {version('rvx')}")

    def start_daemon(self, command, directory):
        process = subprocess.Popen(
            [*command, "--data-dir", str(directory / "data"), "--listen", "127.0.0.1:0",
             "--hot-capacity", "32", "--scrape-concurrency", "2"],
            cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env={**os.environ, "PATH": str(SCRIPTS), "PYTHONPATH": ""},
        )
        self.addCleanup(self.cleanup_process, process)
        self.assertTrue(select.select([process.stdout], [], [], 30)[0], "daemon readiness timed out")
        line = process.stdout.readline().strip()
        if not line.startswith("rvxd listening on http://"):
            stdout, stderr = process.communicate(timeout=10)
            self.fail(f"invalid readiness: {line}\n{stdout}\n{stderr}")
        if sys.platform == "linux":
            self.assertEqual(Path(f"/proc/{process.pid}/exe").resolve().name, "rvxd")
        return process, line.removeprefix("rvxd listening on ")

    def cleanup_process(self, process):
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)

    def stop_daemon(self, process, stop_signal, base):
        process.send_signal(stop_signal)
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stdout + stderr)
        with self.assertRaises(OSError):
            urllib.request.urlopen(base + "/healthz", timeout=1)

    def test_bundled_ui_source_pull_and_signal_cleanup_without_build_tools(self):
        with tempfile.TemporaryDirectory(prefix="rvx-wheel-", dir=Path.cwd()) as directory:
            fixture = Path(directory)
            commands = (
                ([str(SCRIPTS / "rvx"), "serve"], signal.SIGTERM),
                ([str(SCRIPTS / "rvxd")], signal.SIGINT),
                ([sys.executable, "-I", "-m", "rvx", "serve"], signal.SIGTERM),
            )
            for index, (command, stop_signal) in enumerate(commands):
                with self.subTest(command=command, stop_signal=stop_signal):
                    process, base = self.start_daemon(command, fixture)
                    with urllib.request.urlopen(base + "/rvx/projects", timeout=5) as response:
                        html = response.read().decode()
                    self.assertIn("RVX", html)
                    assets = re.findall(r'(?:src|href)="(/assets/[^"]+)"', html)
                    self.assertTrue(assets)
                    for asset in assets:
                        with urllib.request.urlopen(base + asset, timeout=5) as response:
                            self.assertTrue(response.read())
                    self.assertEqual(api_request(base, "/api/experiments/stats")["projects"], index)
                    project = api_request(base, "/api/experiments/projects", method="POST", payload={
                        "name": f"wheel-{index}",
                    })
                    experiment = api_request(base, "/api/experiments/experiments", method="POST", payload={
                        "project_id": project["id"], "name": "installed",
                    })
                    run = api_request(base, "/api/experiments/runs", method="POST", payload={
                        "experiment_id": experiment["id"], "name": "run", "config": {},
                    })
                    with Source(
                        project=project["name"], experiment="installed", run_id=run["id"], role="learner",
                    ) as source:
                        with self.assertRaises(RuntimeError):
                            _ = source.endpoint
                        source.capture({"loss": 0.8, "exact": 2**64 - 1}, observed_at_ns=10)
                        source.capture({"loss": None, "exact": 2**64 - 1}, observed_at_ns=20)
                        source.seal()
                        source.serve()
                        registered = api_request(base, "/api/experiments/sources", method="POST", payload={
                            "run_id": run["id"], "attempt_id": "attempt-1", "role": "learner",
                            "endpoint": source.endpoint, "scrape_interval_ms": 50, "timeout_ms": 400,
                        })
                        deadline = time.monotonic() + 10
                        while time.monotonic() < deadline:
                            history = api_request(base, "/api/snapshots/history", method="POST", payload={
                                "run_id": run["id"],
                            })["snapshots"]
                            if len(history) == 2:
                                break
                            time.sleep(0.02)
                        self.assertEqual(len(history), 2)
                        self.assertEqual(history[0]["state"], {"loss": None, "exact": 2**64 - 1})
                        self.assertEqual(history[1]["source_session_id"], source.source_session_id)
                        self.assertEqual(history[1]["source_id"], registered["id"])
                        query = api_request(base, "/api/snapshots/query", method="POST", payload={
                            "run_ids": [run["id"]], "paths": ["/loss"],
                        })
                        self.assertEqual(query["series"][0]["values"], [0.8, None])
                        self.stop_daemon(process, stop_signal, base)

    def test_installed_daemon_pulls_a_separate_http_fixture(self):
        with tempfile.TemporaryDirectory(prefix="rvx-pull-", dir=Path.cwd()) as directory:
            process, base = self.start_daemon([str(SCRIPTS / "rvx"), "serve"], Path(directory))
            project = api_request(base, "/api/experiments/projects", method="POST", payload={"name": "http"})
            experiment = api_request(base, "/api/experiments/experiments", method="POST", payload={
                "project_id": project["id"], "name": "fixture",
            })
            run = api_request(base, "/api/experiments/runs", method="POST", payload={
                "experiment_id": experiment["id"], "name": "run", "config": {},
            })
            cursors = []

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    url = urlsplit(self.path)
                    if url.path == "/worker/v1/snapshots/descriptor":
                        payload = {
                            "protocol_version": 1, "project": "http", "experiment": "fixture",
                            "run_id": run["id"], "attempt_id": "attempt-1", "role": "worker",
                            "source_session_id": "wheel-fixture", "schema_version": 1,
                        }
                    elif url.path == "/worker/v1/snapshots/history":
                        after = int(parse_qs(url.query)["after"][0])
                        cursors.append(after)
                        payload = {
                            "protocol_version": 1, "source_session_id": "wheel-fixture",
                            "oldest_sequence": 0, "next_sequence": 1, "dropped_before": None,
                            "snapshots": [] if after else [{
                                "source_session_id": "wheel-fixture", "sequence": 0,
                                "observed_at_ns": 123, "schema_version": 1, "axes": {"step": 7},
                                "state": {"external": True},
                            }],
                        }
                    else:
                        self.send_error(404)
                        return
                    body = json.dumps(payload).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, _format, *args):
                    pass

            with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                try:
                    api_request(base, "/api/experiments/sources", method="POST", payload={
                        "run_id": run["id"], "attempt_id": "attempt-1", "role": "worker",
                        "endpoint": f"http://127.0.0.1:{server.server_port}/worker",
                        "scrape_interval_ms": 50, "timeout_ms": 400,
                    })
                    deadline = time.monotonic() + 10
                    while 1 not in cursors and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertIn(1, cursors)
                    latest = api_request(base, "/api/snapshots/latest", method="POST", payload={
                        "run_id": run["id"],
                    })["snapshots"]
                    self.assertEqual(latest[0]["state"], {"external": True})
                    self.stop_daemon(process, signal.SIGINT, base)
                finally:
                    server.shutdown()
                    thread.join(timeout=5)
                    self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    if not INSTALLED:
        raise SystemExit("Run this test with a noneditable wheel-installed Python, not the source checkout.")
    unittest.main()
