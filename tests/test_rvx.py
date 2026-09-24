from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from rvx import RvxError, RvxService, RvxSettings


def engine_directory():
    """Keep isolated test storage under the project, never in user state."""
    return tempfile.TemporaryDirectory(dir=Path(__file__).parent)


class RvxBindingTests(unittest.TestCase):
    """Validate the Python SDK adapter against the native engine."""

    def test_pulls_snapshots_and_recovers_history(self):
        try:
            from rvx._native import RvxEngine
        except ImportError:
            self.skipTest("rvx._native extension is not installed")
        with engine_directory() as directory:
            engine = RvxEngine(directory, 4, False)
            try:
                project = json.loads(engine.create_project("project"))
                experiment = json.loads(
                    engine.create_experiment(project["id"], "experiment")
                )
                run = json.loads(
                    engine.create_run(
                        experiment["id"],
                        "run",
                        json.dumps({"seed": 1}),
                    )
                )
                descriptor = {
                    "protocol_version": 1,
                    "project": "project",
                    "experiment": "experiment",
                    "run_id": run["id"],
                    "attempt_id": "attempt-1",
                    "role": "learner",
                    "source_session_id": "session-1",
                    "schema_version": 1,
                }
                payload = {
                    "protocol_version": 1,
                    "source_session_id": "session-1",
                    "oldest_sequence": 0,
                    "next_sequence": 2,
                    "dropped_before": None,
                    "snapshots": [
                        {
                            "source_session_id": "session-1",
                            "sequence": sequence,
                            "observed_at_ns": sequence + 1,
                            "schema_version": 1,
                            "axes": {"optimizer_step": sequence},
                            "state": {"progress": {"loss": 1 / (sequence + 1)}},
                        }
                        for sequence in (0, 1)
                    ],
                }
                requested_cursors = []

                class RoleHandler(BaseHTTPRequestHandler):
                    def do_GET(self):
                        url = urlsplit(self.path)
                        if url.path == "/learner/v1/snapshots/descriptor":
                            result = descriptor
                        elif url.path == "/learner/v1/snapshots/history":
                            cursor = int(parse_qs(url.query)["after"][0])
                            requested_cursors.append(cursor)
                            result = {
                                **payload,
                                "snapshots": [
                                    point
                                    for point in payload["snapshots"]
                                    if point["sequence"] >= cursor
                                ],
                            }
                        else:
                            self.send_error(404)
                            return
                        body = json.dumps(result).encode()
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)

                    def log_message(self, _format, *args):
                        pass

                with ThreadingHTTPServer(("127.0.0.1", 0), RoleHandler) as server:
                    thread = threading.Thread(target=server.serve_forever)
                    thread.start()
                    try:
                        source = json.loads(
                            engine.register_source(
                                run["id"],
                                "attempt-1",
                                "learner",
                                f"http://127.0.0.1:{server.server_port}/learner/",
                                "node-1",
                                0,
                                50,
                                400,
                            )
                        )
                        engine.start()
                        deadline = time.monotonic() + 10
                        while time.monotonic() < deadline:
                            if 2 in requested_cursors:
                                break
                            time.sleep(0.02)
                        self.assertIn(2, requested_cursors)
                        self.assertEqual(json.loads(engine.stats_json())["snapshots"], 2)
                        draining = json.loads(
                            engine.update_source_state(source["id"], "draining")
                        )
                        ended = json.loads(
                            engine.update_source_state(source["id"], "ended")
                        )
                    finally:
                        engine.close()
                        server.shutdown()
                        thread.join(timeout=5)
                        self.assertFalse(thread.is_alive())
                engine = RvxEngine(directory, 4, False)
                query = {
                    "run_ids": [run["id"]],
                    "paths": ["/progress/loss"],
                    "axis": "optimizer_step",
                    "max_points": 100,
                }
                result = json.loads(engine.snapshot_query(json.dumps(query)))
                latest = json.loads(
                    engine.snapshot_latest(json.dumps({"run_id": run["id"]}))
                )
                history = json.loads(
                    engine.snapshot_history(json.dumps({"run_id": run["id"]}))
                )
                running = json.loads(engine.update_run_status(run["id"], "running"))
                finished = json.loads(engine.update_run_status(run["id"], "finished"))
                engine.close()
                engine = RvxEngine(directory, 4, False)
                recovered = json.loads(engine.snapshot_query(json.dumps(query)))
            finally:
                engine.close()

        self.assertEqual(draining["state"], "draining")
        self.assertEqual(ended["state"], "ended")
        self.assertEqual(running["status"], "running")
        self.assertEqual(finished["status"], "finished")
        self.assertEqual(result["series"][0]["values"], [1.0, 0.5])
        self.assertEqual(
            latest["snapshots"][0]["state"],
            {"progress": {"loss": 0.5}},
        )
        self.assertEqual(len(history["snapshots"]), 2)
        self.assertEqual(recovered["series"][0]["values"], [1.0, 0.5])

    def test_empty_catalog_and_removed_scalar_interfaces(self):
        from rvx._native import RvxEngine

        with engine_directory() as directory:
            engine = RvxEngine(directory, 2, False)
            try:
                project = json.loads(engine.create_project("project"))
                experiment = json.loads(
                    engine.create_experiment(project["id"], "experiment")
                )
                run = json.loads(engine.create_run(experiment["id"], "empty", "{}"))
                catalog = json.loads(
                    engine.chart_catalog(json.dumps({"run_ids": [run["id"]]}))
                )
                self.assertEqual(catalog["metrics"], [])
                self.assertEqual(catalog["runs"][0]["snapshot_count"], 0)
                for method in (
                    "legacy_query_json",
                    "legacy_query_summaries_json",
                    "legacy_query_arrow",
                    "compact",
                ):
                    self.assertFalse(hasattr(engine, method))
            finally:
                engine.close()

    def test_binding_has_no_import_or_direct_ingestion_entry_points(self):
        from rvx._native import RvxEngine

        for owner in (RvxEngine, RvxService):
            for name in (
                "import_hostmon_history",
                "register_archived_source",
                "ingest_json",
            ):
                with self.subTest(owner=owner.__name__, method=name):
                    self.assertFalse(hasattr(owner, name))

    def test_registration_rejects_file_sources(self):
        from rvx._native import RvxEngine

        with engine_directory() as directory:
            engine = RvxEngine(directory, 4, False)
            try:
                project = json.loads(engine.create_project("project"))
                experiment = json.loads(
                    engine.create_experiment(project["id"], "experiment")
                )
                run = json.loads(engine.create_run(experiment["id"], "run", "{}"))
                for endpoint in ("file:///metrics.jsonl", "archive://hostmon-history"):
                    with self.subTest(endpoint=endpoint), self.assertRaisesRegex(
                        RuntimeError, r"HTTP\(S\)"
                    ):
                        engine.register_source(
                            run["id"],
                            "attempt-1",
                            "learner",
                            endpoint,
                        )
                self.assertEqual(json.loads(engine.list_sources()), [])
            finally:
                engine.close()

    def test_disabled_engine_does_not_open_storage(self):
        service = RvxService(
            RvxSettings(
                enabled=False,
                directory=Path("/unused"),
                scrape_concurrency=1,
            )
        )
        self.assertFalse(service.enabled)
        with self.assertRaises(RvxError):
            service.stats()
        service.close()

    def test_ensures_named_hierarchy_without_duplicates(self):
        with engine_directory() as directory:
            service = RvxService(
                RvxSettings(
                    enabled=True,
                    directory=Path(directory),
                    scrape_concurrency=2,
                )
            )
            try:
                service.start()
                service.start()
                first = service.ensure_hierarchy(
                    "demo",
                    "experiment",
                    "run",
                    {"source": "test"},
                )
                second = service.ensure_hierarchy(
                    "demo",
                    "experiment",
                    "run",
                    {"source": "test"},
                )
            finally:
                service.close()
        self.assertEqual(first, second)

    def test_settings_require_explicit_storage_and_positive_limits(self):
        with self.assertRaises(TypeError):
            RvxSettings()
        with self.assertRaises(ValueError):
            RvxSettings(directory=Path("/unused"), scrape_concurrency=0)
        self.assertTrue(RvxSettings(directory=Path("/unused")).enabled)


if __name__ == "__main__":
    unittest.main()
