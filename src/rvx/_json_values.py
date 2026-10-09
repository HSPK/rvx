from __future__ import annotations

import dataclasses
import datetime as dt
import math
from collections.abc import Mapping
from enum import Enum
from pathlib import Path
from typing import Any


MAX_DEPTH = 64
MAX_NODES = 100_000
NONFINITE = "$rvx.nonfinite"


def normalize_json(
    value: Any,
    *,
    field: str,
    coerce: bool,
    encode_nonfinite: bool,
) -> Any:
    return _normalize(
        value,
        field=field,
        coerce=coerce,
        encode_nonfinite=encode_nonfinite,
        depth=0,
        ancestors=set(),
        budget=[MAX_NODES],
    )


def _normalize(
    value: Any,
    *,
    field: str,
    coerce: bool,
    encode_nonfinite: bool,
    depth: int,
    ancestors: set[int],
    budget: list[int],
) -> Any:
    budget[0] -= 1
    if budget[0] < 0:
        raise ValueError(f"{field} exceeds 100000 JSON nodes")
    if depth > MAX_DEPTH:
        raise ValueError(f"{field} nesting exceeds 64 levels")
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        if not -(2**63) <= value < 2**64:
            raise ValueError(
                f"{field} integers must fit signed or unsigned 64-bit storage"
            )
        return value
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        if encode_nonfinite:
            return {
                NONFINITE: (
                    "nan"
                    if math.isnan(value)
                    else "inf"
                    if value > 0
                    else "-inf"
                )
            }
        raise ValueError("JSON numbers must be finite")
    if coerce:
        if id(value) in ancestors:
            raise ValueError(f"{field} contains a circular conversion reference")
        converted = _coerce(value)
        if converted is not value:
            ancestors.add(id(value))
            try:
                return _normalize(
                    converted,
                    field=field,
                    coerce=coerce,
                    encode_nonfinite=encode_nonfinite,
                    depth=depth,
                    ancestors=ancestors,
                    budget=budget,
                )
            finally:
                ancestors.remove(id(value))
    containers = (Mapping, list, tuple, set) if coerce else (Mapping, list)
    if isinstance(value, containers):
        if id(value) in ancestors:
            raise ValueError(f"{field} contains a circular reference")
        ancestors.add(id(value))
        try:
            if isinstance(value, Mapping):
                result = {}
                for key, child in value.items():
                    if not isinstance(key, str):
                        raise TypeError("JSON object keys must be strings")
                    result[key] = _normalize(
                        child,
                        field=field,
                        coerce=coerce,
                        encode_nonfinite=encode_nonfinite,
                        depth=depth + 1,
                        ancestors=ancestors,
                        budget=budget,
                    )
                return result
            return [
                _normalize(
                    child,
                    field=field,
                    coerce=coerce,
                    encode_nonfinite=encode_nonfinite,
                    depth=depth + 1,
                    ancestors=ancestors,
                    budget=budget,
                )
                for child in value
            ]
        finally:
            ancestors.remove(id(value))
    if coerce:
        raise TypeError(f"unsupported tracker value type: {type(value).__name__}")
    raise TypeError(
        "state must contain only JSON values; no automatic tensor/model conversion"
    )


def _coerce(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {field.name: getattr(value, field.name) for field in dataclasses.fields(value)}
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    item = getattr(value, "item", None)
    if callable(item):
        try:
            converted = item()
        except (ValueError, TypeError) as error:
            tolist = getattr(value, "tolist", None)
            if not callable(tolist):
                raise TypeError("tracker scalar conversion failed") from error
            return tolist()
        if converted is not value:
            return converted
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        return tolist()
    return value
