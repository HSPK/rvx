from __future__ import annotations

import atexit
import json
import os
import socket
import threading
import uuid
import warnings
from collections.abc import Mapping, Sequence
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING, Any

from ._tracker_span import Span
from ._tracker_span import reset_after_fork as reset_span_after_fork
from ._tracker_values import (
    alert_rule,
    current_rank,
    delivery_config,
    encode_json,
    json_value,
)

if TYPE_CHECKING:
    from aiohttp.web import Application

    from .adapters import SourceASGI


_active_run: Run | None = None
_lifecycle = threading.RLock()


def _reset_after_fork() -> None:
    global _active_run, _lifecycle
    _active_run = None
    _lifecycle = threading.RLock()
    reset_span_after_fork()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_after_fork)


def _finish_at_exit() -> None:
    run = _active_run
    if run is not None:
        try:
            run.close()
        except Exception:
            pass


atexit.register(_finish_at_exit)


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
        del dir, run_dir, backend_kwargs
        if resume not in (None, False, "never"):
            warnings.warn(
                "RVX resume is server-owned; this Source starts a fresh session and retains prior daemon history",
                RuntimeWarning,
                stacklevel=2,
            )
        if backends:
            warnings.warn(
                "External mirror backends are not part of the native RVX storage contract",
                RuntimeWarning,
                stacklevel=2,
            )
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
        return int(self.info()["next_step"])

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
    ) -> None:
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

    def flush(self, *, observed_at_ns: int | None = None) -> None:
        self._native.flush_json(observed_at_ns)

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
    ):
        del include_open
        if run is not None:
            raise ValueError(
                "offline run paths are not a second local store; query retained history through RVX"
            )
        rows = json.loads(self._native.tracker_history_json(-1))
        if step_range is not None:
            start, end = step_range
            rows = [
                row
                for row in rows
                if (start is None or row["step"] >= start)
                and (end is None or row["step"] < end)
            ]
        if n not in (None, -1):
            if n < 0:
                raise ValueError("n must be non-negative, -1, or None")
            rows = rows[-n:] if n else []
        projected = []
        selected = None if metrics is None else set(metrics)
        for row in rows:
            values = {
                key: value
                for key, value in row["metrics"].items()
                if selected is None or key in selected
            }
            if fill_missing and selected is not None:
                for key in selected:
                    values.setdefault(key, None)
            if dropna and values and all(value is None for value in values.values()):
                continue
            if include_meta:
                values = {
                    "_step": row["step"],
                    "_time": row["observed_at_ns"] / 1_000_000_000,
                    **values,
                }
            projected.append(values)
        if output_type in {"dict", "dicts"}:
            return projected
        if output_type in {"pandas", "pd"}:
            try:
                import pandas as pd
            except ImportError as error:
                raise ImportError(
                    'Install pandas with `uv add "rvx[pandas]"`'
                ) from error
            return pd.DataFrame(projected)
        if output_type == "polars":
            try:
                import polars as pl
            except ImportError as error:
                raise ImportError(
                    'Install polars with `uv add "rvx[polars]"`'
                ) from error
            return pl.DataFrame(projected)
        raise ValueError("output_type must be dict, pandas/pd, or polars")

    def info(self) -> dict[str, Any]:
        return json.loads(self._native.tracker_info_json())

    def define_metric(self, name: str, **kwargs) -> None:
        del name, kwargs

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

    def finish(self, exit_code: int | None = None, quiet: bool | None = None) -> None:
        del exit_code, quiet
        if self._finished:
            return
        self._native.finish_json(None)
        self._finished = True

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
        self.close()


def init(
    project: str,
    name: str | None = None,
    *,
    experiment: str = "default",
    run_id: str | None = None,
    config: Mapping[str, Any] | None = None,
    alert_rules: Sequence[str | Mapping[str, Any]] = (),
    **kwargs,
) -> Run:
    global _active_run
    with _lifecycle:
        if _active_run is not None:
            raise RuntimeError("Tracker is already initialized. Call finish() first.")
        _active_run = Run(
            project=project,
            name=name,
            experiment=experiment,
            run_id=run_id,
            config=config,
            alert_rules=alert_rules,
            **kwargs,
        )
        return _active_run


def get_run() -> Run | None:
    return _active_run


def _require_run() -> Run:
    if _active_run is None:
        raise RuntimeError("Tracker is not initialized. Call rvx.tracker.init() first.")
    return _active_run


def log(
    data: Mapping[str, Any],
    step: int | None = None,
    commit: bool | None = None,
    *,
    observed_at_ns: int | None = None,
):
    _require_run().log(
        data,
        step=step,
        commit=commit,
        observed_at_ns=observed_at_ns,
    )


def history(n: int | None = 50, **kwargs):
    return _require_run().history(n, **kwargs)


def summary() -> dict[str, Any]:
    return _require_run().summary


def info() -> dict[str, Any]:
    return _require_run().info()


def finish(exit_code: int | None = None, quiet: bool | None = None):
    global _active_run
    with _lifecycle:
        run = _require_run()
        try:
            run.finish(exit_code=exit_code, quiet=quiet)
        finally:
            _active_run = None


def alert(
    title: str,
    text: str,
    level: str = "warning",
    *,
    tags: Sequence[str] = (),
    channels: Sequence[str] = (),
):
    _require_run().alert(title, text, level, tags=tags, channels=channels)


def add_alert_rule(rule: str | Mapping[str, Any]) -> None:
    _require_run().add_alert_rule(rule)


def remove_alert_rule(name: str) -> bool:
    return _require_run().remove_alert_rule(name)


def list_alert_rules() -> list[dict[str, Any]]:
    return _require_run().alert_rules()


def start_span(name: str, *, step: int | None = None, **attributes: Any) -> Span:
    return Span(get_run(), name, attributes, step).begin()


def span(name: str, *, step: int | None = None, **attributes: Any) -> Span:
    return Span(get_run(), name, attributes, step)


def log_artifact(path: str | Path, **kwargs) -> None:
    _require_run().log_artifact(path, **kwargs)


def use_artifact(uri: str, **kwargs) -> None:
    _require_run().use_artifact(uri, **kwargs)


def define_metric(name: str, **kwargs) -> None:
    _require_run().define_metric(name, **kwargs)


__all__ = [
    "Run",
    "Span",
    "add_alert_rule",
    "alert",
    "define_metric",
    "finish",
    "get_run",
    "history",
    "info",
    "init",
    "log",
    "log_artifact",
    "list_alert_rules",
    "remove_alert_rule",
    "span",
    "start_span",
    "summary",
    "use_artifact",
]
