from __future__ import annotations

import gc
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import MappingProxyType

import rvx
from rvx import CaptureReceipt, SnapshotEvent, Source, SourceStats, RvxService, RvxSettings


def make_source(**overrides):
    return Source(**{
        "project": "project", "experiment": "experiment",
        "run_id": "run-1", "role": "learner", **overrides,
    })


def serving_source(*, host="127.0.0.1", port=0, **overrides):
    return make_source(**overrides).serve(host=host, port=port)


def fetch(server, path):
    with urllib.request.urlopen(server.endpoint + path, timeout=5) as response:
        return json.load(response)


class SourceTests(unittest.TestCase):
    """Exercise the actual Python SDK and native HTTP producer together."""

    def test_context_and_raw_reads_do_not_start_http(self):
        with make_source() as source:
            self.assertIsInstance(source.stats(), SourceStats)
            self.assertEqual(json.loads(source.history_bytes())["snapshots"], [])
            self.assertEqual(json.loads(source.descriptor_bytes())["source_session_id"], source.source_session_id)
            with self.assertRaises(RuntimeError):
                source.latest_bytes()
            source.capture({"nested": [True, None, 2**64 - 1]}, observed_at_ns=123)
            self.assertEqual(
                json.loads(source.latest_bytes())["state"],
                {"nested": [True, None, 2**64 - 1]},
            )
            with self.assertRaises(RuntimeError):
                _ = source.endpoint
            source.stop_serving()
        for reader in (source.descriptor_bytes, source.latest_bytes, source.history_bytes):
            with self.assertRaises(RuntimeError):
                reader()
        self.assertTrue(source.stats().sealed)
        self.assertEqual(source.stats().buffered_snapshots, 0)
        self.assertEqual(source.stats().buffered_bytes, 0)

    def test_listener_rebind_keeps_the_source_session_and_capture_stream(self):
        with make_source() as source:
            source.capture({"phase": "before-http"})
            session = source.source_session_id
            source.serve()
            endpoint = source.endpoint
            port = int(endpoint.rsplit(":", 1)[1])
            with self.assertRaises(RuntimeError):
                source.serve(host="0.0.0.0")
            source.stop_serving()
            source.stop_serving()
            with self.assertRaises(urllib.error.URLError):
                urllib.request.urlopen(endpoint + "/healthz", timeout=1)
            self.assertEqual(source.capture({"phase": "between-listeners"}).sequence, 1)
            source.serve(port=port)
            self.assertEqual(source.source_session_id, session)
            self.assertEqual(source.endpoint, endpoint)
            self.assertEqual(fetch(source, "/v1/snapshots/history")["next_sequence"], 2)

    def test_raw_cursor_validation_does_not_coerce_coordinates(self):
        with make_source() as source:
            for query in (
                {"after": -1}, {"after": True}, {"after": 1.5}, {"after": 2**63},
                {"limit": 0}, {"limit": False}, {"limit": 257},
            ):
                with self.subTest(query=query), self.assertRaises((TypeError, ValueError)):
                    source.history_bytes(**query)
            self.assertEqual(source.stats().next_sequence, 0)

    def test_identity_schema_and_native_startup(self):
        server = make_source(rank=2, node_id="node-a", labels={"queue": "training"})
        with self.assertRaises(RuntimeError):
            _ = server.endpoint
        receipt = server.capture({"progress": {"loss": 0.5}})
        self.assertIsInstance(receipt, CaptureReceipt)
        self.assertEqual(receipt.sequence, 0)
        with server:
            with self.assertRaises(RuntimeError):
                _ = server.endpoint
            server.serve()
            endpoint = server.endpoint
            self.assertIs(server.serve(), server)
            self.assertEqual(server.endpoint, endpoint)
            descriptor = fetch(server, "/v1/snapshots/descriptor")
            self.assertEqual(descriptor["protocol_version"], 1)
            self.assertEqual(descriptor["schema_version"], 1)
            self.assertEqual(descriptor["source_session_id"], server.source_session_id)
            self.assertEqual(descriptor["run_id"], "run-1")
            self.assertEqual(descriptor["attempt_id"], "attempt-1")
            self.assertEqual(descriptor["rank"], 2)
            self.assertEqual(descriptor["node_id"], "node-a")
            self.assertEqual(descriptor["pid"], os.getpid())
            self.assertEqual(descriptor["labels"], {"queue": "training"})
            self.assertNotIn("metrics", descriptor)
        server.close()
        with self.assertRaisesRegex(RuntimeError, "closed"):
            server.serve()

    def test_full_replacement_immutable_history_arrays_and_null(self):
        original = {"progress": {"loss": 0.8}, "workers": [{"busy": True}], "obsolete": 1}
        with serving_source() as server:
            server.capture(MappingProxyType(original), observed_at_ns=10, axes={"step": 1})
            original["progress"]["loss"] = 99
            original["workers"].append("mutated")
            receipt = server.capture_batch([
                SnapshotEvent({"workers": [], "obsolete": None}, 11, {"step": 2}),
                SnapshotEvent({}, 12),
            ])
            self.assertEqual((receipt.first_sequence, receipt.next_sequence, receipt.accepted), (1, 3, 2))
            first = fetch(server, "/v1/snapshots/history?after=0&limit=2")
            self.assertEqual(first["next_sequence"], 2)
            self.assertEqual(first["snapshots"][0]["state"], {
                "progress": {"loss": 0.8}, "workers": [{"busy": True}], "obsolete": 1,
            })
            self.assertNotIn("progress", first["snapshots"][1]["state"])
            self.assertIsNone(first["snapshots"][1]["state"]["obsolete"])
            second = fetch(server, "/v1/snapshots/history?after=2&limit=2")
            self.assertEqual(second["next_sequence"], 3)
            self.assertEqual(second["snapshots"][0]["state"], {})
            latest = fetch(server, "/v1/snapshots/latest")
            self.assertEqual((latest["sequence"], latest["observed_at_ns"], latest["state"]), (2, 12, {}))
            self.assertEqual(fetch(server, "/v1/snapshots/history?after=3")["snapshots"], [])

    def test_bounded_history_reports_eviction(self):
        with serving_source(capacity=2) as server:
            server.capture_batch([SnapshotEvent({"reward": 1}), SnapshotEvent({"reward": 2})])
            before = server.stats()
            with self.assertRaises(ValueError):
                server.capture_batch(SnapshotEvent({"reward": value}) for value in range(3))
            self.assertEqual(server.stats(), before)
            server.capture({"reward": 3})
            stats = server.stats()
            self.assertEqual((stats.buffered_snapshots, stats.dropped_snapshots, stats.oldest_sequence), (2, 1, 1))
            response = fetch(server, "/v1/snapshots/history?after=0&limit=1")
            self.assertEqual((response["dropped_before"], response["next_sequence"]), (1, 2))
            self.assertEqual(response["snapshots"][0]["state"]["reward"], 2)

    def test_invalid_batch_is_atomic_in_python_and_native(self):
        with make_source() as server:
            server.capture({"loss": 1})
            before = server.stats()
            for invalid in [
                SnapshotEvent({"nested": [float("nan")]}),
                SnapshotEvent({"nested": {"value": float("inf")}}),
                SnapshotEvent({"bad": 2}, axes={"step": 0.5}),
                SnapshotEvent({"bad": 2}, axes={"step": 2**63}),
                SnapshotEvent({1: "non-string key"}),
                SnapshotEvent([]), SnapshotEvent(None),
            ]:
                with self.subTest(invalid=invalid), self.assertRaises((TypeError, ValueError)):
                    server.capture_batch([SnapshotEvent({"valid": 2}), invalid])
                self.assertEqual(server.stats(), before)
            for encoded in [
                '[{"state":{"new":1}},{"state":[]}]',
                '[{"state":NaN}]',
                '[{"state":{"bad":1e400}}]',
                '[{"state":{"bad":18446744073709551616}}]',
                '[{"state":{"bad":-9223372036854775809}}]',
                '[{"state":{},"axes":{"step":true}}]',
                '[{"state":{},"unexpected":1}]',
            ]:
                with self.subTest(encoded=encoded), self.assertRaises(ValueError):
                    server._native.capture_batch_json(encoded)
                self.assertEqual(server.stats(), before)
            with self.assertRaises(ValueError):
                server.capture_batch([])

    def test_json_depth_limit_and_cycles(self):
        leaves = ({}, [], None, True, 1, 0.25, "leaf")
        with make_source() as server:
            for leaf in leaves:
                allowed = leaf
                for _ in range(64):
                    allowed = {"child": allowed}
                with self.subTest(leaf=leaf):
                    server.capture(allowed)
                    server._native.capture_batch_json(json.dumps([{"state": allowed}]))
                    before = server.stats()
                    with self.assertRaises(ValueError):
                        server.capture({"child": allowed})
                    with self.assertRaises(ValueError):
                        server._native.capture_batch_json(json.dumps([{"state": {"child": allowed}}]))
                    self.assertEqual(server.stats(), before)
            cycle = {}
            cycle["self"] = cycle
            with self.assertRaises(ValueError):
                server.capture(cycle)
            self.assertEqual(server.stats().next_sequence, len(leaves) * 2)

    def test_json_node_limit_is_atomic_in_python_and_native(self):
        with make_source() as server:
            for state in ({"items": [None] * 100_000}, {"bigint": 2**64}):
                with self.assertRaises(ValueError):
                    server.capture(state)
                with self.assertRaises(ValueError):
                    server._native.capture_batch_json(json.dumps([{"state": state}]))
            self.assertEqual(server.stats().next_sequence, 0)

    def test_signed_and_unsigned_integer_boundaries_are_lossless(self):
        state = {"minimum": -(2**63), "maximum": 2**64 - 1, "beyond_float_precision": 2**53 + 1}
        with serving_source() as server:
            server.capture(state, observed_at_ns=-(2**63), axes={"step": 2**63 - 1})
            latest = fetch(server, "/v1/snapshots/latest")
            self.assertEqual(latest["state"], state)
            self.assertTrue(all(isinstance(value, int) for value in latest["state"].values()))
            server._native.capture_batch_json(json.dumps([{"state": state}]))
            self.assertEqual(fetch(server, "/v1/snapshots/latest")["state"], state)
            before = server.stats()
            for invalid in (-(2**63) - 1, 2**64):
                with self.assertRaises(ValueError):
                    server.capture({"invalid": invalid})
                with self.assertRaises(ValueError):
                    server._native.capture_batch_json(json.dumps([{"state": {"invalid": invalid}}]))
                self.assertEqual(server.stats(), before)

    def test_byte_budget_oversized_state_and_batch(self):
        with make_source(capacity=100, max_buffer_bytes=2048) as server:
            for index in range(8):
                server.capture({"index": index})
            self.assertLessEqual(server.stats().buffered_bytes, 2048)
            self.assertGreater(server.stats().dropped_snapshots, 0)
            before = server.stats()
            with self.assertRaises(ValueError):
                server.capture_batch([SnapshotEvent({"small": 1}), SnapshotEvent({"large": "x" * 3000})])
            self.assertEqual(server.stats(), before)
        with make_source() as server:
            with self.assertRaisesRegex(ValueError, "4 MiB"):
                server.capture({"large": "x" * (4 * 1024 * 1024)})
            with self.assertRaisesRegex(ValueError, "16 MiB"):
                server.capture_batch(SnapshotEvent({"large": "x" * (3 * 1024 * 1024)}) for _ in range(6))
            self.assertEqual(server.stats().next_sequence, 0)

    def test_http_page_budget_and_default_count(self):
        with serving_source() as server:
            for index in range(70):
                server.capture({"index": index})
            self.assertEqual(len(fetch(server, "/v1/snapshots/history")["snapshots"]), 64)
        with serving_source() as server:
            for _ in range(6):
                server.capture({"large": "x" * (3 * 1024 * 1024)})
            with urllib.request.urlopen(server.endpoint + "/v1/snapshots/history", timeout=10) as response:
                encoded = response.read()
            self.assertLessEqual(len(encoded), 16 * 1024 * 1024)
            first = json.loads(encoded)
            self.assertEqual((len(first["snapshots"]), first["next_sequence"]), (5, 5))
            self.assertEqual(fetch(server, "/v1/snapshots/history?after=5")["next_sequence"], 6)

    def test_rejects_invalid_builder_configuration(self):
        for options in [
            {"run_id": ""}, {"capacity": 0}, {"max_buffer_bytes": 0},
            {"schema_version": 0}, {"schema_version": 2}, {"schema_version": True},
            {"labels": {1: "invalid"}},
        ]:
            with self.subTest(options=options), self.assertRaises((TypeError, ValueError)):
                make_source(**options)
        with make_source() as source:
            for options in ({"port": True}, {"port": -1}, {"host": "not-an-ip"}, {"host": ""}):
                with self.subTest(options=options), self.assertRaises((TypeError, ValueError)):
                    source.serve(**options)
            self.assertEqual(source.capture({}).sequence, 0)

    def test_native_defaults_schema_and_rejects_invalid_identity(self):
        from rvx._native import RvxSource
        identity = {"project": "p", "experiment": "e", "run_id": "r", "attempt_id": "a", "role": "worker"}
        server = RvxSource(json.dumps(identity))
        try:
            self.assertEqual(json.loads(server.capture_batch_json('[{"state":{}}]'))["first_sequence"], 0)
            endpoint = server.serve()
            with urllib.request.urlopen(endpoint + "/v1/snapshots/descriptor", timeout=3) as response:
                self.assertEqual(json.load(response)["schema_version"], 1)
        finally:
            server.close()
        for invalid in [
            {**identity, "schema_version": 2},
            {**identity, "schema_version": True},
            {**identity, "metrics": []},
        ]:
            with self.assertRaises(ValueError):
                RvxSource(json.dumps(invalid))

    def test_no_implicit_tensor_or_model_conversion_or_legacy_exports(self):
        class Tensor:
            def __float__(self):
                raise AssertionError("implicit tensor conversion")

            def item(self):
                raise AssertionError("implicit tensor extraction")

        with make_source() as server:
            with self.assertRaisesRegex(TypeError, "no automatic tensor/model conversion"):
                server.capture({"loss": Tensor()})
        for name in (
            "MetricServer", "MetricEvent", "MetricDefinition", "RecordReceipt",
            "SnapshotServer", "SnapshotServerStats",
        ):
            self.assertFalse(hasattr(rvx, name))
        for name in ("log", "log_batch"):
            self.assertFalse(hasattr(Source, name))
        self.assertFalse(hasattr(Source, "start"))

    def test_read_only_http_errors_and_initial_state(self):
        with serving_source() as server:
            self.assertEqual(fetch(server, "/v1/snapshots/history"), {
                "protocol_version": 1, "source_session_id": server.source_session_id,
                "oldest_sequence": 0, "next_sequence": 0, "dropped_before": None, "snapshots": [],
            })
            for path, expected in [
                ("/v1/snapshots/latest", 503), ("/v1/snapshots/history?after=1", 400),
                ("/v1/snapshots/history?after=-1", 400), ("/v1/snapshots/history?limit=0", 400),
                ("/v1/snapshots/history?limit=257", 400), ("/v1/snapshots/history?after=abc", 400),
                ("/v1/snapshots/history?unexpected=1", 400), ("/v1/metrics/points", 404),
            ]:
                with self.subTest(path=path), self.assertRaises(urllib.error.HTTPError) as error:
                    fetch(server, path)
                with error.exception as response:
                    self.assertEqual(response.code, expected)
                    self.assertIn("no-store", response.headers["Cache-Control"])
            request = urllib.request.Request(server.endpoint + "/v1/snapshots/history", data=b"{}", method="POST")
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request, timeout=3)
            with error.exception as response:
                self.assertEqual(response.code, 405)

    def test_seal_keeps_history_readable(self):
        with serving_source() as server:
            server.capture({"loss": 1})
            self.assertEqual(server.seal(), 1)
            self.assertEqual(server.seal(), 1)
            self.assertTrue(server.stats().sealed)
            with self.assertRaisesRegex(RuntimeError, "sealed"):
                server.capture({"loss": 0})
            self.assertEqual(len(fetch(server, "/v1/snapshots/history")["snapshots"]), 1)
        with self.assertRaisesRegex(RuntimeError, "closed"):
            server.capture({"loss": 0})

    def test_concurrent_capture_and_http_reads(self):
        with serving_source() as server, ThreadPoolExecutor(max_workers=6) as workers:
            def capture(value):
                receipt = server.capture({"nested": {"value": value}, "queue": [True, None]})
                latest = fetch(server, "/v1/snapshots/latest")
                self.assertGreaterEqual(latest["sequence"], receipt.sequence)
                return receipt.sequence
            sequences = list(workers.map(capture, range(100)))
            self.assertEqual(sorted(sequences), list(range(100)))
            history = fetch(server, "/v1/snapshots/history?limit=256")
            self.assertEqual([item["sequence"] for item in history["snapshots"]], list(range(100)))

    def test_close_releases_port_and_restart_has_fresh_session(self):
        with serving_source() as first:
            old_session = first.source_session_id
            port = int(first.endpoint.rsplit(":", 1)[1])
            second = make_source()
            try:
                with self.assertRaises(RuntimeError):
                    second.serve(port=port)
                self.assertEqual(second.capture({"still_usable": True}).sequence, 0)
            finally:
                second.close()
        with serving_source(port=port) as restarted:
            self.assertNotEqual(restarted.source_session_id, old_session)
            self.assertEqual(restarted.capture({}).sequence, 0)

    def test_context_failure_and_gc_release_listener(self):
        server = make_source()
        with self.assertRaisesRegex(ValueError, "training failed"):
            with server:
                server.serve()
                endpoint = server.endpoint
                raise ValueError("training failed")
        with self.assertRaises(urllib.error.URLError):
            urllib.request.urlopen(endpoint + "/healthz", timeout=1)
        orphan = serving_source()
        endpoint = orphan.endpoint
        del orphan
        gc.collect()
        with self.assertRaises(urllib.error.URLError):
            urllib.request.urlopen(endpoint + "/healthz", timeout=1)

    @unittest.skipUnless(hasattr(os, "fork"), "fork is Unix-specific")
    def test_fork_guard_and_child_gc(self):
        script = """
import gc, os
from rvx import Source
server = Source(project='p', experiment='e', run_id='r', role='actor').serve()
pid = os.fork()
if pid == 0:
    try:
        server.capture({'workers': []})
    except RuntimeError as error:
        if 'worker process' not in str(error): os._exit(2)
    else:
        os._exit(3)
    del server
    gc.collect()
    os._exit(0)
_, status = os.waitpid(pid, 0)
server.close()
raise SystemExit(os.waitstatus_to_exitcode(status))
"""
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


class SnapshotConsumerTests(unittest.TestCase):
    """Pull actual SDK producers into durable native storage, never a Push fixture."""

    def wait_for_snapshots(self, service, expected):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if service.stats()["snapshots"] == expected:
                return
            time.sleep(0.02)
        self.fail(f"expected {expected} durable snapshots; got {service.stats()}")

    def service(self, directory):
        return RvxService(RvxSettings(directory=Path(directory), scrape_concurrency=2))

    def register(self, service, run, role, producer):
        return service.register_source({
            "run_id": run, "attempt_id": "attempt-1", "role": role,
            "endpoint": producer.endpoint, "scrape_interval_ms": 50, "timeout_ms": 400,
        })

    def test_raw_history_projection_diff_and_restart(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            service = self.service(directory)
            try:
                run = service.ensure_hierarchy("project", "experiment", "async", {})["run"]["id"]
                with serving_source(run_id=run) as learner, serving_source(run_id=run, role="actor") as actor:
                    learner.capture_batch([
                        SnapshotEvent({"progress": {"loss": 0.8}, "removed": 1, "nullable": "old",
                                       "workers": [{"status": "busy"}]}, 10, {"step": 1}),
                        SnapshotEvent({"progress": {"loss": None}, "nullable": None, "added": True,
                                       "workers": []}, 20, {"step": 2}),
                        SnapshotEvent({"progress": {}, "nullable": None}, 30),
                    ])
                    actor.capture({"queue": {"ready": 8}, "metrics": {"cpu/percent": 12}}, observed_at_ns=15)
                    learner_source = self.register(service, run, "learner", learner)["id"]
                    self.register(service, run, "actor", actor)
                    service.start()
                    self.wait_for_snapshots(service, 4)
                    self.assertEqual(service.stats()["scrape_failures"], 0)
                    self.assertEqual(set(service.stats()), {
                        "projects", "experiments", "runs", "sources", "active_sources",
                        "snapshots", "cursor_gaps", "scrape_failures",
                    })
                    latest = service.snapshot_latest({"run_id": run, "limit": 1})
                    self.assertEqual(len(latest["snapshots"]), 1)
                    self.assertIsNotNone(latest["next_source_id"])
                    continuation = service.snapshot_latest({
                        "run_id": run, "limit": 1, "after_source_id": latest["next_source_id"],
                    })
                    self.assertEqual(len(continuation["snapshots"]), 1)
                    self.assertNotEqual(latest["snapshots"][0]["source_id"], continuation["snapshots"][0]["source_id"])
                    page = service.snapshot_history({"run_id": run, "source_ids": [learner_source], "limit": 2})
                    self.assertEqual([row["sequence"] for row in page["snapshots"]], [2, 1])
                    older = service.snapshot_history({
                        "run_id": run, "source_ids": [learner_source], "before_id": page["next_before_id"],
                    })
                    self.assertEqual([row["sequence"] for row in older["snapshots"]], [0])
                    first, second = older["snapshots"][0], page["snapshots"][1]
                    changes = service.snapshot_diff({"before_id": first["id"], "after_id": second["id"]})
                    changes_by_path = {change["path"]: change for change in changes["changes"]}
                    self.assertEqual(changes_by_path["/removed"]["kind"], "removed")
                    self.assertNotIn("after", changes_by_path["/removed"])
                    self.assertEqual(changes_by_path["/nullable"]["kind"], "changed")
                    self.assertIsNone(changes_by_path["/nullable"]["after"])
                    self.assertEqual(changes_by_path["/added"]["kind"], "added")
                    self.assertFalse(changes["truncated"])
                    query = {"run_ids": [run], "source_ids": [learner_source], "paths": ["/progress/loss"]}
                    result = service.snapshot_query(query)
                    self.assertEqual(result["axis"], "wall_time")
                    self.assertEqual(result["series"][0]["axes"], [10, 20, 30])
                    self.assertEqual(result["series"][0]["values"], [0.8, None, None])
                    self.assertEqual(result["series"][0]["source_session_ids"], [learner.source_session_id] * 3)
                    logical = service.snapshot_query({**query, "axis": "step"})
                    self.assertEqual(logical["series"][0]["axes"], [1, 2])
                    with self.assertRaisesRegex(RuntimeError, "not an indexed numeric field"):
                        service.snapshot_query({**query, "paths": ["/added", "/workers"]})
                    catalog = service.chart_catalog({"run_ids": [run]})
                    loss = next(metric for metric in catalog["metrics"] if metric["path"] == "/progress/loss")
                    self.assertIsNone(loss["sources"][0]["latest_value"])
                    self.assertEqual(loss["group"], "Training")
                    self.assertTrue(loss["sources"][0]["primary"])
                    self.assertEqual(service.snapshot_get(first["id"]), first)
                    elapsed = service.snapshot_query({**query, "axis": "elapsed"})
                    self.assertEqual(elapsed["series"][0]["axes"], [0, 10, 20])
                    for snapshot_id, value in zip(result["series"][0]["snapshot_ids"], result["series"][0]["values"]):
                        self.assertEqual(service.snapshot_get(snapshot_id)["state"]["progress"].get("loss"), value)
                    escaped = service.snapshot_query({"run_ids": [run], "paths": ["/metrics/cpu~1percent"]})
                    actor_series = next(series for series in escaped["series"] if series["source_id"] != learner_source)
                    self.assertEqual(actor_series["values"], [12])
                    learner.seal()
                    actor.seal()
                    service.close()
                service = self.service(directory)
                self.assertEqual(service.snapshot_query(query), result)
                self.assertEqual(service.stats()["snapshots"], 4)
                self.assertEqual(service.snapshot_diff({"before_id": first["id"], "after_id": second["id"]}), changes)
                self.assertEqual(service.chart_catalog({"run_ids": [run]}), catalog)
            finally:
                service.close()

    def test_collector_restart_persists_expired_cursor_gap(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            service = self.service(directory)
            try:
                run = service.ensure_hierarchy("project", "experiment", "lagged", {})["run"]["id"]
                with serving_source(run_id=run, capacity=2) as producer:
                    producer.capture({"loss": 1}, axes={"step": 0})
                    self.register(service, run, "learner", producer)
                    service.start()
                    self.wait_for_snapshots(service, 1)
                    service.close()
                    for index in range(1, 4):
                        producer.capture({"loss": index + 1}, axes={"step": index})
                    service = self.service(directory)
                    service.start()
                    self.wait_for_snapshots(service, 3)
                    self.assertEqual(service.stats()["cursor_gaps"], 1)
                    result = service.snapshot_query({"run_ids": [run], "paths": ["/loss"], "axis": "step"})
                    self.assertEqual(result["series"][0]["sequences"], [0, 2, 3])
            finally:
                service.close()

    def test_depth_boundary_uses_the_shared_consumer_validator(self):
        state = {}
        for _ in range(64):
            state = {"child": state}
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            service = self.service(directory)
            try:
                run = service.ensure_hierarchy("project", "experiment", "deep", {})["run"]["id"]
                with serving_source(run_id=run) as producer:
                    producer.capture(state)
                    self.register(service, run, "learner", producer)
                    service.start()
                    self.wait_for_snapshots(service, 1)
                    self.assertEqual(service.snapshot_latest({"run_id": run})["snapshots"][0]["state"], state)
            finally:
                service.close()

    def test_producer_restart_preserves_distinct_session_histories(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            service = self.service(directory)
            try:
                run = service.ensure_hierarchy("project", "experiment", "sessions", {})["run"]["id"]
                with serving_source(run_id=run) as first:
                    port = int(first.endpoint.rsplit(":", 1)[1])
                    first.capture({"phase": "first"}, observed_at_ns=10)
                    session = first.source_session_id
                    self.register(service, run, "learner", first)
                    service.start()
                    self.wait_for_snapshots(service, 1)
                with serving_source(run_id=run, port=port) as second:
                    second.capture({"phase": "restarted"}, observed_at_ns=20)
                    self.wait_for_snapshots(service, 2)
                    history = service.snapshot_history({"run_id": run})["snapshots"]
                    self.assertEqual([row["sequence"] for row in history], [0, 0])
                    self.assertEqual([row["source_session_id"] for row in history],
                                     [second.source_session_id, session])
                    self.assertEqual(service.snapshot_latest({"run_id": run})["snapshots"][0]["state"],
                                     {"phase": "restarted"})
            finally:
                service.close()

    def test_cross_run_comparison_preserves_paths_and_run_identity(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            service = self.service(directory)
            try:
                first_run = service.ensure_hierarchy("project", "experiment", "first", {})["run"]["id"]
                second_run = service.ensure_hierarchy("project", "experiment", "second", {})["run"]["id"]
                with serving_source(run_id=first_run) as first, serving_source(run_id=second_run) as second:
                    first.capture({"progress": {"loss": 0.8}, "flag": None}, observed_at_ns=10)
                    second.capture({"progress": {"loss": 0.4}}, observed_at_ns=20)
                    self.register(service, first_run, "learner", first)
                    self.register(service, second_run, "learner", second)
                    service.start()
                    self.wait_for_snapshots(service, 2)
                    projected = service.snapshot_query({
                        "run_ids": [first_run, second_run], "paths": ["/progress/loss"],
                    })
                    self.assertEqual({series["run_id"] for series in projected["series"]},
                                     {first_run, second_run})
                    before = service.snapshot_latest({"run_id": first_run})["snapshots"][0]["id"]
                    after = service.snapshot_latest({"run_id": second_run})["snapshots"][0]["id"]
                    changes = service.snapshot_diff({"before_id": before, "after_id": after})["changes"]
                    removed = next(change for change in changes if change["path"] == "/flag")
                    self.assertEqual(removed, {"path": "/flag", "kind": "removed", "before": None})
            finally:
                service.close()


if __name__ == "__main__":
    unittest.main()
