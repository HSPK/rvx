from __future__ import annotations

import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get("RVX_BINARY", ROOT / "target/debug/rvx"))


@contextmanager
def api_fixture(respond):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            status, body, declared_length = respond(request)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if declared_length is not None:
                self.send_header("Content-Length", str(declared_length))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            thread.join(5)


def response(value, status=200):
    body = json.dumps(value).encode()
    return status, body, len(body)


def snapshot(identity, timestamp):
    return {
        "id": identity,
        "source_id": "learner",
        "state": {
            "tracker": {"step": identity},
            "spans": [{
                "name": f"span-{identity}", "start_ns": timestamp,
                "duration_ms": 1.5, "attributes": {"exact": 2**64 - 1, "label": "训练"},
                "error": "FixtureError",
            }],
        },
    }


@unittest.skipUnless(CLI.is_file(), "build rvx or set RVX_BINARY")
class NativeTraceTests(unittest.TestCase):
    def setUp(self):
        (ROOT / ".build").mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=ROOT / ".build")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.scratch = self.root / "scratch"
        self.scratch.mkdir()
        self.output = self.root / "trace.json"

    def trace(self, url, *extra, prefix=(), timeout=15):
        return subprocess.run(
            [*prefix, str(CLI), "--url", url, "trace", "--run", "run",
             "--output", str(self.output), "--temp-dir", str(self.scratch), *extra],
            capture_output=True, text=True, timeout=timeout,
            env={**os.environ, "TOKIO_WORKER_THREADS": "2"},
        )

    def test_pages_are_globally_sorted_with_stable_ties_and_unchanged_fields(self):
        requests = []
        self.output.write_text("previous output")

        def respond(request):
            requests.append(request)
            if request["before_id"] is None:
                return response({"snapshots": [snapshot(4, 3000), snapshot(3, 1000)], "next_before_id": 3})
            return response({"snapshots": [snapshot(2, 2000), snapshot(1, 1000)], "next_before_id": None})

        with api_fixture(respond) as url:
            result = self.trace(url, "--source", "learner", "--from", "10", "--to", "20")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["spans_exported"], 4)
        trace = json.loads(self.output.read_text())
        self.assertEqual(set(trace), {"traceEvents", "displayTimeUnit"})
        self.assertEqual([event["name"] for event in trace["traceEvents"]],
                         ["span-3", "span-1", "span-2", "span-4"])
        for event in trace["traceEvents"]:
            self.assertEqual(event["cat"], "rvx.tracker")
            self.assertEqual(event["ph"], "X")
            self.assertEqual(event["dur"], 1500)
            self.assertEqual(event["args"]["exact"], 2**64 - 1)
            self.assertEqual(event["args"]["label"], "训练")
            self.assertEqual(event["args"]["error"], "FixtureError")
        self.assertEqual([request["before_id"] for request in requests], [None, 3])
        self.assertTrue(all(request["source_ids"] == ["learner"] and
                            request["from"] == 10 and request["to"] == 20 for request in requests))
        self.assertEqual(list(self.scratch.iterdir()), [])
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["scratch", "trace.json"])

    def test_mid_export_errors_preserve_destination_and_remove_temporary_files(self):
        for failure in ("http", "cursor", "oversize", "malformed"):
            with self.subTest(failure=failure):
                self.output.write_bytes(b"previous output")
                calls = 0

                def respond(request):
                    nonlocal calls
                    calls += 1
                    if calls == 1:
                        return response({"snapshots": [snapshot(3, 3000)], "next_before_id": 3})
                    if failure == "http":
                        return response({"error": "失败" * 300}, 500)
                    if failure == "cursor":
                        return response({"snapshots": [snapshot(2, 2000)], "next_before_id": 3})
                    if failure == "oversize":
                        return 200, b"", 16 * 1024 * 1024 + 1
                    return response({"snapshots": "not an array", "next_before_id": None})

                with api_fixture(respond) as url:
                    result = self.trace(url)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ERROR:", result.stderr)
                self.assertEqual(self.output.read_bytes(), b"previous output")
                self.assertEqual(list(self.scratch.iterdir()), [])
                self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["scratch", "trace.json"])

    def test_output_replacement_failure_removes_the_temporary_output(self):
        self.output.mkdir()
        marker = self.output / "keep"
        marker.write_text("preserve")
        with api_fixture(lambda _: response({"snapshots": [], "next_before_id": None})) as url:
            result = self.trace(url)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(marker.read_text(), "preserve")
        self.assertEqual(list(self.scratch.iterdir()), [])
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["scratch", "trace.json"])

    def test_page_budget_is_enforced_without_content_length(self):
        with api_fixture(lambda _: (200, b" " * (16 * 1024 * 1024 + 1), None)) as url:
            result = self.trace(url)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exceeds", result.stderr)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.scratch.iterdir()), [])

    @unittest.skipUnless(sys.platform == "linux", "uses Linux address-space limits")
    def test_export_larger_than_process_memory_limit(self):
        total = 70_000
        detail = "x" * 4096

        def respond(request):
            upper = total + 1 if request["before_id"] is None else request["before_id"]
            lower = max(1, upper - 100)
            rows = [
                {"id": i, "source_id": "s", "state": {"spans": [{
                    "name": "work", "start_ns": i * 1000, "duration_ms": 1,
                    "attributes": {"detail": detail},
                }]}}
                for i in range(upper - 1, lower - 1, -1)
            ]
            return response({"snapshots": rows, "next_before_id": lower if lower > 1 else None})

        limit = 256 * 1024 * 1024
        wrapper = (
            sys.executable, "-c",
            "import os,resource,sys; "
            f"resource.setrlimit(resource.RLIMIT_AS, ({limit}, {limit})); "
            "os.execv(sys.argv[1], sys.argv[1:])",
        )
        with api_fixture(respond) as url:
            result = self.trace(url, prefix=wrapper, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["spans_exported"], total)
        self.assertGreater(self.output.stat().st_size, limit)
        self.assertEqual(list(self.scratch.iterdir()), [])


@unittest.skipUnless(CLI.is_file() and os.name == "posix", "requires native CLI and a PTY")
class NativeTuiTests(unittest.TestCase):
    def test_quit_restores_terminal_and_closes_a_stalled_http_request(self):
        import fcntl
        import pty
        import socket
        import struct
        import termios

        (ROOT / ".build").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".build") as directory:
            config = Path(directory) / "rvx.toml"
            config.write_text(
                'version=1\n[dashboard]\nproject="p"\nexperiment="e"\n'
                '[[dashboard.panels]]\ntype="run-metadata"\n'
            )
            listener = socket.socket()
            self.addCleanup(listener.close)
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            listener.settimeout(5)
            master, slave = pty.openpty()
            self.addCleanup(os.close, master)
            self.addCleanup(os.close, slave)
            original = termios.tcgetattr(slave)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
            process = subprocess.Popen(
                [str(CLI), "--url", f"http://127.0.0.1:{listener.getsockname()[1]}",
                 "tui", "--config", str(config)],
                stdin=slave, stdout=slave, stderr=subprocess.PIPE,
                env={**os.environ, "TERM": "xterm-256color", "TOKIO_WORKER_THREADS": "2"},
            )
            connection = None
            try:
                connection, _ = listener.accept()
                connection.settimeout(2)
                headers = b""
                while b"\r\n\r\n" not in headers:
                    headers += connection.recv(4096)
                screen = bytearray()
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline and b"Connecting" not in screen:
                    if select.select([master], [], [], 0.05)[0]:
                        screen.extend(os.read(master, 65536))
                self.assertIn(b"Connecting", screen)
                os.write(master, b"rrrj")
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 18, 80, 0, 0))
                started = time.monotonic()
                os.write(master, b"q")
                _, error = process.communicate(timeout=2)
                self.assertEqual(process.returncode, 0, error)
                self.assertLess(time.monotonic() - started, 2)
                self.assertEqual(termios.tcgetattr(slave), original)
                self.assertEqual(connection.recv(1), b"", "quitting must cancel the HTTP request")
            finally:
                if connection is not None:
                    connection.close()
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)
