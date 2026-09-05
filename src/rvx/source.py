from __future__ import annotations

import json
import math
import socket
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from numbers import Integral
from types import TracebackType
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from aiohttp.web import Application
    from .adapters import SourceASGI

MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
MAX_BATCH_BYTES = 16 * 1024 * 1024
MAX_BATCH_SNAPSHOTS = 256
MAX_DEPTH = 64
MAX_NODES = 100_000


@dataclass(frozen=True)
class SnapshotEvent:
    """A complete JSON object observed at one caller-chosen consistency boundary."""

    state: Mapping[str, Any]
    observed_at_ns: int | None = None
    axes: Mapping[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class CaptureReceipt:
    """Assigned sequence interval and cumulative history eviction count."""

    first_sequence: int
    next_sequence: int
    accepted: int
    dropped_snapshots: int

    @property
    def sequence(self) -> int:
        """Return the first captured sequence, including single-capture receipts."""
        return self.first_sequence


@dataclass(frozen=True)
class SourceStats:
    """Retained history accounting, cursor boundaries, and capture lifecycle."""

    buffered_snapshots: int
    buffered_bytes: int
    dropped_snapshots: int
    oldest_sequence: int
    next_sequence: int
    sealed: bool


class Source:
    """Own a snapshot stream independently of its optional HTTP transport."""

    def __init__(
        self,
        *,
        project: str,
        experiment: str,
        run_id: str,
        role: str,
        attempt_id: str = "attempt-1",
        rank: int | None = None,
        node_id: str | None = None,
        labels: Mapping[str, str] | None = None,
        schema_version: int = 1,
        capacity: int = 1_024,
        max_buffer_bytes: int = 64 * 1024 * 1024,
    ):
        """Allocate a fresh Session and native buffer without opening a listener."""
        from ._native import RvxSource

        for name, value, minimum, maximum in [
            ("capacity", capacity, 1, 1_000_000),
            ("max_buffer_bytes", max_buffer_bytes, 1, 1024 * 1024 * 1024),
            ("schema_version", schema_version, 1, 1),
        ]:
            if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
                raise ValueError(f"{name} must be an integer between {minimum} and {maximum}")
        if labels is not None and not isinstance(labels, Mapping):
            raise TypeError("labels must be a string mapping")
        for key, value in (labels or {}).items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise TypeError("labels must contain string keys and values")
        identity = {
            "project": project, "experiment": experiment, "run_id": run_id,
            "attempt_id": attempt_id, "role": role,
            "rank": None if rank is None else _integer(rank, "rank"),
            "node_id": socket.gethostname() if node_id is None else node_id,
            "labels": dict(labels or {}), "schema_version": schema_version,
        }
        self._native = RvxSource(
            json.dumps(identity, allow_nan=False, separators=(",", ":")),
            capacity, max_buffer_bytes,
        )
        self._batch_limit = min(capacity, MAX_BATCH_SNAPSHOTS)

    @property
    def endpoint(self) -> str:
        """Return the standalone URL; mounted endpoints belong to the host application."""
        return self._native.endpoint

    @property
    def source_session_id(self) -> str:
        """Return this instance's fresh, immutable Source-session identity."""
        return self._native.source_session_id

    def serve(self, *, host: str = "127.0.0.1", port: int = 0) -> Source:
        """Bind this producer's Pull API, not the central ``rvx serve`` daemon."""
        if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
            raise ValueError("port must be an integer between 0 and 65535")
        if not isinstance(host, str) or not host:
            raise ValueError("host must be an IP address")
        address = f"[{host}]" if ":" in host and not host.startswith("[") else host
        self._native.serve(f"{address}:{port}")
        return self

    def stop_serving(self) -> None:
        """Stop only the owned native listener, preserving captures and mounted readers."""
        self._native.stop_serving()

    def asgi(self) -> SourceASGI:
        """Expose a borrow-only ASGI application for mounting in FastAPI or Starlette."""
        from .adapters import SourceASGI
        return SourceASGI(self)

    def attach_aiohttp(self, app: Application, *, prefix: str = "/rvx") -> None:
        """Register snapshot routes without starting or owning the aiohttp application."""
        from .adapters import attach_aiohttp
        attach_aiohttp(self, app, prefix=prefix)

    def descriptor_bytes(self) -> bytes:
        """Serialize immutable protocol identity in Rust without starting HTTP."""
        return self._native.descriptor_bytes()

    def latest_bytes(self) -> bytes:
        """Read the last full state as Rust-encoded JSON, or fail before first capture."""
        return self._native.latest_bytes()

    def history_bytes(self, *, after: int = 0, limit: int = 64) -> bytes:
        """Read a bounded cursor page without copying state into Python object trees."""
        after = _integer(after, "after")
        limit = _integer(limit, "limit")
        if after < 0 or limit <= 0:
            raise ValueError("after must be non-negative and limit must be positive")
        return self._native.history_bytes(after, limit)

    def capture(
        self,
        state: Mapping[str, Any],
        *,
        observed_at_ns: int | None = None,
        axes: Mapping[str, int] | None = None,
    ) -> CaptureReceipt:
        """Capture a full replacement and return its sequence receipt; never merge."""
        return self.capture_batch([
            SnapshotEvent(state, observed_at_ns, {} if axes is None else axes),
        ])

    def capture_batch(self, events: Iterable[SnapshotEvent]) -> CaptureReceipt:
        """Validate all events before one atomic native append, without network I/O."""
        parts: list[str] = []
        byte_count = 2
        for event in events:
            if len(parts) >= self._batch_limit:
                raise ValueError(f"snapshot batch exceeds {self._batch_limit} snapshots")
            if not isinstance(event, SnapshotEvent):
                raise TypeError("capture_batch expects SnapshotEvent instances")
            payload = _event_payload(event)
            part = json.dumps(payload, allow_nan=False, ensure_ascii=False, separators=(",", ":"))
            length = len(part.encode("utf-8"))
            if length > MAX_SNAPSHOT_BYTES:
                raise ValueError("snapshot exceeds 4 MiB")
            byte_count += length + int(bool(parts))
            if byte_count > MAX_BATCH_BYTES:
                raise ValueError("snapshot batch exceeds 16 MiB")
            parts.append(part)
        return CaptureReceipt(**json.loads(self._native.capture_batch_json("[" + ",".join(parts) + "]")))

    def stats(self) -> SourceStats:
        """Return local retention and eviction counters, not remote acknowledgments."""
        return SourceStats(**json.loads(self._native.stats_json()))

    def seal(self) -> int:
        """Freeze captures and return the final cursor while HTTP remains readable."""
        return self._native.seal()

    def close(self) -> None:
        """Close the Source and its owned listener, never an attached host application."""
        self._native.close()

    def __enter__(self) -> Source:
        """Manage Source lifetime without implicitly starting an HTTP server."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Release this Source without treating shutdown as a consumer acknowledgment."""
        self.close()


def _event_payload(event: SnapshotEvent) -> dict[str, Any]:
    """Copy JSON state and validate axes before any native mutation is attempted."""
    if not isinstance(event.state, Mapping):
        raise TypeError("state must be a JSON object mapping")
    if not isinstance(event.axes, Mapping):
        raise TypeError("axes must be a mapping")
    if len(event.axes) > 64:
        raise ValueError("axes exceed 64 entries")
    axes = {}
    for name, value in event.axes.items():
        if not isinstance(name, str):
            raise TypeError("axis names must be strings")
        if not name.strip() or len(name.encode("utf-8")) > 256:
            raise ValueError("axis names must contain 1 to 256 UTF-8 bytes")
        axes[name] = _integer(value, f"axis {name!r}")
    return {
        "state": _json_value(event.state, 0, set(), [MAX_NODES]),
        "observed_at_ns": (
            None if event.observed_at_ns is None
            else _integer(event.observed_at_ns, "observed_at_ns")
        ),
        "axes": axes,
    }


def _json_value(value: Any, depth: int, ancestors: set[int], budget: list[int]) -> Any:
    """Copy only explicit JSON values; never invoke tensor/model conversion hooks."""
    budget[0] -= 1
    if budget[0] < 0:
        raise ValueError("state exceeds 100000 JSON nodes")
    if depth > MAX_DEPTH:
        raise ValueError("JSON nesting exceeds 64 levels")
    if isinstance(value, (Mapping, list)):
        if id(value) in ancestors:
            raise ValueError("state contains a circular reference")
        ancestors.add(id(value))
        try:
            if isinstance(value, Mapping):
                result = {}
                for key, child in value.items():
                    if not isinstance(key, str):
                        raise TypeError("JSON object keys must be strings")
                    result[key] = _json_value(child, depth + 1, ancestors, budget)
                return result
            return [_json_value(child, depth + 1, ancestors, budget) for child in value]
        finally:
            ancestors.remove(id(value))
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        if not -(2**63) <= value < 2**64:
            raise ValueError("JSON integers must fit signed or unsigned 64-bit storage")
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("JSON numbers must be finite")
        return value
    raise TypeError("state must contain only JSON values; no automatic tensor/model conversion")


def _integer(value: Integral, field_name: str) -> int:
    """Accept integer coordinates without boolean coercion or fractional truncation."""
    if isinstance(value, bool) or not isinstance(value, Integral):
        raise TypeError(f"{field_name} must be an integer")
    number = int(value)
    if not -(2**63) <= number < 2**63:
        raise ValueError(f"{field_name} must fit a signed 64-bit integer")
    return number
