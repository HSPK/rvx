from __future__ import annotations

import dataclasses
import datetime as dt
import json
import math
import os
import warnings
from collections.abc import Mapping
from enum import Enum
from pathlib import Path
from typing import Any


MAX_DEPTH = 64
MAX_NODES = 100_000
NONFINITE = "$rvx.nonfinite"


def encode_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )


def current_rank() -> int:
    for name in ("RANK", "LOCAL_RANK"):
        value = os.environ.get(name)
        if value is not None:
            try:
                return int(value)
            except ValueError:
                warnings.warn(f"Ignoring invalid {name}={value!r}", RuntimeWarning)
    return 0


def alert_rule(rule: str | Mapping[str, Any]) -> Any:
    if isinstance(rule, str):
        return rule
    value = dict(rule)
    if "name" not in value and "alert" in value:
        value["name"] = value.pop("alert")
    if "condition" not in value and "expr" in value:
        value["condition"] = value.pop("expr")
    if "for_steps" not in value and "for" in value:
        value["for_steps"] = value.pop("for")
    if "cooldown_seconds" not in value and "cooldown" in value:
        value["cooldown_seconds"] = value.pop("cooldown")
    return json_value(value)


def delivery_config(alert: Mapping[str, Any] | None) -> Any:
    if not alert:
        return {}
    value = dict(alert)
    policy = value.pop("policy", None)
    if isinstance(policy, Mapping):
        for key, item in policy.items():
            value.setdefault(key, item)
    if "dedup_window_seconds" not in value and "dedup_window" in value:
        value["dedup_window_seconds"] = value.pop("dedup_window")
    return json_value(value)


def json_value(
    value: Any,
    depth: int = 0,
    ancestors: set[int] | None = None,
    budget: list[int] | None = None,
) -> Any:
    ancestors = set() if ancestors is None else ancestors
    budget = [MAX_NODES] if budget is None else budget
    budget[0] -= 1
    if budget[0] < 0:
        raise ValueError("tracker value exceeds 100000 JSON nodes")
    if depth > MAX_DEPTH:
        raise ValueError("tracker value nesting exceeds 64 levels")
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        if not -(2**63) <= value < 2**64:
            raise ValueError(
                "tracker integers must fit signed or unsigned 64-bit storage"
            )
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return {NONFINITE: "nan"}
        if value == math.inf:
            return {NONFINITE: "inf"}
        if value == -math.inf:
            return {NONFINITE: "-inf"}
        return value
    if isinstance(value, Enum):
        return json_value(value.value, depth, ancestors, budget)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return json_value(dataclasses.asdict(value), depth, ancestors, budget)
    if hasattr(value, "model_dump"):
        return json_value(value.model_dump(mode="json"), depth, ancestors, budget)
    if isinstance(value, Mapping):
        if id(value) in ancestors:
            raise ValueError("tracker value contains a circular reference")
        ancestors.add(id(value))
        try:
            result = {}
            for key, child in value.items():
                if not isinstance(key, str):
                    raise TypeError("tracker object keys must be strings")
                result[key] = json_value(child, depth + 1, ancestors, budget)
            return result
        finally:
            ancestors.remove(id(value))
    if isinstance(value, (list, tuple, set)):
        if id(value) in ancestors:
            raise ValueError("tracker value contains a circular reference")
        ancestors.add(id(value))
        try:
            return [
                json_value(child, depth + 1, ancestors, budget)
                for child in value
            ]
        finally:
            ancestors.remove(id(value))
    item = getattr(value, "item", None)
    if callable(item):
        try:
            converted = item()
        except Exception:
            converted = value
        if converted is not value:
            return json_value(converted, depth, ancestors, budget)
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        return json_value(tolist(), depth, ancestors, budget)
    raise TypeError(f"unsupported tracker value type: {type(value).__name__}")
