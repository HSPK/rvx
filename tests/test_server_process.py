from __future__ import annotations

import json
import os
import select
import signal
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from rvx import SnapshotEvent, Source, tracker as rvx_tracker
from tests.http_api import api_request


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("RVXD_BINARY", ROOT / "target/debug/rvxd"))
CLI = Path(os.environ.get("RVX_BINARY", ROOT / "target/debug/rvx"))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Keep redirect responses available for same-origin assertions."""

    def redirect_request(self, request, response, code, message, headers, new_url):
        """Leave redirect responses available for exact Location assertions."""
        return None


@unittest.skipUnless(
    os.name == "posix" and BINARY.is_file() and CLI.is_file(),
    "build rvx/rvxd or set RVX_BINARY/RVXD_BINARY",
)
class RvxProcessTests(unittest.TestCase):
    """Run the actual daemon against only isolated project-local fixtures."""

    def stop_daemon(self, process, stop_signal):
        """Keep the shutdown deadline strict and preserve child diagnostics on failure."""
        process.send_signal(stop_signal)
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=10)
            self.fail(f"daemon shutdown exceeded 10s\nstdout:\n{stdout}\nstderr:\n{stderr}")
        self.assertEqual(process.returncode, 0, stdout + stderr)

    def cli(self, base, *arguments):
        result = subprocess.run(
            [str(CLI), "--url", base, *arguments],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_cpu_local_two_runs_four_asynchronous_roles(self):
        """Simulate SDK/native HTTP plumbing, not actual RL or multi-node training."""
        build = ROOT / ".build"
        build.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=build) as directory, ExitStack() as owners:
            fixture = Path(directory)
            process = subprocess.Popen(
                [str(BINARY), "--data-dir", str(fixture / "data"), "--listen", "127.0.0.1:0"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                self.assertTrue(select.select([process.stdout], [], [], 10)[0], "daemon did not become ready")
                line = process.stdout.readline().strip()
                self.assertTrue(line.startswith("rvxd listening on http://"), line)
                base = line.removeprefix("rvxd listening on ")
                project = api_request(
                    base, "/api/experiments/projects", method="POST", payload={"name": "cpu-local-simulation"},
                )
                experiment = api_request(
                    base, "/api/experiments/experiments", method="POST",
                    payload={"project_id": project["id"], "name": "snapshot-plumbing"},
                )
                runs = [
                    api_request(
                        base, "/api/experiments/runs", method="POST",
                        payload={"experiment_id": experiment["id"], "name": variant, "config": {"simulation": True}},
                    )
                    for variant in ("baseline", "candidate")
                ]
                roles = [
                    ("actor", "env_step", 10),
                    ("learner", "optimizer_step", 2),
                    ("inference", "request_count", 3),
                    ("evaluator", "episode", 5),
                ]
                publishers = []
                sources = {}
                for run_index, run in enumerate(runs):
                    for role_index, (role, axis, scale) in enumerate(roles):
                        producer = owners.enter_context(Source(
                            project="cpu-local-simulation", experiment="snapshot-plumbing",
                            run_id=run["id"], role=role, capacity=16,
                            labels={"scope": "cpu-local-plumbing"},
                        )).serve()
                        source = api_request(
                            base, "/api/experiments/sources", method="POST",
                            payload={
                                "run_id": run["id"], "attempt_id": "attempt-1", "role": role,
                                "endpoint": producer.endpoint, "scrape_interval_ms": 50, "timeout_ms": 400,
                            },
                        )
                        sources[(run_index, role)] = source["id"]
                        publishers.append((run_index, role_index, role, axis, scale, producer))

                def publish(item):
                    run_index, role_index, role, axis, scale, producer = item
                    variant = ("baseline", "candidate")[run_index]
                    observations = [
                        {
                            "role": role, "run_variant": variant, "phase": "working",
                            "progress": {"value": run_index + role_index + 0.5, "transient": "warmup"},
                            "runtime": {"queue": {"ready": 4, "inflight": ["batch-a"]}},
                            "workers": [{"id": f"{role}-0", "status": "busy"}],
                        },
                        {
                            "role": role, "run_variant": variant, "phase": "draining",
                            "progress": {"value": None},
                            "runtime": {"queue": {"ready": 1, "inflight": []}},
                            "workers": [{"id": f"{role}-0", "status": "idle"}],
                        },
                        {
                            "role": role, "run_variant": variant, "phase": "complete",
                            "progress": {"completed": True},
                            "runtime": {"queue": {"ready": 0}},
                            "workers": [],
                        },
                    ]
                    for sequence, state in enumerate(observations):
                        time.sleep((role_index + run_index + 1) * 0.005)
                        receipt = producer.capture(
                            state, observed_at_ns=10_000 + run_index * 1000 + role_index * 100 + sequence,
                            axes={axis: sequence * scale},
                        )
                        self.assertEqual(receipt.sequence, sequence)
                    producer.seal()

                with ThreadPoolExecutor(max_workers=8) as workers:
                    list(workers.map(publish, publishers))
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    stats = api_request(base, "/api/experiments/stats")
                    if stats["snapshots"] == 24 and stats["active_sources"] == 8:
                        break
                    time.sleep(0.02)
                self.assertEqual(stats["snapshots"], 24)
                self.assertEqual(stats["active_sources"], 8)
                self.assertEqual(set(stats), {
                    "projects", "experiments", "runs", "sources", "active_sources",
                    "snapshots", "cursor_gaps", "scrape_failures",
                })
                self.assertEqual(stats["cursor_gaps"], 0)
                self.assertEqual(stats["scrape_failures"], 0)

                for run in runs:
                    latest = api_request(
                        base, "/api/snapshots/latest", method="POST", payload={"run_id": run["id"]},
                    )["snapshots"]
                    self.assertEqual({row["state"]["role"] for row in latest}, {role[0] for role in roles})
                    for row in latest:
                        self.assertEqual(row["sequence"], 2)
                        self.assertEqual(row["run_id"], run["id"])
                        self.assertEqual(row["state"]["run_variant"], run["name"])
                        self.assertEqual(row["state"]["workers"], [])
                        self.assertNotIn("value", row["state"]["progress"])
                        self.assertNotIn("inflight", row["state"]["runtime"]["queue"])
                trend = api_request(
                    base, "/api/snapshots/query", method="POST",
                    payload={"run_ids": [run["id"] for run in runs], "paths": ["/progress/value"]},
                )
                self.assertEqual(trend["axis"], "wall_time")
                self.assertEqual(len(trend["series"]), 8)
                expected_by_source = {
                    sources[(run_index, role)]: (
                        runs[run_index]["id"], run_index + role_index + 0.5, producer.source_session_id,
                    )
                    for run_index, role_index, role, _, _, producer in publishers
                }
                for series in trend["series"]:
                    run_id, first_value, session_id = expected_by_source[series["source_id"]]
                    self.assertEqual(series["run_id"], run_id)
                    self.assertEqual(series["sequences"], [0, 1, 2])
                    self.assertEqual(series["axes"], series["observed_at_ns"])
                    self.assertEqual(series["values"], [first_value, None, None])
                    self.assertEqual(series["source_session_ids"], [session_id] * 3)
                self.assertEqual(len({series["source_session_ids"][0] for series in trend["series"]}), 8)
                learner_trend = api_request(
                    base, "/api/snapshots/query", method="POST",
                    payload={
                        "run_ids": [run["id"] for run in runs],
                        "paths": ["/progress/value"], "axis": "optimizer_step",
                    },
                )
                self.assertEqual(len(learner_trend["series"]), 2)
                self.assertTrue(all(series["axes"] == [0, 2, 4] for series in learner_trend["series"]))

                baseline = api_request(
                    base, "/api/snapshots/history", method="POST",
                    payload={"run_id": runs[0]["id"], "source_ids": [sources[(0, "learner")]]},
                )["snapshots"]
                self.assertEqual([row["sequence"] for row in baseline], [2, 1, 0])
                null_diff = api_request(
                    base, "/api/snapshots/diff", method="POST",
                    payload={"before_id": baseline[2]["id"], "after_id": baseline[1]["id"]},
                )
                self.assertIn(
                    {"path": "/progress/value", "kind": "changed", "before": 1.5, "after": None},
                    null_diff["changes"],
                )
                removed_diff = api_request(
                    base, "/api/snapshots/diff", method="POST",
                    payload={"before_id": baseline[1]["id"], "after_id": baseline[0]["id"]},
                )
                self.assertIn(
                    {"path": "/progress/value", "kind": "removed", "before": None},
                    removed_diff["changes"],
                )
                candidate = api_request(
                    base, "/api/snapshots/latest", method="POST",
                    payload={"run_id": runs[1]["id"], "source_ids": [sources[(1, "learner")]]},
                )["snapshots"][0]
                cross_run = api_request(
                    base, "/api/snapshots/diff", method="POST",
                    payload={"before_id": baseline[2]["id"], "after_id": candidate["id"]},
                )
                self.assertFalse(cross_run["truncated"])
                self.assertIn(
                    {"path": "/run_variant", "kind": "changed", "before": "baseline", "after": "candidate"},
                    cross_run["changes"],
                )
                self.assertIn(
                    {"path": "/runtime/queue/inflight", "kind": "removed", "before": ["batch-a"]},
                    cross_run["changes"],
                )
                self.stop_daemon(process, signal.SIGTERM)
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)

    def test_shared_config_bootstraps_run_sources_and_scraping(self):
        """Start the daemon from TOML without separate hierarchy or Source registration calls."""
        build = ROOT / ".build"
        build.mkdir(exist_ok=True)
        descriptor = {
            "protocol_version": 1,
            "source_session_id": "configured-session",
            "project": "async-rl",
            "experiment": "grpo",
            "run_id": "configured-run",
            "attempt_id": "attempt-1",
            "role": "learner",
            "rank": None,
            "node_id": "fixture",
            "pid": None,
            "labels": {},
            "schema_version": 1,
        }
        snapshot = {
            "source_session_id": "configured-session",
            "sequence": 0,
            "observed_at_ns": 5_000_000_000,
            "schema_version": 1,
            "axes": {"optimizer_step": 4},
            "state": {"phase": "training", "progress": {"loss": 0.25, "step": 4}},
        }

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                parsed = urllib.parse.urlsplit(self.path)
                if parsed.path == "/v1/snapshots/descriptor":
                    payload = descriptor
                elif parsed.path == "/v1/snapshots/history":
                    after = int(urllib.parse.parse_qs(parsed.query).get("after", ["0"])[0])
                    payload = {
                        "protocol_version": 1,
                        "source_session_id": "configured-session",
                        "oldest_sequence": 0,
                        "next_sequence": 1,
                        "snapshots": [snapshot] if after == 0 else [],
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

        with tempfile.TemporaryDirectory(dir=build) as directory, ThreadingHTTPServer(
            ("127.0.0.1", 0), Handler
        ) as source_server:
            fixture = Path(directory)
            ui = fixture / "ui"
            ui.mkdir()
            (ui / "index.html").write_text("<!doctype html><title>fixture</title>")
            source_thread = threading.Thread(target=source_server.serve_forever)
            source_thread.start()
            config = fixture / "rvx.toml"
            config.write_text(
                f"""
version = 1
[daemon]
data_dir = "data"
listen = "127.0.0.1:0"
[[runs]]
id = "configured-run"
project = "async-rl"
experiment = "grpo"
name = "trial-1"
config = {{ batch_size = 32 }}
[[runs.sources]]
endpoint = "http://127.0.0.1:{source_server.server_port}"
role = "learner"
scrape_interval_ms = 50
timeout_ms = 400
[dashboard]
project = "async-rl"
experiment = "grpo"
[[dashboard.panels]]
type = "metrics"
paths = ["/progress/loss"]
axis = "optimizer_step"
"""
            )
            process = subprocess.Popen(
                [str(BINARY), "--config", str(config), "--ui-dir", str(ui)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertTrue(
                    select.select([process.stdout], [], [], 10)[0],
                    "configured daemon did not become ready",
                )
                line = process.stdout.readline().strip()
                self.assertTrue(line.startswith("rvxd listening on http://"), line)
                base = line.removeprefix("rvxd listening on ")
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if api_request(base, "/api/experiments/stats")["snapshots"] == 1:
                        break
                    time.sleep(0.02)
                projects = api_request(base, "/api/experiments/projects")["projects"]
                self.assertEqual([project["name"] for project in projects], ["async-rl"])
                experiments = api_request(base, "/api/experiments/experiments")["experiments"]
                self.assertEqual([experiment["name"] for experiment in experiments], ["grpo"])
                runs = api_request(base, "/api/experiments/runs")["runs"]
                self.assertEqual(runs[0]["id"], "configured-run")
                self.assertEqual(runs[0]["status"], "running")
                self.assertEqual(json.loads(runs[0]["config_json"]), {"batch_size": 32})
                sources = api_request(
                    base,
                    "/api/experiments/sources?run_id=configured-run",
                )["sources"]
                self.assertEqual(len(sources), 1)
                self.assertEqual(sources[0]["role"], "learner")
                latest = api_request(
                    base,
                    "/api/snapshots/latest",
                    method="POST",
                    payload={"run_id": "configured-run"},
                )["snapshots"]
                self.assertEqual(latest[0]["state"]["progress"]["step"], 4)
                dashboard = subprocess.run(
                    [
                        str(CLI),
                        "--url",
                        base,
                        "tui",
                        "--config",
                        str(config),
                        "--once",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                self.assertEqual(dashboard.returncode, 0, dashboard.stdout + dashboard.stderr)
                self.assertIn("configured-run", dashboard.stdout)
                self.assertIn("/progress/loss [learner]", dashboard.stdout)
                self.assertIn("0.25", dashboard.stdout)
                self.stop_daemon(process, signal.SIGTERM)
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)
                source_server.shutdown()
                source_thread.join(timeout=5)
                self.assertFalse(source_thread.is_alive())

    def test_native_tracker_flows_through_the_standard_snapshot_pipeline(self):
        build = ROOT / ".build"
        build.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=build) as directory:
            fixture = Path(directory)
            ui = fixture / "ui"
            ui.mkdir()
            (ui / "index.html").write_text("<!doctype html><title>fixture</title>")
            process = subprocess.Popen(
                [
                    str(BINARY),
                    "--data-dir",
                    str(fixture / "data"),
                    "--listen",
                    "127.0.0.1:0",
                    "--ui-dir",
                    str(ui),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            tracker = None
            try:
                self.assertTrue(select.select([process.stdout], [], [], 10)[0])
                base = process.stdout.readline().strip().removeprefix(
                    "rvxd listening on "
                )
                project = self.cli(base, "projects", "create", "tracker")
                experiment = self.cli(
                    base,
                    "experiments",
                    "create",
                    "--project",
                    project["id"],
                    "native",
                )
                run = self.cli(
                    base,
                    "runs",
                    "create",
                    "--experiment",
                    experiment["id"],
                    "trial",
                )
                tracker = rvx_tracker.Run(
                    project="tracker",
                    experiment="native",
                    name="trial",
                    run_id=run["id"],
                    alert_rules=["loss > 2 => error: high loss"],
                    span_count=True,
                    serve=True,
                )
                self.cli(
                    base,
                    "sources",
                    "register",
                    "--run",
                    run["id"],
                    "--role",
                    "tracker",
                    "--endpoint",
                    tracker.endpoint,
                    "--interval-ms",
                    "50",
                    "--timeout-ms",
                    "400",
                )
                artifact = fixture / "checkpoint.bin"
                artifact.write_bytes(b"weights")
                tracker.log_artifact(artifact, name="model", type="checkpoint")
                tracker.log({}, step=3)
                with rvx_tracker.Span(tracker, "forward", {"batch": 2}):
                    pass
                tracker.log({"loss": 3.0}, step=3, commit=True)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if api_request(base, "/api/experiments/stats")["snapshots"] >= 2:
                        break
                    time.sleep(0.02)
                history = api_request(
                    base,
                    "/api/snapshots/history",
                    method="POST",
                    payload={"run_id": run["id"]},
                )["snapshots"]
                self.assertTrue(any(row["state"]["artifacts"] for row in history))
                latest = history[0]["state"]
                self.assertEqual(latest["metrics"]["loss"], 3.0)
                self.assertEqual(latest["alerts"][0]["message"], "high loss")
                self.assertEqual(latest["spans"][0]["name"], "forward")
                query = self.cli(
                    base,
                    "query",
                    "--run",
                    run["id"],
                    "--field",
                    "/metrics/loss",
                    "--axis",
                    "step",
                )
                self.assertEqual(
                    [value for value in query["series"][0]["values"] if value is not None],
                    [3.0],
                )
                trace_path = fixture / "trace.json"
                exported = self.cli(
                    base,
                    "trace",
                    "--run",
                    run["id"],
                    "--output",
                    str(trace_path),
                )
                self.assertEqual(exported["spans_exported"], 1)
                trace = json.loads(trace_path.read_text())
                self.assertEqual(trace["traceEvents"][0]["name"], "forward")
                self.stop_daemon(process, signal.SIGTERM)
            finally:
                if tracker is not None:
                    tracker.close()
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)

    def test_cli_management_static_routes_and_clean_restart(self):
        """Persist native control data through graceful SIGTERM/SIGINT shutdown."""
        build = ROOT / ".build"
        build.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=build) as directory:
            fixture = Path(directory)
            ui = fixture / "ui"
            ui.mkdir()
            (ui / "index.html").write_text("<!doctype html><title>fixture</title>")
            command = [
                str(BINARY),
                "--data-dir", str(fixture / "data"),
                "--listen", "127.0.0.1:0",
                "--ui-dir", str(ui),
            ]
            project = None
            run = None
            for index, stop_signal in enumerate((signal.SIGTERM, signal.SIGINT)):
                process = subprocess.Popen(
                    command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
                )
                try:
                    self.assertTrue(select.select([process.stdout], [], [], 10)[0], "daemon did not become ready")
                    line = process.stdout.readline().strip()
                    self.assertTrue(line.startswith("rvxd listening on http://"), line)
                    base = line.removeprefix("rvxd listening on ")
                    with urllib.request.urlopen(f"{base}/healthz", timeout=5) as response:
                        self.assertEqual(response.read(), b"ok\n")
                    self.assertEqual(api_request(base, "/api/experiments/stats")["projects"], index)
                    if index == 0:
                        project = self.cli(base, "projects", "create", "persisted")
                        experiment = self.cli(
                            base,
                            "experiments",
                            "create",
                            "--project",
                            project["id"],
                            "snapshots",
                        )
                        run = self.cli(
                            base,
                            "runs",
                            "create",
                            "--experiment",
                            experiment["id"],
                            "run",
                        )
                        with Source(
                            project="persisted", experiment="snapshots", run_id=run["id"], role="worker",
                        ) as producer:
                            producer.serve()
                            producer.capture_batch([
                                SnapshotEvent({"progress": {"loss": 0.8}, "removed": True}, 10),
                                SnapshotEvent({"progress": {"loss": 0.4}, "nullable": None}, 20),
                            ])
                            producer.seal()
                            self.cli(
                                base,
                                "sources",
                                "register",
                                "--run",
                                run["id"],
                                "--role",
                                "worker",
                                "--endpoint",
                                producer.endpoint,
                                "--interval-ms",
                                "50",
                                "--timeout-ms",
                                "400",
                            )
                            deadline = time.monotonic() + 10
                            while time.monotonic() < deadline:
                                if api_request(base, "/api/experiments/stats")["snapshots"] == 2:
                                    break
                                time.sleep(0.02)
                            self.assertEqual(api_request(base, "/api/experiments/stats")["snapshots"], 2)
                    latest = self.cli(base, "snapshots", "latest", "--run", run["id"])
                    self.assertEqual(latest["snapshots"][0]["state"],
                                     {"progress": {"loss": 0.4}, "nullable": None})
                    history = self.cli(base, "snapshots", "history", "--run", run["id"])
                    self.assertEqual([row["sequence"] for row in history["snapshots"]], [1, 0])
                    after, before = history["snapshots"]
                    diff = self.cli(
                        base,
                        "snapshots",
                        "diff",
                        "--before-id",
                        str(before["id"]),
                        "--after-id",
                        str(after["id"]),
                    )
                    self.assertIn({"path": "/removed", "kind": "removed", "before": True}, diff["changes"])
                    trend = self.cli(
                        base,
                        "query",
                        "--run",
                        run["id"],
                        "--field",
                        "/progress/loss",
                    )
                    self.assertEqual(trend["axis"], "wall_time")
                    self.assertEqual(trend["series"][0]["values"], [0.8, 0.4])
                    self.assertEqual(api_request(base, "/api/experiments/projects"), {"projects": [project]})
                    with urllib.request.urlopen(f"{base}/rvx/projects", timeout=5) as response:
                        self.assertIn(b"<title>fixture</title>", response.read())
                    navigation = urllib.request.build_opener(NoRedirect)
                    for path in ("/hostmon", "/api/hostmon", "/ryx"):
                        with self.assertRaises(urllib.error.HTTPError) as redirect:
                            navigation.open(f"{base}{path}", timeout=5)
                        with redirect.exception as response:
                            self.assertEqual(response.code, 404)
                            self.assertIsNone(response.headers["Location"])
                    with self.assertRaises(urllib.error.HTTPError) as missing:
                        urllib.request.urlopen(f"{base}/api/unknown", timeout=5)
                    with missing.exception as response:
                        self.assertEqual(response.code, 404)
                        self.assertEqual(json.load(response), {"error": "not found"})
                    self.stop_daemon(process, stop_signal)
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=10)
