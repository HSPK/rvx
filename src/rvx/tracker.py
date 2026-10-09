from __future__ import annotations

import atexit
import os
import threading
import warnings
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from ._tracker_run import Run
from ._tracker_span import Span, reset_after_fork as reset_span_after_fork


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
        except (RuntimeError, ValueError, OSError) as error:
            warnings.warn(f"RVX tracker exit cleanup failed: {error}", RuntimeWarning)


atexit.register(_finish_at_exit)


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
    return _require_run().log(
        data, step=step, commit=commit, observed_at_ns=observed_at_ns,
    )


def history(n: int | None = 50, **kwargs):
    return _require_run().history(n, **kwargs)


def summary() -> dict[str, Any]:
    return _require_run().summary


def info() -> dict[str, Any]:
    return _require_run().info()


def finish(exit_code: int | None = None, quiet: bool | None = None, **kwargs):
    global _active_run
    with _lifecycle:
        run = _require_run()
        result = run.finish(exit_code=exit_code, quiet=quiet, **kwargs)
        _active_run = None
        return result


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


def replay_alerts(rules, inputs, *, started_at_ns: int = 0, capacity: int = 1024):
    """Replay explicit step/timer observations through the same Rust rule engine."""
    from ._native import RvxTracker
    from ._tracker_values import alert_rule, encode_json, json_value
    import json

    return json.loads(RvxTracker.replay_json(
        encode_json([alert_rule(rule) for rule in rules]),
        encode_json(json_value(inputs)),
        started_at_ns,
        capacity,
    ))


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
    "replay_alerts",
    "span",
    "start_span",
    "summary",
    "use_artifact",
]
