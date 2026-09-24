from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


def api_request(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: float = 30,
) -> Any:
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=body,
        method=method,
        headers={
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        with error:
            detail = error.read().decode(errors="replace").strip()
        raise RuntimeError(detail or f"RVX API returned HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"cannot reach RVX API: {error.reason}") from error
