from __future__ import annotations

import json
import socket
import uuid
import warnings
from collections.abc import Mapping, Sequence
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING, Any

from ._tracker_values import alert_rule, current_rank, delivery_config, encode_json, json_value

if TYPE_CHECKING:
    from aiohttp.web import Application
    from .adapters import SourceASGI

class Run:
    """Wandb-style tracker facade backed by the native RVX tracker and Source."""

    def __init__(
        self,
        *,
        project: str,
        name: str | None = None,
        entity: str | None = None,
        dir: str | None = None,
        run_dir: str | None = None,
        notes: str | None = None,
        tags: Sequence[str] | None = None,
        resume: bool | str | None = None,
        experiment: str = "default",
        run_id: str | None = None,
        role: str = "tracker",
        stream: str | None = None,
        attempt_id: str = "attempt-1",
        config: Mapping[str, Any] | None = None,
        alert: Mapping[str, Any] | None = None,
        alert_rules: Sequence[str | Mapping[str, Any]] = (),
        alert_on_rank: int | None = 0,
        backends: Sequence[Any] = (),
        backend_kwargs: Mapping[str, Mapping[str, Any]] | None = None,
        print_to_screen: bool = False,
        rank: int | None = None,
        node_id: str | None = None,
        labels: Mapping[str, str] | None = None,
        capacity: int = 1_024,
        max_buffer_bytes: int = 64 * 1024 * 1024,
        history_steps: int = 1_024,
        step_axis: str = "step",
        step_policy: str = "monotonic",
        span_count: bool = False,
        alert_window: int = 1_024,
        watchdog_interval_ms: int = 30_000,
        max_state_bytes: int = 8 * 1024 * 1024,
        max_history_bytes: int = 64 * 1024 * 1024,
        max_metrics: int = 4096,
        max_spans: int = 4096,
        max_alert_series_bytes: int = 64 * 1024 * 1024,
        shutdown_timeout_ms: int = 5000,
        serve: bool = False,
        host: str = "127.0.0.1",
        port: int = 0,
    ):
        from ._native import RvxTracker

        self.project = project
        self.experiment = experiment
        self.name = name or f"run-{uuid.uuid4().hex[:12]}"
        self.id = run_id or self.name
        self.role = stream or role
        self.config = dict(config or {})
        self._finished = False
        self._print_to_screen = print_to_screen
        if dir is not None or run_dir is not None:
            raise NotImplementedError("tracker directory storage is not supported; use the RVX daemon data directory")
        if resume not in (None, False, "never"):
            raise NotImplementedError("tracker cursor/summary resume is not implemented; use a fresh Source session")
        if backends or backend_kwargs:
            raise NotImplementedError("external mirror backends are not implemented")
        if rank is None:
            rank = current_rank()
        if alert_on_rank is not None and rank != alert_on_rank:
            alert_rules = ()
        identity = {
            "project": project,
            "experiment": experiment,
            "run_id": self.id,
            "attempt_id": attempt_id,
            "role": self.role,
            "rank": rank,
            "node_id": socket.gethostname() if node_id is None else node_id,
            "labels": {
                "rvx.tracker": "true",
                **({"rvx.stream": stream} if stream else {}),
                **({"entity": entity} if entity else {}),
                **({"notes": notes} if notes else {}),
                **({"tags": ",".join(tags)} if tags else {}),
                **dict(labels or {}),
            },
            "schema_version": 1,
        }
        options = {
            "step_axis": step_axis,
            "history_steps": history_steps,
            "step_policy": step_policy,
            "span_count": span_count,
            "alert_window": alert_window,
            "watchdog_interval_ms": watchdog_interval_ms,
            "max_state_bytes": max_state_bytes,
            "max_history_bytes": max_history_bytes,
            "max_metrics": max_metrics,
            "max_spans": max_spans,
            "max_alert_series_bytes": max_alert_series_bytes,
            "shutdown_timeout_ms": shutdown_timeout_ms,
        }
        self._native = RvxTracker(
            encode_json(identity),
            encode_json(json_value(self.config)),
            encode_json(options),
            encode_json([alert_rule(rule) for rule in alert_rules]),
            encode_json(delivery_config(alert)),
            capacity,
            max_buffer_bytes,
        )
        if serve:
            self.serve(host=host, port=port)

    @property
    def endpoint(self) -> str:
        return self._native.endpoint

    @property
    def source_session_id(self) -> str:
        return self._native.source_session_id

    @property
    def step(self) -> int:
        info = self.info()
        return int(info["next_step"] if info["open_step"] is None else info["open_step"])

    @property
    def summary(self) -> dict[str, Any]:
        return json.loads(self._native.summary_json())

    @property
    def url(self) -> str | None:
        try:
            return self.endpoint
        except RuntimeError:
            return None

    @property
    def dir(self) -> str:
        return ""

    def serve(self, *, host: str = "127.0.0.1", port: int = 0) -> Run:
        address = f"[{host}]" if ":" in host and not host.startswith("[") else host
        self._native.serve(f"{address}:{port}")
        return self

    def stop_serving(self) -> None:
        self._native.stop_serving()

    def asgi(self) -> SourceASGI:
        from .adapters import SourceASGI

        return SourceASGI(self)

    def attach_aiohttp(self, app: Application, *, prefix: str = "/rvx") -> None:
        from .adapters import attach_aiohttp

        attach_aiohttp(self, app, prefix=prefix)

    def descriptor_bytes(self) -> bytes:
        return self._native.descriptor_bytes()

    def latest_bytes(self) -> bytes:
        return self._native.latest_bytes()

    def history_bytes(self, *, after: int = 0, limit: int = 64) -> bytes:
        return self._native.history_bytes(after, limit)

    def log(
        self,
        data: Mapping[str, Any],
        step: int | None = None,
        commit: bool | None = None,
        *,
        observed_at_ns: int | None = None,
    ) -> dict[str, Any]:
        result = json.loads(
            self._native.log_json(
                encode_json(json_value(data)),
                step,
                commit,
                observed_at_ns,
            )
        )
        if not result["accepted"]:
            warnings.warn(result["reason"], RuntimeWarning, stacklevel=2)
        elif self._print_to_screen and result["committed"]:
            print(f"step={result['step']} {dict(data)}")
        return result

    def flush(self, *, observed_at_ns: int | None = None, durable: bool = False,
              server_url: str | None = None, source_id: str | None = None,
              timeout: float = 30.0) -> dict[str, Any]:
        self._validate_durable(durable, server_url, source_id, timeout)
        result = json.loads(self._native.flush_json(observed_at_ns))
        if durable:
            cursor = result["capture"]["next_sequence"] if result["capture"] else self.info()["accepted_next_sequence"]
            result["persistence"] = self.wait_persisted(
                server_url=server_url, source_id=source_id, next_sequence=cursor, timeout=timeout,
            )
        return result

    def wait_persisted(self, *, server_url: str, source_id: str,
                       next_sequence: int | None = None, timeout: float = 30.0) -> dict[str, Any]:
        self._validate_durable(True, server_url, source_id, timeout)
        cursor = self.info()["accepted_next_sequence"] if next_sequence is None else next_sequence
        return json.loads(self._native.wait_persisted_json(
            server_url, source_id, cursor, int(timeout * 1000),
        ))

    @staticmethod
    def _validate_durable(durable, server_url, source_id, timeout):
        if durable and (not server_url or not source_id):
            raise ValueError("durable confirmation requires server_url and registered source_id")
        if not 0.001 <= timeout <= 300:
            raise ValueError("timeout must be between 0.001 and 300 seconds")

    def history(
        self,
        n: int | None = 50,
        *,
        output_type: str = "dict",
        metrics: Sequence[str] | None = None,
        step_range: tuple[int | None, int | None] | None = None,
        include_meta: bool = True,
        include_open: bool = True,
        fill_missing: bool = False,
        dropna: bool = False,
        run: str | Path | None = None,
        max_bytes: int = 16 * 1024 * 1024,
    ):
        if run is not None:
            raise ValueError(
                "offline run paths are not a second local store; query retained history through RVX"
            )
        if n not in (None, -1) and n < 0:
            raise ValueError("n must be non-negative, -1, or None")
        start, end = (None, None) if step_range is None else step_range
        projected = json.loads(self._native.history_query_json(encode_json({
            "limit": None if n in (None, -1) else n,
            "metrics": None if metrics is None else list(metrics),
            "from_step": start, "to_step": end, "include_meta": include_meta,
            "include_open": include_open, "fill_missing": fill_missing, "dropna": dropna,
            "max_bytes": max_bytes,
        })))
        if output_type in {"dict", "dicts"}:
            return projected
        if output_type in {"pandas", "pd"}:
            try:
                import pandas as pd
            except ImportError as error:
                raise ImportError('Install pandas with `uv add "rvx[pandas]"`') from error
            return pd.DataFrame(projected)
        if output_type == "polars":
            try:
                import polars as pl
            except ImportError as error:
                raise ImportError('Install polars with `uv add "rvx[polars]"`') from error
            return pl.DataFrame(projected)
        raise ValueError("output_type must be dict, pandas/pd, or polars")

    def info(self) -> dict[str, Any]:
        return json.loads(self._native.tracker_info_json())

    def define_metric(self, name: str, **kwargs) -> None:
        raise NotImplementedError("define_metric is not supported; use explicit snapshot paths and step axes")

    def alert(
        self,
        title: str,
        text: str,
        level: str = "warning",
        *,
        tags: Sequence[str] = (),
        channels: Sequence[str] = (),
        observed_at_ns: int | None = None,
    ) -> None:
        self._native.alert_json(
            title,
            text,
            level,
            list(tags),
            list(channels),
            observed_at_ns,
        )

    def add_alert_rule(self, rule: str | Mapping[str, Any]) -> None:
        self._native.add_alert_rule_json(encode_json(alert_rule(rule)))

    def remove_alert_rule(self, name: str) -> bool:
        return bool(self._native.remove_alert_rule(name))

    def alert_rules(self) -> list[dict[str, Any]]:
        return json.loads(self._native.alert_rules_json())

    def log_artifact(
        self,
        path: str | Path,
        *,
        name: str | None = None,
        type: str = "artifact",
        aliases: Sequence[str] = (),
        metadata: Mapping[str, Any] | None = None,
        observed_at_ns: int | None = None,
    ) -> None:
        path = Path(path)
        self._native.artifact_local_json(
            "log",
            str(path),
            name or path.name,
            type,
            list(aliases),
            encode_json(json_value(dict(metadata or {}))),
            observed_at_ns,
        )

    def use_artifact(
        self,
        uri: str,
        *,
        name: str,
        digest: str,
        type: str = "artifact",
        aliases: Sequence[str] = (),
        metadata: Mapping[str, Any] | None = None,
        observed_at_ns: int | None = None,
    ) -> None:
        self._native.artifact_reference_json(
            "use",
            uri,
            name,
            digest,
            type,
            list(aliases),
            encode_json(json_value(dict(metadata or {}))),
            observed_at_ns,
        )

    def finish(self, exit_code: int | None = None, quiet: bool | None = None, *,
               durable: bool = False, server_url: str | None = None,
               source_id: str | None = None, timeout: float = 30.0) -> dict[str, Any]:
        self._validate_durable(durable, server_url, source_id, timeout)
        if quiet is not None:
            raise NotImplementedError("quiet is not supported; delivery failures are always observable")
        if exit_code is not None and (isinstance(exit_code, bool) or not isinstance(exit_code, int)):
            raise TypeError("exit_code must be an integer or None")
        result = {}
        if not self._finished:
            result = json.loads(self._native.finish_json(None, exit_code not in (None, 0)))
            self._finished = True
        if durable:
            result["persistence"] = self.wait_persisted(server_url=server_url, source_id=source_id, timeout=timeout)
        result["delivery"] = json.loads(self._native.delivery_stats_json())
        return result

    def close(self) -> None:
        if not self._finished:
            self.finish()
        self._native.close()

    def __enter__(self) -> Run:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.finish(exit_code=1 if exc_type else 0)
        self._native.close()
