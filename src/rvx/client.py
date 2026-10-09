from __future__ import annotations

import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from .errors import RvxError


class RvxClient:
    """Manage remote RVX experiment hierarchy and Source registrations."""

    def __init__(
        self,
        base_url: str,
        *,
        token: str | None = None,
        timeout: float = 10.0,
    ) -> None:
        """Validate one credential-free HTTP(S) RVX server base URL."""
        parsed = urlparse(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "RVX API URL must be an absolute credential-free HTTP(S) base URL"
            )
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.base_url = base_url.rstrip("/")
        self.token = os.environ.get("RVX_API_TOKEN") if token is None else token
        self.timeout = timeout

    def ensure_hierarchy(
        self,
        project: str,
        experiment: str,
        run: str,
        *,
        config: dict[str, Any] | None = None,
    ) -> dict[str, dict[str, Any]]:
        """Idempotently resolve or create one Project, Experiment, and Run."""
        project_value = self._find_or_create(
            "/api/experiments/projects",
            "projects",
            project,
            {"name": project},
        )
        experiment_value = self._find_or_create(
            "/api/experiments/experiments",
            "experiments",
            experiment,
            {"project_id": project_value["id"], "name": experiment},
            query={"project_id": project_value["id"]},
        )
        run_value = self._find_or_create(
            "/api/experiments/runs",
            "runs",
            run,
            {
                "experiment_id": experiment_value["id"],
                "name": run,
                "config": dict(config or {}),
            },
            query={"experiment_id": experiment_value["id"]},
        )
        return {
            "project": project_value,
            "experiment": experiment_value,
            "run": run_value,
        }

    def register_source(
        self,
        *,
        run_id: str,
        role: str,
        endpoint: str,
        attempt_id: str = "attempt-1",
        node_id: str | None = None,
        rank: int | None = None,
        scrape_interval_ms: int = 1_000,
        timeout_ms: int = 5_000,
    ) -> dict[str, Any]:
        """Register or refresh one reachable Source endpoint."""
        return self.post(
            "/api/experiments/sources",
            {
                "run_id": run_id,
                "attempt_id": attempt_id,
                "role": role,
                "endpoint": endpoint,
                "node_id": node_id,
                "rank": rank,
                "scrape_interval_ms": scrape_interval_ms,
                "timeout_ms": timeout_ms,
            },
        )

    def update_run_status(self, run_id: str, status: str) -> dict[str, Any]:
        """Update one remote Run lifecycle state."""
        return self.patch(
            f"/api/experiments/runs/{run_id}",
            {"status": status},
        )

    def update_source_state(self, source_id: str, state: str) -> dict[str, Any]:
        """Update one remote Source lifecycle state."""
        return self.patch(
            f"/api/experiments/sources/{source_id}",
            {"state": state},
        )

    def get(
        self,
        path: str,
        *,
        query: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Issue one authenticated JSON GET request."""
        suffix = f"?{urlencode(query)}" if query else ""
        return self._request("GET", f"{path}{suffix}", None)

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Issue one authenticated JSON POST request."""
        return self._request("POST", path, payload)

    def patch(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Issue one authenticated JSON PATCH request."""
        return self._request("PATCH", path, payload)

    def _find_or_create(
        self,
        path: str,
        collection: str,
        name: str,
        payload: dict[str, Any],
        *,
        query: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Find an exact named object or create it, tolerating creation races."""
        for value in self.get(path, query=query).get(collection, []):
            if value.get("name") == name:
                return value
        try:
            return self.post(path, payload)
        except RvxError:
            for value in self.get(path, query=query).get(collection, []):
                if value.get("name") == name:
                    return value
            raise

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Send one bounded request and decode an object response."""
        body = (
            None
            if payload is None
            else json.dumps(payload, allow_nan=False, separators=(",", ":")).encode()
        )
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                value = json.loads(response.read())
        except HTTPError as error:
            detail = error.read().decode(errors="replace").strip()
            if error.code == 401:
                detail = "sign in or set RVX_API_TOKEN to continue"
            raise RvxError(
                f"RVX API {method} {path} failed with HTTP {error.code}: {detail}"
            ) from error
        except URLError as error:
            raise RvxError(
                f"cannot reach RVX API at {self.base_url}: {error}"
            ) from error
        if not isinstance(value, dict):
            raise RvxError("RVX API returned a non-object JSON response")
        return value
