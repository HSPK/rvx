from __future__ import annotations

import asyncio
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from aiohttp import ClientSession, web
import httpx
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Mount, Route

from rvx import Source, SnapshotEvent, RvxService, RvxSettings


def make_source(**overrides):
    return Source(**{
        "project": "project", "experiment": "experiment",
        "run_id": "run-1", "role": "learner", **overrides,
    })


class ASGIMountTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.source = make_source(capacity=2)

        async def existing(_request):
            return PlainTextResponse("host-alive")

        child = Starlette(routes=[Mount("/rvx", app=self.source.asgi())])
        self.app = Starlette(routes=[Route("/existing", existing), Mount("/nested", app=child)])
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://mounted.test",
        )
        self.prefix = "/nested/rvx"

    async def asyncTearDown(self):
        await self.client.aclose()
        await asyncio.to_thread(self.source.close)

    async def test_nested_mount_preserves_original_host_routes_and_has_no_listener(self):
        self.assertEqual((await self.client.get("/existing")).text, "host-alive")
        response = await self.client.get(self.prefix + "/v1/snapshots/descriptor")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["source_session_id"], self.source.source_session_id)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual((await self.client.get(self.prefix + "/v1/snapshots/latest")).status_code, 503)
        self.assertEqual(
            (await self.client.get(self.prefix + "/v1/snapshots/history")).json()["snapshots"], [],
        )
        with self.assertRaises(RuntimeError):
            _ = self.source.endpoint

    async def test_full_replacement_exact_bytes_paging_and_retention_gaps(self):
        self.source.capture({"discarded": True})
        self.source.capture({"nested": [False, None, 2**64 - 1], "removed": 1}, observed_at_ns=12)
        self.source.capture({"phase": "idle"}, observed_at_ns=13)
        response = await self.client.get(self.prefix + "/v1/snapshots/history?after=0&limit=1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.source.history_bytes(after=0, limit=1))
        page = response.json()
        self.assertEqual((page["oldest_sequence"], page["dropped_before"], page["next_sequence"]), (1, 1, 2))
        self.assertEqual(page["snapshots"][0]["state"]["nested"][-1], 2**64 - 1)
        current = await self.client.get(self.prefix + "/v1/snapshots/latest")
        self.assertEqual(current.json()["state"], {"phase": "idle"})
        self.assertEqual(current.content, self.source.latest_bytes())
        head = await self.client.head(self.prefix + "/v1/snapshots/latest")
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")
        self.assertEqual(int(head.headers["content-length"]), len(current.content))

    async def test_validation_read_only_and_closed_source_do_not_stop_host(self):
        for query in (
            "after=-1", "after=abc", "after=1", "limit=0", "limit=257",
            "after=0&after=0", "unexpected=1", "limit=", "after=%FF", "after=%EF%BC%91",
        ):
            with self.subTest(query=query):
                response = await self.client.get(self.prefix + "/v1/snapshots/history?" + query)
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.json())
        response = await self.client.post(self.prefix + "/v1/snapshots/latest", json={"state": {}})
        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.headers["allow"], "GET, HEAD")
        self.assertEqual((await self.client.get(self.prefix + "/v1/metrics/points")).status_code, 404)
        self.assertEqual(self.source.stats().next_sequence, 0)
        self.source.capture({"phase": "final"})
        self.source.seal()
        self.assertEqual((await self.client.get(self.prefix + "/v1/snapshots/latest")).status_code, 200)
        self.source.close()
        self.assertEqual((await self.client.get(self.prefix + "/v1/snapshots/latest")).status_code, 503)
        self.assertEqual((await self.client.get("/existing")).text, "host-alive")

    async def test_source_read_serialization_does_not_block_the_host_loop(self):
        entered = threading.Event()
        release = threading.Event()

        def delayed():
            entered.set()
            if not release.wait(timeout=3):
                raise RuntimeError("test worker was not released")
            return b'{"state":{}}'

        with patch.object(self.source, "latest_bytes", side_effect=delayed):
            pending = asyncio.create_task(self.client.get(self.prefix + "/v1/snapshots/latest"))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                response = await asyncio.wait_for(self.client.get("/existing"), timeout=0.5)
                self.assertEqual(response.text, "host-alive")
            finally:
                release.set()
                self.assertEqual((await pending).status_code, 200)

    async def test_lifespan_and_websocket_do_not_take_source_ownership(self):
        messages = iter([{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}])
        sent = []

        async def receive():
            return next(messages)

        async def send(event):
            sent.append(event)

        await self.source.asgi()({"type": "lifespan"}, receive, send)
        self.assertEqual(sent, [
            {"type": "lifespan.startup.complete"}, {"type": "lifespan.shutdown.complete"},
        ])
        self.assertEqual(self.source.capture({"after_host_shutdown": True}).sequence, 0)
        sent.clear()
        await self.source.asgi()({"type": "websocket"}, receive, send)
        self.assertEqual(sent, [{"type": "websocket.close", "code": 1008}])

    async def test_stopping_native_transport_does_not_stop_mounted_reads(self):
        self.source.capture({"mode": "both"})
        self.source.serve()
        self.assertEqual(
            (await self.client.get(self.prefix + "/v1/snapshots/latest")).json()["state"],
            {"mode": "both"},
        )
        await asyncio.to_thread(self.source.stop_serving)
        self.source.capture({"mode": "mounted-only"})
        self.assertEqual(
            (await self.client.get(self.prefix + "/v1/snapshots/latest")).json()["state"],
            {"mode": "mounted-only"},
        )


class AiohttpMountTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.source = make_source()
        self.app = web.Application()

        async def existing(_request):
            return web.Response(text="host-alive")

        self.app.router.add_get("/existing", existing)
        self.source.attach_aiohttp(self.app)
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        await web.TCPSite(self.runner, "127.0.0.1", 0).start()
        host, port = self.runner.addresses[0][:2]
        self.endpoint = f"http://{host}:{port}"
        self.client = ClientSession()

    async def asyncTearDown(self):
        await self.client.close()
        await self.runner.cleanup()
        await asyncio.to_thread(self.source.close)

    async def test_mount_bytes_head_errors_and_host_lifetime(self):
        self.source.capture({"full": {"workers": [1, None, True]}, "large": 2**64 - 1})
        async with self.client.get(self.endpoint + "/existing") as response:
            self.assertEqual(await response.text(), "host-alive")
        async with self.client.get(self.endpoint + "/rvx/v1/snapshots/latest") as response:
            self.assertEqual(response.status, 200)
            payload = await response.read()
            self.assertEqual(payload, self.source.latest_bytes())
            self.assertEqual(json.loads(payload)["state"]["large"], 2**64 - 1)
        async with self.client.head(self.endpoint + "/rvx/v1/snapshots/latest") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.read(), b"")
            self.assertEqual(int(response.headers["Content-Length"]), len(payload))
        for suffix in ("?limit=0", "?after=-1", "?after=2", "?after=0&after=0", "?unknown=1"):
            async with self.client.get(self.endpoint + "/rvx/v1/snapshots/history" + suffix) as response:
                self.assertEqual(response.status, 400)
        async with self.client.post(self.endpoint + "/rvx/v1/snapshots/history", json={}) as response:
            self.assertEqual(response.status, 405)
        async with self.client.get(self.endpoint + "/rvx/v1/snapshots/missing") as response:
            self.assertEqual(response.status, 404)
        self.source.close()
        async with self.client.get(self.endpoint + "/existing") as response:
            self.assertEqual(response.status, 200)
        async with self.client.get(self.endpoint + "/rvx/v1/snapshots/latest") as response:
            self.assertEqual(response.status, 503)

    async def test_existing_native_consumer_pulls_from_hosted_prefix(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            service = await asyncio.to_thread(
                RvxService, RvxSettings(directory=Path(directory), scrape_concurrency=1),
            )
            try:
                hierarchy = await asyncio.to_thread(
                    service.ensure_hierarchy, "project", "experiment", "mounted", {},
                )
                run = hierarchy["run"]["id"]
                with make_source(run_id=run) as source:
                    app = web.Application()
                    source.attach_aiohttp(app, prefix="/roles/learner/")
                    runner = web.AppRunner(app)
                    await runner.setup()
                    try:
                        await web.TCPSite(runner, "127.0.0.1", 0).start()
                        host, port = runner.addresses[0][:2]
                        source.capture_batch([
                            SnapshotEvent({"workers": [True], "value": 1}, 10),
                            SnapshotEvent({"workers": [], "value": None}, 20),
                            SnapshotEvent({"workers": []}, 30),
                        ])
                        source.seal()
                        service.register_source({
                            "run_id": run, "attempt_id": "attempt-1", "role": "learner",
                            "endpoint": f"http://{host}:{port}/roles/learner",
                            "scrape_interval_ms": 50, "timeout_ms": 400,
                        })
                        service.start()
                        deadline = time.monotonic() + 10
                        while time.monotonic() < deadline and service.stats()["snapshots"] < 3:
                            await asyncio.sleep(0.02)
                        self.assertEqual(service.stats()["snapshots"], 3)
                        self.assertEqual(service.stats()["cursor_gaps"], 0)
                        self.assertEqual(service.stats()["scrape_failures"], 0)
                        self.assertEqual(
                            service.snapshot_query({"run_ids": [run], "paths": ["/value"]})["series"][0]["values"],
                            [1, None, None],
                        )
                        self.assertEqual(service.snapshot_latest({"run_id": run})["snapshots"][0]["state"], {"workers": []})
                    finally:
                        await asyncio.to_thread(service.close)
                        await runner.cleanup()
                    self.assertEqual(source.stats().next_sequence, 3)
            finally:
                service.close()

    async def test_attach_conflicts_fail_before_changing_router(self):
        async def existing(_request):
            return web.Response()

        original = web.Application()
        original.router.add_get("/rvx/v1/snapshots/latest", existing)
        count = len(list(original.router.routes()))
        with self.assertRaises(ValueError):
            self.source.attach_aiohttp(original)
        self.assertEqual(len(list(original.router.routes())), count)
        for prefix in ("relative", "/bad?query", "/../rvx", "/bad/{name}", "/bad%20prefix", "//rvx"):
            app = web.Application()
            with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                self.source.attach_aiohttp(app, prefix=prefix)
            self.assertEqual(len(list(app.router.routes())), 0)
        with self.assertRaisesRegex(RuntimeError, "frozen"):
            self.source.attach_aiohttp(self.app, prefix="/other")
        catch_all = web.Application()
        catch_all.router.add_get("/{path:.*}", existing)
        with self.assertRaisesRegex(ValueError, "catch-all"):
            self.source.attach_aiohttp(catch_all)

    async def test_multiple_sources_share_one_host_without_aliasing_sessions(self):
        app = web.Application()
        with make_source(role="actor") as other:
            self.source.attach_aiohttp(app, prefix="/learner")
            other.attach_aiohttp(app, prefix="/actor")
            runner = web.AppRunner(app)
            await runner.setup()
            try:
                await web.TCPSite(runner, "127.0.0.1", 0).start()
                host, port = runner.addresses[0][:2]
                self.source.capture({"role": "learner"})
                other.capture({"role": "actor"})
                for role, source in (("learner", self.source), ("actor", other)):
                    async with self.client.get(f"http://{host}:{port}/{role}/v1/snapshots/latest") as response:
                        payload = await response.json()
                        self.assertEqual(payload["state"], {"role": role})
                        self.assertEqual(payload["source_session_id"], source.source_session_id)
                self.assertNotEqual(self.source.source_session_id, other.source_session_id)
            finally:
                await runner.cleanup()
            self.assertEqual(other.capture({"after_host_shutdown": True}).sequence, 1)
