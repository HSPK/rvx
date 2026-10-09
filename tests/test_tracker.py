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
            records = json.loads(run.history_bytes())["snapshots"]
            if records and records[-1]["state"]["alerts"]:
                state = records[-1]["state"]
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
        state = json.loads(run.history_bytes())["snapshots"][-1]["state"]
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

    def test_module_log_preserves_receipt_and_explicit_timestamp(self):
        run = et.init(project="demo", name="timestamp", step_axis="trainer/step")
        result = et.log({"loss": 0.5}, step=7, commit=True, observed_at_ns=123456789)
        snapshot = json.loads(run.latest_bytes())
        self.assertTrue(result["accepted"])
        self.assertEqual(result["capture"]["next_sequence"], 1)
        self.assertEqual(snapshot["axes"], {"trainer/step": 7})
        self.assertEqual(snapshot["observed_at_ns"], 123456789)

    def test_span_decorator_records_native_timing(self):
        run = et.init(project="demo", name="decorator", run_id="decorator")

        @et.span("work")
        def work():
            return 7

        self.assertEqual(work(), 7)
        et.log({})
        state = json.loads(run.latest_bytes())["state"]
        self.assertEqual(state["spans"][0]["name"], "work")

    def test_history_filters_and_open_patch_are_native_and_bounded(self):
        run = et.Run(project="p", name="history", watchdog_interval_ms=0)
        try:
            run.log({"loss": 1, "large": "x" * 10000}, step=2, commit=True)
            run.log({"lr": 0.1}, step=2, commit=False)
            rows = run.history(1, metrics=["loss", "lr"], max_bytes=256)
            self.assertEqual(rows[0]["loss"], 1)
            self.assertEqual(rows[0]["lr"], 0.1)
            self.assertNotIn("lr", run.history(1, include_open=False)[0])
            self.assertEqual(run.history(0), [])
            with self.assertRaisesRegex(RuntimeError, "byte budget"):
                run.history(1, max_bytes=256, include_open=False)
        finally:
            run.close()

    def test_unsupported_compatibility_options_fail_instead_of_being_ignored(self):
        for options in ({"dir": "unused"}, {"backends": ["wandb"]}, {"resume": True}):
            with self.subTest(options=options), self.assertRaises(NotImplementedError):
                et.Run(project="p", **options)
        run = et.Run(project="p", name="unsupported")
        try:
            with self.assertRaises(NotImplementedError):
                run.define_metric("loss")
            with self.assertRaises(ValueError):
                run.finish(durable=True)
            self.assertEqual(run.info()["status"], "running")
        finally:
            run.close()

    def test_explicit_replay_shares_live_rule_contract(self):
        rules = ["mean(loss[3]) > 0 => warning: enough"]
        inputs = [{"kind": "step", "step": i, "observed_at_ns": i + 1,
                   "metrics": {"loss": 1}} for i in range(3)]
        self.assertEqual(et.replay_alerts(rules, inputs[:2]), [])
        self.assertEqual(et.replay_alerts(rules, inputs)[0]["step"], 2)

    def test_http_channels_are_isolated_and_shutdown_cancels_inflight_requests(self):
        fast_received = threading.Event()
        slow_started = threading.Event()
        release_slow = threading.Event()

        class Slow(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                slow_started.set()
                release_slow.wait(5)
                self.send_response(204)
                self.end_headers()

            def log_message(self, *_):
                pass

        class Fast(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                fast_received.set()
                self.send_response(204)
                self.end_headers()

            def log_message(self, *_):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Slow) as slow, ThreadingHTTPServer(("127.0.0.1", 0), Fast) as fast:
            threads = [threading.Thread(target=server.serve_forever) for server in (slow, fast)]
            for thread in threads:
                thread.start()
            run = et.Run(project="p", name="isolation", shutdown_timeout_ms=100,
                         alert={"channels": [
                             {"name": "slow", "url": f"http://127.0.0.1:{slow.server_port}"},
                             {"name": "fast", "url": f"http://127.0.0.1:{fast.server_port}"},
                         ], "timeout_seconds": 5, "max_retries": 0})
            try:
                run.alert("notice", "isolation")
                self.assertTrue(slow_started.wait(2))
                self.assertTrue(fast_received.wait(1), "slow channel blocked fast delivery")
                started = time.monotonic()
                result = run.finish()
                self.assertLess(time.monotonic() - started, 1.0)
                self.assertGreaterEqual(result["delivery"]["transport"]["accepted"], 2)
            finally:
                release_slow.set()
                run.close()
                for server in (slow, fast):
                    server.shutdown()
                for thread in threads:
                    thread.join(3)

    def test_durable_confirmation_timeout_gaps_and_wrong_identity_are_errors(self):
        run = et.Run(project="p", name="durability", watchdog_interval_ms=0)
        run.log({"loss": 1})
        response = {
            "run_id": run.id, "source_id": "source", "source_session_id": run.source_session_id,
            "persisted_next_sequence": 0, "complete": False, "has_gaps": False,
        }

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                body = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                kwargs = {"server_url": f"http://127.0.0.1:{server.server_port}", "source_id": "source"}
                with self.assertRaisesRegex(RuntimeError, "timed out"):
                    run.wait_persisted(**kwargs, timeout=0.05)
                response.update(has_gaps=True, persisted_next_sequence=1, complete=False)
                with self.assertRaisesRegex(RuntimeError, "gaps"):
                    run.wait_persisted(**kwargs)
                response.update(has_gaps=False, complete=True, source_session_id="other")
                with self.assertRaisesRegex(RuntimeError, "identity"):
                    run.wait_persisted(**kwargs)
                response.update(source_session_id=run.source_session_id)
                self.assertTrue(run.wait_persisted(**kwargs)["complete"])
            finally:
                run.close()
                server.shutdown()
                thread.join(3)

    def test_shared_encoder_rejects_cyclic_dataclass_conversion(self):
        from dataclasses import dataclass
        from rvx._tracker_values import json_value

        @dataclass
        class Node:
            value: object = None

        node = Node()
        node.value = node
        with self.assertRaisesRegex(ValueError, "circular"):
            json_value(node)

    def test_failed_http_attempt_is_not_deduplicated_as_delivered(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                requests.append(time.monotonic())
                self.send_response(503 if len(requests) == 1 else 204)
                self.end_headers()

            def log_message(self, *_):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            run = et.Run(project="p", name="retry", alert={
                "channels": [{"name": "test", "url": f"http://127.0.0.1:{server.server_port}"}],
                "max_retries": 0, "dedup_window_seconds": 300,
            })
            try:
                run.alert("same", "same")
                run.alert("same", "same")
                result = run.finish()
                self.assertEqual(len(requests), 2)
                self.assertEqual(result["delivery"]["transport"]["failed"], 1)
            finally:
                run.close()
                server.shutdown()
                thread.join(3)

    def test_native_history_and_working_state_budgets_are_observable(self):
        run = et.Run(project="p", name="budgets", max_history_bytes=700, max_metrics=1)
        try:
            for step in range(10):
                run.log({"loss": step})
            self.assertLessEqual(run.info()["history_bytes"], 700)
            self.assertGreater(run.info()["evicted_steps"], 0)
            before = run.info()
            with self.assertRaisesRegex(RuntimeError, "cardinality"):
                run.log({"other": 1})
            self.assertEqual(before, run.info())
        finally:
            run.close()

    def test_step_reports_the_target_of_the_next_implicit_log(self):
        run = et.Run(project="p", name="step-cursor", step_policy="allow", watchdog_interval_ms=0)
        try:
            run.log({"loss": 1}, step=10, commit=False)
            self.assertEqual(run.step, 10)
            self.assertEqual(run.log({"lr": 0.1})["step"], 10)
            self.assertEqual(run.step, 11)
            run.log({"loss": 2}, step=3, commit=False)
            self.assertEqual(run.step, 3)
            self.assertEqual(run.info()["next_step"], 11)
            self.assertEqual(run.log({"lr": 0.2})["step"], 3)
            self.assertEqual(run.step, 11)
        finally:
            run.close()

    def test_span_exposes_completed_duration(self):
        et.init(project="demo", name="duration", run_id="duration")

        with et.span("work") as span:
            pass

        self.assertGreaterEqual(span.duration_ms, 0)

    def test_completed_span_duration_survives_repeated_end(self):
        run = et.init(project="demo", name="retained-duration")
        for owner in (None, run):
            with self.subTest(native=owner is not None):
                span = et.Span(owner, "work", {}).begin()
                self.assertEqual(span.duration_ms, 0)
                duration = span.end()
                self.assertGreater(duration, 0)
                self.assertEqual(span.duration_ms, duration)
                self.assertEqual(span.end(), 0)
                self.assertEqual(span.duration_ms, duration)


if __name__ == "__main__":
    unittest.main()
