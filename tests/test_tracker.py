from __future__ import annotations

import json
import math
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from rvx import tracker as et


class TrackerSdkTests(unittest.TestCase):
    def tearDown(self):
        run = et.get_run()
        if run is not None:
            run.close()
            et._active_run = None

    def test_commit_summary_alert_and_span_share_one_snapshot(self):
        run = et.init(
            project="demo",
            experiment="train",
            name="trial",
            run_id="trial",
            alert_rules=["isnan(loss) => critical: invalid loss"],
            span_count=True,
        )
        et.log({}, step=4)
        with et.span("forward", batch=2):
            pass
        et.log({"loss": math.nan}, step=4)
        et.log({"lr": 0.1}, step=4, commit=True)

        history = et.history(-1)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["_step"], 4)
        self.assertEqual(history[0]["loss"], {"$rvx.nonfinite": "nan"})
        self.assertEqual(history[0]["count/forward"], 1.0)
        state = json.loads(run.latest_bytes())["state"]
        self.assertEqual(state["tracker"]["nonfinite"], ["loss"])
        self.assertEqual(state["alerts"][0]["level"], "critical")
        self.assertEqual(state["spans"][0]["name"], "forward")
        self.assertEqual(state["summary"]["lr"], 0.1)

    def test_monotonic_steps_warn_and_same_step_patches_merge_history(self):
        et.init(project="demo", name="trial", run_id="trial")
        et.log({"x": 1}, step=5, commit=True)
        et.log({"y": 2}, step=5, commit=True)
        with self.assertWarnsRegex(RuntimeWarning, "behind"):
            et.log({"z": 3}, step=4, commit=True)
        self.assertEqual(
            et.history(-1),
            [{"_step": 5, "_time": et.history(-1)[0]["_time"], "x": 1, "y": 2}],
        )

    def test_watchdog_captures_no_data_alert_without_a_log_call(self):
        run = et.init(
            project="demo",
            name="watchdog",
            run_id="watchdog",
            alert_rules=["no_data(100ms) => error: stalled"],
            watchdog_interval_ms=100,
        )
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                state = json.loads(run.latest_bytes())["state"]
            except RuntimeError:
                time.sleep(0.02)
                continue
            if state["alerts"]:
                break
            time.sleep(0.02)
        else:
            self.fail("watchdog did not capture a no_data alert")
        self.assertEqual(state["alerts"][0]["message"], "stalled")

    def test_rules_can_be_added_listed_and_removed_at_runtime(self):
        run = et.init(project="demo", name="rules", run_id="rules")
        et.add_alert_rule(
            {
                "alert": "loss-high",
                "expr": "loss > 1",
                "level": "error",
                "message": "high",
            }
        )
        self.assertEqual(et.list_alert_rules()[0]["name"], "loss-high")
        et.log({"loss": 2})
        state = json.loads(run.latest_bytes())["state"]
        self.assertEqual(state["alerts"][0]["rule"], "loss-high")
        self.assertTrue(et.remove_alert_rule("loss-high"))
        self.assertEqual(et.list_alert_rules(), [])

    def test_alert_delivery_runs_in_the_native_worker(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                received.append(json.loads(self.rfile.read(length)))
                self.send_response(204)
                self.end_headers()

            def log_message(self, _format, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                et.init(
                    project="demo",
                    name="delivery",
                    run_id="delivery",
                    alert_rules=["loss > 1 => error: high"],
                    alert={
                        "channels": [
                            {
                                "type": "webhook",
                                "name": "test",
                                "url": f"http://127.0.0.1:{server.server_port}",
                            }
                        ],
                        "policy": {"max_retries": 0},
                    },
                )
                et.log({"loss": 2})
                et.finish()
                deadline = time.monotonic() + 3
                while not received and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertEqual(received[0]["message"], "high")
            finally:
                server.shutdown()
                thread.join(timeout=5)

    def test_artifact_lineage_is_hashed_in_rust_and_captured(self):
        run = et.init(project="demo", name="artifacts", run_id="artifacts")
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "checkpoint.bin"
            path.write_bytes(b"weights")
            et.log_artifact(path, name="model", type="checkpoint", aliases=["best"])
        state = json.loads(run.latest_bytes())["state"]
        artifact = state["artifacts"][0]
        self.assertEqual(artifact["action"], "log")
        self.assertEqual(artifact["name"], "model")
        self.assertEqual(artifact["type"], "checkpoint")
        self.assertEqual(artifact["aliases"], ["best"])
        self.assertEqual(len(artifact["digest"]), 64)

    def test_tracker_exposes_the_standard_source_pull_protocol(self):
        run = et.init(
            project="demo",
            experiment="train",
            name="served",
            run_id="served",
            serve=True,
        )
        et.log({"loss": 0.5})
        descriptor = json.loads(run.descriptor_bytes())
        self.assertEqual(descriptor["role"], "tracker")
        self.assertEqual(descriptor["run_id"], "served")
        self.assertTrue(run.endpoint.startswith("http://"))
        history = json.loads(run.history_bytes())
        self.assertEqual(history["snapshots"][0]["state"]["metrics"]["loss"], 0.5)

    def test_tracker_accepts_a_role_specific_step_axis(self):
        run = et.init(
            project="demo",
            name="axis",
            run_id="axis",
            step_axis="trainer/step",
        )
        et.log({"loss": 0.5}, step=7, commit=True)

        snapshot = json.loads(run.latest_bytes())

        self.assertEqual(snapshot["axes"], {"trainer/step": 7})

    def test_span_decorator_records_native_timing(self):
        run = et.init(project="demo", name="decorator", run_id="decorator")

        @et.span("work")
        def work():
            return 7

        self.assertEqual(work(), 7)
        et.log({})
        state = json.loads(run.latest_bytes())["state"]
        self.assertEqual(state["spans"][0]["name"], "work")

    def test_span_exposes_completed_duration(self):
        et.init(project="demo", name="duration", run_id="duration")

        with et.span("work") as span:
            pass

        self.assertGreaterEqual(span.duration_ms, 0)


if __name__ == "__main__":
    unittest.main()
