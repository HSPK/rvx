from __future__ import annotations

import json
import io
import os
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from rvx import RvxError, RvxService, RvxSettings
from rvx.cli import api_request, build_parser, execute, main


def engine_directory():
    """Keep isolated test storage under the project, never in user state."""
    return tempfile.TemporaryDirectory(dir=Path(__file__).parent)


class RvxBindingTests(unittest.TestCase):
    """Validate the coarse Python interface against the native engine."""

    def test_pulls_snapshots_and_recovers_history(self):
        """Exercise prefixed role URLs and persisted snapshot state across restart."""
        try:
            from rvx._native import RvxEngine
        except ImportError:
            self.skipTest("rvx._native extension is not installed")
        with engine_directory() as directory:
            engine = RvxEngine(directory, 100, 4, False)
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
                        """Expose full replacement snapshots using the Pull protocol."""
                        url = urlsplit(self.path)
                        if url.path == "/learner/v1/snapshots/descriptor":
                            result = descriptor
                        elif url.path == "/learner/v1/snapshots/history":
                            cursor = int(parse_qs(url.query)["after"][0])
                            requested_cursors.append(cursor)
                            result = {
                                **payload,
                                "snapshots": [
                                    point for point in payload["snapshots"]
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
                        """Suppress routine HTTP access logs for the test fixture."""

                with ThreadingHTTPServer(("127.0.0.1", 0), RoleHandler) as server:
                    thread = threading.Thread(target=server.serve_forever)
                    thread.start()
                    try:
                        source = json.loads(engine.register_source(
                            run["id"], "attempt-1", "learner",
                            f"http://127.0.0.1:{server.server_port}/learner/",
                            "node-1", 0, 50, 400,
                        ))
                        engine.start()
                        deadline = time.monotonic() + 10
                        while time.monotonic() < deadline:
                            if 2 in requested_cursors:
                                break
                            time.sleep(0.02)
                        self.assertIn(2, requested_cursors, "scraper did not advance its cursor")
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
                engine = RvxEngine(directory, 100, 4, False)
                query = {
                    "run_ids": [run["id"]],
                    "paths": ["/progress/loss"],
                    "axis": "optimizer_step",
                    "max_points": 100,
                }
                result = json.loads(engine.snapshot_query(json.dumps(query)))
                latest = json.loads(engine.snapshot_latest(json.dumps({"run_id": run["id"]})))
                history = json.loads(engine.snapshot_history(json.dumps({"run_id": run["id"]})))
                running = json.loads(
                    engine.update_run_status(run["id"], "running")
                )
                finished = json.loads(
                    engine.update_run_status(run["id"], "finished")
                )
                engine.close()
                engine = RvxEngine(directory, 100, 4, False)
                recovered = json.loads(engine.snapshot_query(json.dumps(query)))
            finally:
                engine.close()

        self.assertEqual(draining["state"], "draining")
        self.assertEqual(ended["state"], "ended")
        self.assertEqual(running["status"], "running")
        self.assertEqual(finished["status"], "finished")
        self.assertEqual(result["series"][0]["values"], [1.0, 0.5])
        self.assertEqual(latest["snapshots"][0]["state"], {"progress": {"loss": 0.5}})
        self.assertEqual(len(history["snapshots"]), 2)
        self.assertEqual(recovered["series"][0]["values"], [1.0, 0.5])

    def test_legacy_numeric_queries_are_explicit_and_read_only(self):
        """Keep old query formats readable without inventing snapshot history."""
        from rvx._native import RvxEngine
        with engine_directory() as directory:
            engine = RvxEngine(directory, 100, 2, False)
            try:
                project = json.loads(engine.create_project("project"))
                experiment = json.loads(engine.create_experiment(project["id"], "experiment"))
                run = json.loads(engine.create_run(experiment["id"], "legacy", "{}"))
                query = json.dumps({"run_id": run["id"], "metrics": ["loss"]})
                self.assertEqual(json.loads(engine.legacy_query_json(query))["series"], [])
                arrow = bytes(engine.legacy_query_arrow(query))
                self.assertGreater(len(arrow), 100)
                self.assertEqual(arrow[:4], b"\xff\xff\xff\xff")
                engine.legacy_query_summaries_json(json.dumps({"run_ids": [run["id"]], "metrics": ["loss"]}))
                self.assertFalse(hasattr(engine, "compact"))
                self.assertEqual(json.loads(engine.stats_json())["snapshots"], 0)
            finally:
                engine.close()

    def test_binding_has_no_import_or_direct_ingestion_entry_points(self):
        """Keep Python limited to control and bulk query operations."""
        try:
            from rvx._native import RvxEngine
        except ImportError:
            self.skipTest("rvx._native extension is not installed")
        for owner in (RvxEngine, RvxService):
            for name in ("import_hostmon_history", "register_archived_source", "ingest_json"):
                with self.subTest(owner=owner.__name__, method=name):
                    self.assertFalse(hasattr(owner, name))

    def test_registration_rejects_file_sources(self):
        """Reject unsupported transports before persisting Source metadata."""
        try:
            from rvx._native import RvxEngine
        except ImportError:
            self.skipTest("rvx._native extension is not installed")
        with engine_directory() as directory:
            engine = RvxEngine(directory, 100, 4, False)
            try:
                project = json.loads(engine.create_project("project"))
                experiment = json.loads(engine.create_experiment(project["id"], "experiment"))
                run = json.loads(engine.create_run(experiment["id"], "run", "{}"))
                for endpoint in ("file:///metrics.jsonl", "archive://hostmon-history"):
                    with self.subTest(endpoint=endpoint), self.assertRaisesRegex(RuntimeError, r"HTTP\(S\)"):
                        engine.register_source(run["id"], "attempt-1", "learner", endpoint)
                self.assertEqual(json.loads(engine.list_sources()), [])
            finally:
                engine.close()

    def test_disabled_engine_does_not_open_storage(self):
        """Keep explicitly disabled Python callers free of native startup."""
        settings = RvxSettings(
            enabled=False,
            directory=Path("/unused"),
            hot_capacity=1,
            scrape_concurrency=1,
        )

        service = RvxService(settings)

        self.assertFalse(service.enabled)
        with self.assertRaises(RvxError):
            service.stats()
        service.close()

    def test_ensures_named_hierarchy_without_duplicates(self):
        """Reuse matching hierarchy records across repeated setup calls."""
        try:
            from rvx._native import RvxEngine  # noqa: F401
        except ImportError:
            self.skipTest("rvx._native extension is not installed")
        with engine_directory() as directory:
            service = RvxService(
                RvxSettings(
                    enabled=True,
                    directory=Path(directory),
                    hot_capacity=100,
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
        """Reject invalid ownership settings without touching a directory."""
        with self.assertRaises(TypeError):
            RvxSettings()
        for field in ("hot_capacity", "scrape_concurrency"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                RvxSettings(directory=Path("/unused"), **{field: 0})
        self.assertTrue(RvxSettings(directory=Path("/unused")).enabled)


class RvxCLITests(unittest.TestCase):
    """Validate the public Rvx CLI request mapping."""

    def setUp(self):
        """Isolate CLI defaults from the invoking shell's configuration."""
        self.environment = patch.dict(os.environ, {"RVX_URL": "http://127.0.0.1:9110"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_explicit_url_and_environment_override_the_default(self):
        """Route requests to an explicitly configured standalone API."""
        with patch.dict(os.environ, {"RVX_URL": "http://localhost:9220"}):
            self.assertEqual(build_parser().parse_args(["status"]).url, "http://localhost:9220")
            self.assertEqual(
                build_parser().parse_args(["--url", "http://localhost:9330", "status"]).url,
                "http://localhost:9330",
            )

    def test_query_defaults_to_time_and_preserves_explicit_logical_axes(self):
        """Use time by default without overriding a caller's selected training axis."""
        for flags, expected in [([], "wall_time"), (["--axis", "optimizer_step"], "optimizer_step")]:
            args = build_parser().parse_args(
                ["query", "--run", "run-1", "--field", "/progress/loss", *flags]
            )
            with self.subTest(axis=expected), patch("rvx.cli.api_request") as request:
                execute(args)
                self.assertEqual(request.call_args.kwargs["payload"]["axis"], expected)
                self.assertEqual(request.call_args.args[1], "/api/snapshots/query")
                self.assertEqual(request.call_args.kwargs["payload"]["paths"], ["/progress/loss"])

    def test_snapshot_and_explicit_legacy_cli_requests(self):
        for flags, path, expected in [
            (["snapshots", "latest", "--run", "r", "--limit", "2", "--after-source-id", "s"],
             "/api/snapshots/latest", {"run_id": "r", "limit": 2, "after_source_id": "s"}),
            (["snapshots", "history", "--run", "r", "--before-id", "20", "--from", "10"],
             "/api/snapshots/history", {"run_id": "r", "before_id": 20, "from": 10}),
            (["snapshots", "diff", "--before-id", "2", "--after-id", "3"],
             "/api/snapshots/diff", {"before_id": 2, "after_id": 3}),
            (["legacy-query", "--run", "r", "--metric", "loss"],
             "/api/experiments/query", {"run_id": "r", "metrics": ["loss"]}),
        ]:
            with self.subTest(flags=flags), patch("rvx.cli.api_request") as request:
                execute(build_parser().parse_args(flags))
                self.assertEqual(request.call_args.args[1], path)
                self.assertEqual(request.call_args.kwargs["method"], "POST")
                for key, value in expected.items():
                    self.assertEqual(request.call_args.kwargs["payload"][key], value)

    def test_http_request_mapping_and_error_reporting(self):
        """Exercise real CLI HTTP requests against an isolated role-free fixture."""
        observed = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                """Return status or a bounded upstream error fixture."""
                observed.append((self.command, self.path))
                body = json.dumps({"projects": 2} if self.path.endswith("/stats") else {"error": "missing"}).encode()
                self.send_response(200 if self.path.endswith("/stats") else 404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format, *args):
                """Suppress fixture access logging."""

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                args = build_parser().parse_args(["--url", base, "status"])
                self.assertEqual(execute(args), {"projects": 2})
                with self.assertRaisesRegex(RuntimeError, "missing"):
                    api_request(base, "/api/missing")
            finally:
                server.shutdown()
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
        self.assertEqual(observed, [("GET", "/api/experiments/stats"), ("GET", "/api/missing")])
        with self.assertRaisesRegex(RuntimeError, "cannot reach Rvx API"):
            api_request(base, "/api/experiments/stats")

    def test_invalid_config_and_api_failures_are_reported(self):
        """Reject malformed CLI configuration and return a failing exit status."""
        for config in ("{", "[]"):
            args = build_parser().parse_args(
                ["runs", "create", "--experiment", "experiment-1", "--config", config, "run"]
            )
            with self.assertRaises(RuntimeError):
                execute(args)
        with patch("rvx.cli.api_request", side_effect=RuntimeError("offline")), patch(
            "sys.stderr", new_callable=io.StringIO
        ) as output:
            self.assertEqual(main(["status"]), 1)
        self.assertIn("offline", output.getvalue())

    def test_maps_project_creation_to_the_control_api(self):
        """Send project creation through the shared REST surface."""
        args = build_parser().parse_args(["projects", "create", "demo"])

        with patch(
            "rvx.cli.api_request",
            return_value={"id": "project-1"},
        ) as request:
            result = execute(args)

        self.assertEqual(result["id"], "project-1")
        request.assert_called_once_with(
            "http://127.0.0.1:9110",
            "/api/experiments/projects",
            method="POST",
            payload={"name": "demo"},
        )

    def test_maps_run_status_update_to_the_control_api(self):
        """Send explicit terminal Run state through the shared REST API."""
        args = build_parser().parse_args(
            ["runs", "update", "--run", "run-1", "--status", "finished"]
        )

        with patch(
            "rvx.cli.api_request",
            return_value={"id": "run-1", "status": "finished"},
        ) as request:
            result = execute(args)

        self.assertEqual(result["status"], "finished")
        request.assert_called_once_with(
            "http://127.0.0.1:9110",
            "/api/experiments/runs/run-1",
            method="PATCH",
            payload={"status": "finished"},
        )

    def test_maps_source_state_update_to_the_control_api(self):
        """Send Source draining through the shared REST API."""
        args = build_parser().parse_args(
            ["sources", "update", "--source", "source-1", "--state", "draining"]
        )

        with patch(
            "rvx.cli.api_request",
            return_value={"id": "source-1", "state": "draining"},
        ) as request:
            result = execute(args)

        self.assertEqual(result["state"], "draining")
        request.assert_called_once_with(
            "http://127.0.0.1:9110",
            "/api/experiments/sources/source-1",
            method="PATCH",
            payload={"state": "draining"},
        )


if __name__ == "__main__":
    unittest.main()
