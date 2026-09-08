from __future__ import annotations

import json
from typing import Any

from .config import RvxSettings
from .errors import RvxError


class RvxService:
    """Expose coarse native Rvx engine operations to Python callers."""

    def __init__(self, settings: RvxSettings):
        """Open the Rust engine without starting its scrape coordinator."""
        self.settings = settings
        self._engine: Any | None = None
        if not settings.enabled:
            return
        try:
            from ._native import RvxEngine
        except ImportError as error:
            raise RvxError(
                "Rvx requires its bundled rvx._native Rust extension; reinstall rvx "
                "or run `uv sync` in a source checkout"
            ) from error
        self._engine = RvxEngine(
            str(settings.directory),
            settings.scrape_concurrency,
            False,
        )

    @property
    def enabled(self) -> bool:
        """Return whether the native experiment engine is active."""
        return self._engine is not None

    def start(self) -> None:
        """Start the native scrape coordinator after role APIs are reachable."""
        if self._engine is None:
            return
        try:
            self._engine.start()
        except RuntimeError as error:
            raise RvxError(f"cannot start Rvx scraper: {error}") from error

    def close(self) -> None:
        """Stop native scraping tasks and release engine resources."""
        if self._engine is not None:
            self._engine.close()
            self._engine = None

    def stats(self) -> dict[str, Any]:
        """Return native engine counters and object counts."""
        return self._decode(self._require().stats_json())

    def projects(self) -> list[dict[str, Any]]:
        """List all registered projects."""
        return self._decode(self._require().list_projects())

    def create_project(self, name: str) -> dict[str, Any]:
        """Create one project and return its persisted identity."""
        return self._decode(self._require().create_project(name))

    def experiments(self, project_id: str | None = None) -> list[dict[str, Any]]:
        """List experiments, optionally restricted to one project."""
        return self._decode(self._require().list_experiments(project_id))

    def create_experiment(self, project_id: str, name: str) -> dict[str, Any]:
        """Create an experiment within a project."""
        return self._decode(
            self._require().create_experiment(project_id, name)
        )

    def runs(self, experiment_id: str | None = None) -> list[dict[str, Any]]:
        """List runs, optionally restricted to one experiment."""
        return self._decode(self._require().list_runs(experiment_id))

    def create_run(
        self,
        experiment_id: str,
        name: str,
        config: dict[str, Any],
    ) -> dict[str, Any]:
        """Create a run with its resolved configuration."""
        return self._decode(
            self._require().create_run(
                experiment_id,
                name,
                json.dumps(config, ensure_ascii=False, separators=(",", ":")),
            )
        )

    def update_run_status(
        self,
        run_id: str,
        status: str,
    ) -> dict[str, Any]:
        """Apply one validated native Run lifecycle transition."""
        return self._decode(
            self._require().update_run_status(run_id, status)
        )

    def ensure_hierarchy(
        self,
        project_name: str,
        experiment_name: str,
        run_name: str,
        config: dict[str, Any],
    ) -> dict[str, dict[str, Any]]:
        """Idempotently create a Project, Experiment, and Run hierarchy."""
        project = next(
            (
                item
                for item in self.projects()
                if item.get("name") == project_name
            ),
            None,
        )
        if project is None:
            project = self.create_project(project_name)
        experiment = next(
            (
                item
                for item in self.experiments(project["id"])
                if item.get("name") == experiment_name
            ),
            None,
        )
        if experiment is None:
            experiment = self.create_experiment(
                project["id"],
                experiment_name,
            )
        run = next(
            (
                item
                for item in self.runs(experiment["id"])
                if item.get("name") == run_name
            ),
            None,
        )
        if run is None:
            run = self.create_run(experiment["id"], run_name, config)
        return {
            "project": project,
            "experiment": experiment,
            "run": run,
        }

    def sources(self, run_id: str | None = None) -> list[dict[str, Any]]:
        """List snapshot Sources, optionally restricted to one Run."""
        return self._decode(self._require().list_sources(run_id))

    def update_source_state(
        self,
        source_id: str,
        state: str,
    ) -> dict[str, Any]:
        """Apply one validated native Source lifecycle transition."""
        return self._decode(
            self._require().update_source_state(source_id, state)
        )

    def register_source(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Register an HTTP(S) role API with bounded scrape settings."""
        required = ("run_id", "attempt_id", "role", "endpoint")
        missing = [name for name in required if not payload.get(name)]
        if missing:
            raise ValueError(f"missing source fields: {missing}")
        return self._decode(
            self._require().register_source(
                str(payload["run_id"]),
                str(payload["attempt_id"]),
                str(payload["role"]),
                str(payload["endpoint"]),
                (
                    str(payload["node_id"])
                    if payload.get("node_id") is not None
                    else None
                ),
                (
                    int(payload["rank"])
                    if payload.get("rank") is not None
                    else None
                ),
                int(payload.get("scrape_interval_ms", 1000)),
                int(payload.get("timeout_ms", 5000)),
            )
        )

    def snapshot_latest(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Read a bounded page of latest full states for one Run."""
        return self._snapshot_read("snapshot_latest", payload)

    def chart_catalog(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Discover recorded chart fields and their current Source summaries."""
        return self._snapshot_read("chart_catalog", payload)

    def snapshot_get(self, snapshot_id: int) -> dict[str, Any]:
        """Read the exact original observation identified by a chart point."""
        return self._decode(self._require().snapshot_get(snapshot_id))

    def snapshot_history(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Read newest-first immutable states with a storage-ID continuation."""
        return self._snapshot_read("snapshot_history", payload)

    def snapshot_query(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Derive numeric JSON-pointer projections from retained full states."""
        return self._snapshot_read("snapshot_query", payload)

    def snapshot_diff(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Compare two stored states, distinguishing absent fields from null."""
        return self._snapshot_read("snapshot_diff", payload)

    def _snapshot_read(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Issue one coarse native read and preserve the shared response shape."""
        return self._decode(getattr(self._require(), method)(
            json.dumps(payload, allow_nan=False, ensure_ascii=False, separators=(",", ":"))
        ))

    def _require(self) -> Any:
        """Return the active engine or reject disabled API access."""
        if self._engine is None:
            raise RvxError("Rvx engine is disabled or closed")
        return self._engine

    @staticmethod
    def _decode(payload: str) -> Any:
        """Decode one native JSON result without per-point callbacks."""
        try:
            return json.loads(payload)
        except json.JSONDecodeError as error:
            raise RvxError(
                f"native experiment engine returned invalid JSON: {error}"
            ) from error
