from __future__ import annotations

import json
import os
import select
import signal
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path

from rvx import SnapshotEvent, Source
from rvx.cli import api_request, build_parser, execute


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("RVXD_BINARY", ROOT / "target/debug/rvxd"))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Inspect navigation targets without contacting the configured hostmon."""

    def redirect_request(self, request, response, code, message, headers, new_url):
        """Leave redirect responses available for exact Location assertions."""
        return None


@unittest.skipUnless(os.name == "posix" and BINARY.is_file(), "build rvxd or set RVXD_BINARY")
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
                self.assertEqual(stats["ingested_points"], 0)
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
                "--hostmon-url", "http://127.0.0.1:1",
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
                        project = api_request(
                            base, "/api/experiments/projects", method="POST", payload={"name": "persisted"}
                        )
                        experiment = api_request(
                            base, "/api/experiments/experiments", method="POST",
                            payload={"project_id": project["id"], "name": "snapshots"},
                        )
                        run = api_request(
                            base, "/api/experiments/runs", method="POST",
                            payload={"experiment_id": experiment["id"], "name": "run", "config": {}},
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
                            api_request(
                                base, "/api/experiments/sources", method="POST",
                                payload={
                                    "run_id": run["id"], "attempt_id": "attempt-1", "role": "worker",
                                    "endpoint": producer.endpoint, "scrape_interval_ms": 50, "timeout_ms": 400,
                                },
                            )
                            deadline = time.monotonic() + 10
                            while time.monotonic() < deadline:
                                if api_request(base, "/api/experiments/stats")["snapshots"] == 2:
                                    break
                                time.sleep(0.02)
                            self.assertEqual(api_request(base, "/api/experiments/stats")["snapshots"], 2)
                    latest = execute(build_parser().parse_args([
                        "--url", base, "snapshots", "latest", "--run", run["id"],
                    ]))
                    self.assertEqual(latest["snapshots"][0]["state"],
                                     {"progress": {"loss": 0.4}, "nullable": None})
                    history = execute(build_parser().parse_args([
                        "--url", base, "snapshots", "history", "--run", run["id"],
                    ]))
                    self.assertEqual([row["sequence"] for row in history["snapshots"]], [1, 0])
                    after, before = history["snapshots"]
                    diff = execute(build_parser().parse_args([
                        "--url", base, "snapshots", "diff",
                        "--before-id", str(before["id"]), "--after-id", str(after["id"]),
                    ]))
                    self.assertIn({"path": "/removed", "kind": "removed", "before": True}, diff["changes"])
                    trend = execute(build_parser().parse_args([
                        "--url", base, "query", "--run", run["id"], "--field", "/progress/loss",
                    ]))
                    self.assertEqual(trend["axis"], "wall_time")
                    self.assertEqual(trend["series"][0]["values"], [0.8, 0.4])
                    self.assertEqual(api_request(base, "/api/experiments/projects"), {"projects": [project]})
                    with urllib.request.urlopen(f"{base}/rvx/projects", timeout=5) as response:
                        self.assertIn(b"<title>fixture</title>", response.read())
                    navigation = urllib.request.build_opener(NoRedirect)
                    for page in ("settings", "layouts"):
                        with self.assertRaises(urllib.error.HTTPError) as redirect:
                            navigation.open(f"{base}/hostmon?page={page}", timeout=5)
                        with redirect.exception as response:
                            self.assertEqual(response.code, 307)
                            self.assertEqual(
                                response.headers["Location"],
                                f"http://127.0.0.1:1/?page={page}",
                            )
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
