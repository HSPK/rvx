from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qsl

if TYPE_CHECKING:
    from aiohttp.web import Application
    from .source import Source


_PATHS = (
    "/v1/snapshots/descriptor",
    "/v1/snapshots/latest",
    "/v1/snapshots/history",
    "/healthz",
)
_MAX_QUERY_BYTES = 4096
_MAX_CURSOR = 2**63 - 1


@dataclass(frozen=True)
class _Response:
    """Carry already encoded bytes across either borrowed web transport."""

    status: int
    body: bytes
    content_type: bytes = b"application/json"

    def headers(self) -> list[tuple[bytes, bytes]]:
        """Apply the same no-cache and content framing policy to both adapters."""
        headers = [
            (b"content-type", self.content_type),
            (b"content-length", str(len(self.body)).encode("ascii")),
            (b"cache-control", b"no-store"),
            (b"x-content-type-options", b"nosniff"),
        ]
        if self.status == 405:
            headers.append((b"allow", b"GET, HEAD"))
        return headers


def _error(status: int, message: str) -> _Response:
    """Return an explicit protocol error without fabricating successful empty data."""
    return _Response(status, json.dumps(
        {"error": message}, ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8"))


def _cursor_query(query: bytes) -> tuple[int, int]:
    """Reject duplicate, unknown, nondecimal, or oversized cursor parameters."""
    if len(query) > _MAX_QUERY_BYTES:
        raise ValueError("snapshot query exceeds 4096 bytes")
    values = {"after": 0, "limit": 64}
    seen: set[str] = set()
    for key, value in parse_qsl(
        query.decode("ascii"), keep_blank_values=True, strict_parsing=True,
        encoding="utf-8", errors="strict", max_num_fields=2,
    ):
        if key not in values or key in seen:
            raise ValueError("history accepts only one after and one limit parameter")
        if not value.isascii() or not value.isdecimal() or len(value) > 20:
            raise ValueError(f"{key} must be an unsigned decimal integer")
        values[key] = int(value)
        seen.add(key)
    if values["after"] > _MAX_CURSOR or not 1 <= values["limit"] <= 256:
        raise ValueError("after must fit a non-negative signed cursor and limit must be 1..256")
    return values["after"], values["limit"]


def _read_response(source: Source, path: str, query: bytes, method: str) -> _Response:
    """Read through the native byte boundary; no socket or host lifecycle is owned here."""
    if path not in _PATHS:
        return _error(404, "snapshot route not found")
    if method not in ("GET", "HEAD"):
        return _error(405, "snapshot endpoints support GET and HEAD only")
    try:
        if path == "/v1/snapshots/history":
            after, limit = _cursor_query(query)
            return _Response(200, source.history_bytes(after=after, limit=limit))
        if path == "/v1/snapshots/latest":
            return _Response(200, source.latest_bytes())
        descriptor = source.descriptor_bytes()
        if path == "/healthz":
            return _Response(200, b"ok\n", b"text/plain; charset=utf-8")
        return _Response(200, descriptor)
    except (TypeError, ValueError) as error:
        return _error(400, str(error))
    except RuntimeError as error:
        return _error(503, str(error))


class SourceASGI:
    """Borrow a Source while the ASGI host owns serving, middleware, and shutdown."""

    def __init__(self, source: Source):
        """Keep the Source alive without opening any socket or native HTTP runtime."""
        self._source = source

    async def __call__(
        self,
        scope: Mapping[str, Any],
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        """Dispatch bounded HTTP reads off the host loop and preserve mount prefixes."""
        kind = scope["type"]
        if kind == "lifespan":
            await self._lifespan(receive, send)
            return
        if kind == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        if kind != "http":
            raise ValueError(f"unsupported ASGI scope: {kind}")
        path = scope["path"]
        root = scope.get("root_path", "").rstrip("/")
        if root and (path == root or path.startswith(root + "/")):
            path = path[len(root):] or "/"
        method = scope["method"].upper()
        response = await asyncio.to_thread(
            _read_response, self._source, path, scope.get("query_string", b""), method,
        )
        await send({
            "type": "http.response.start",
            "status": response.status,
            "headers": response.headers(),
        })
        await send({
            "type": "http.response.body",
            "body": b"" if method == "HEAD" else response.body,
        })

    @staticmethod
    async def _lifespan(
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        """Acknowledge host events without closing or sealing the borrowed Source."""
        while True:
            event = await receive()
            if event["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif event["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
            else:
                raise ValueError(f"unsupported ASGI lifespan event: {event['type']}")


def _prefix(value: str) -> str:
    """Normalize a literal mount path without interpreting URL or route-template syntax."""
    if not isinstance(value, str):
        raise TypeError("prefix must be a string path")
    if value and not value.startswith("/"):
        raise ValueError("prefix must be empty or begin with '/'")
    if any(character in value for character in "?#{}\\%") or "//" in value:
        raise ValueError("prefix must be a literal URL path")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("prefix cannot contain control characters")
    if any(part in (".", "..") for part in value.split("/")):
        raise ValueError("prefix cannot contain dot segments")
    return value.rstrip("/")


def attach_aiohttp(source: Source, app: Application, *, prefix: str) -> None:
    """Register only snapshot paths before startup, without replacing host routes."""
    from aiohttp import web

    prefix = _prefix(prefix)
    if not isinstance(app, web.Application):
        raise TypeError("app must be an aiohttp.web.Application")
    if app.router.frozen:
        raise RuntimeError("attach the Source before the aiohttp router is frozen")
    paths = tuple(prefix + path for path in _PATHS)
    for resource in app.router.resources():
        info = resource.get_info()
        pattern = info.get("pattern")
        mounted = info.get("prefix")
        if any(
            resource.canonical == path
            or (pattern is not None and pattern.fullmatch(path))
            or (mounted is not None and (path == mounted or path.startswith(mounted.rstrip("/") + "/")))
            for path in paths
        ):
            raise ValueError("snapshot paths overlap existing routes; attach before catch-all routes")

    async def handle(request: web.Request) -> web.Response:
        """Send native JSON bytes while keeping serialization off the host event loop."""
        response = await asyncio.to_thread(
            _read_response, source, request.path[len(prefix):],
            request.rel_url.raw_query_string.encode("ascii"), request.method,
        )
        return web.Response(
            status=response.status, body=response.body,
            headers={key.decode("ascii"): value.decode("ascii") for key, value in response.headers()},
        )

    app.add_routes([
        *(web.route("*", path, handle) for path in paths),
        web.route("*", prefix + "/v1/snapshots/{path:.*}", handle),
    ])
