from __future__ import annotations

import json
import os
import warnings
from collections.abc import Mapping
from typing import Any

from ._json_values import normalize_json

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
) -> Any:
    return normalize_json(
        value,
        field="tracker value",
        coerce=True,
        encode_nonfinite=True,
    )
