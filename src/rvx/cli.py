from __future__ import annotations

import argparse
from importlib.metadata import PackageNotFoundError, version
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Sequence


DEFAULT_URL = "http://127.0.0.1:9110"


def package_version() -> str:
    """Read the installed distribution version without loading native code."""
    try:
        return version("rvx")
    except PackageNotFoundError:
        return "unknown (uninstalled checkout)"


def add_server_arguments(parser: argparse.ArgumentParser) -> None:
    """Expose native options without overriding defaults owned by rvxd."""
    parser.add_argument("--version", action="version", version=f"%(prog)s {package_version()}")
    parser.add_argument("--data-dir", required=True, help="persistent storage owned by this daemon")
    parser.add_argument("--listen", help="bind address; non-loopback requires RVX_API_TOKEN (default: 127.0.0.1:9110)")
    parser.add_argument("--ui-dir", help="override the bundled built Web UI directory")
    parser.add_argument("--scrape-concurrency", help="native concurrent Pull limit")


def api_request(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> Any:
    """Send one Rvx control or query request."""
    body = (
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        if payload is not None
        else None
    )
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=body,
        method=method,
        headers={
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
            **(
                {"Authorization": f"Bearer {os.environ['RVX_API_TOKEN']}"}
                if os.environ.get("RVX_API_TOKEN")
                else {}
            ),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        with error:
            detail = error.read().decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            detail or f"Rvx API returned HTTP {error.code}"
        ) from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"cannot reach Rvx API: {error.reason}") from error


def build_parser() -> argparse.ArgumentParser:
    """Build the Rvx command-line parser."""
    parser = argparse.ArgumentParser(
        prog="rvx",
        description="Local-first full-state snapshot observability.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {package_version()}")
    parser.add_argument(
        "--url",
        default=os.environ.get("RVX_URL", DEFAULT_URL),
        help="Rvx API base URL",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    server = commands.add_parser(
        "serve",
        help="run the central native daemon with the bundled Web UI",
        description="Run the central RVX daemon; Source.serve() instead exposes a producer's Pull API.",
    )
    add_server_arguments(server)
    commands.add_parser("status")

    projects = commands.add_parser("projects")
    project_actions = projects.add_subparsers(dest="action", required=True)
    project_actions.add_parser("list")
    project_create = project_actions.add_parser("create")
    project_create.add_argument("name")

    experiments = commands.add_parser("experiments")
    experiment_actions = experiments.add_subparsers(
        dest="action",
        required=True,
    )
    experiment_list = experiment_actions.add_parser("list")
    experiment_list.add_argument("--project")
    experiment_create = experiment_actions.add_parser("create")
    experiment_create.add_argument("--project", required=True)
    experiment_create.add_argument("name")

    runs = commands.add_parser("runs")
    run_actions = runs.add_subparsers(dest="action", required=True)
    run_list = run_actions.add_parser("list")
    run_list.add_argument("--experiment")
    run_create = run_actions.add_parser("create")
    run_create.add_argument("--experiment", required=True)
    run_create.add_argument("--config", default="{}")
    run_create.add_argument("name")
    run_update = run_actions.add_parser("update")
    run_update.add_argument("--run", required=True)
    run_update.add_argument(
        "--status",
        required=True,
        choices=("running", "finished", "failed", "cancelled"),
    )

    sources = commands.add_parser("sources")
    source_actions = sources.add_subparsers(dest="action", required=True)
    source_list = source_actions.add_parser("list")
    source_list.add_argument("--run")
    source_register = source_actions.add_parser("register")
    source_register.add_argument("--run", required=True)
    source_register.add_argument("--attempt", default="attempt-1")
    source_register.add_argument("--role", required=True)
    source_register.add_argument(
        "--endpoint",
        required=True,
        help="HTTP/HTTPS base URL of the role snapshot API (no query or fragment)",
    )
    source_register.add_argument("--node")
    source_register.add_argument("--rank", type=int)
    source_register.add_argument("--interval-ms", type=int, default=1000)
    source_register.add_argument("--timeout-ms", type=int, default=5000)
    source_update = source_actions.add_parser("update")
    source_update.add_argument("--source", required=True)
    source_update.add_argument(
        "--state",
        required=True,
        choices=("draining", "ended", "lost"),
    )

    snapshots = commands.add_parser("snapshots", help="inspect retained full runtime state")
    snapshot_actions = snapshots.add_subparsers(dest="action", required=True)
    latest = snapshot_actions.add_parser("latest")
    history = snapshot_actions.add_parser("history")
    for reader in (latest, history):
        reader.add_argument("--run", required=True)
        reader.add_argument("--source", action="append", default=[])
        reader.add_argument("--limit", type=int, default=100)
    latest.add_argument("--after-source-id")
    history.add_argument("--before-id", type=int)
    history.add_argument("--from", dest="from_ns", type=int)
    history.add_argument("--to", dest="to_ns", type=int)
    diff = snapshot_actions.add_parser("diff")
    diff.add_argument("--before-id", type=int, required=True)
    diff.add_argument("--after-id", type=int, required=True)
    snapshot_get = snapshot_actions.add_parser("get")
    snapshot_get.add_argument("id", type=int)
    catalog = commands.add_parser("catalog", help="discover recorded chart fields")
    catalog.add_argument("--run", action="append", required=True)

    query = commands.add_parser("query", help="derive numeric field trends from snapshots")
    query.add_argument("--run", action="append", required=True)
    query.add_argument("--field", action="append", required=True, help="RFC 6901 pointer relative to state")
    query.add_argument("--source", action="append", default=[])
    query.add_argument(
        "--axis",
        default="wall_time",
        help="wall_time (default), elapsed, or an explicit logical axis",
    )
    query.add_argument("--max-points", type=int, default=1600)
    query.add_argument("--from", dest="from_ns", type=int)
    query.add_argument("--to", dest="to_ns", type=int)
    return parser


def execute(args: argparse.Namespace) -> Any:
    """Execute one parsed Rvx CLI operation."""
    if args.command == "serve":
        from ._server import serve
        return serve(
            data_dir=args.data_dir, listen=args.listen, ui_dir=args.ui_dir,
            scrape_concurrency=args.scrape_concurrency,
        )
    if args.command == "status":
        return api_request(args.url, "/api/experiments/stats")
    if args.command == "projects":
        if args.action == "list":
            return api_request(args.url, "/api/experiments/projects")
        return api_request(
            args.url,
            "/api/experiments/projects",
            method="POST",
            payload={"name": args.name},
        )
    if args.command == "experiments":
        if args.action == "list":
            query = (
                f"?{urllib.parse.urlencode({'project_id': args.project})}"
                if args.project
                else ""
            )
            return api_request(
                args.url,
                f"/api/experiments/experiments{query}",
            )
        return api_request(
            args.url,
            "/api/experiments/experiments",
            method="POST",
            payload={"project_id": args.project, "name": args.name},
        )
    if args.command == "runs":
        if args.action == "list":
            query = (
                f"?{urllib.parse.urlencode({'experiment_id': args.experiment})}"
                if args.experiment
                else ""
            )
            return api_request(args.url, f"/api/experiments/runs{query}")
        if args.action == "update":
            return api_request(
                args.url,
                f"/api/experiments/runs/{urllib.parse.quote(args.run)}",
                method="PATCH",
                payload={"status": args.status},
            )
        try:
            config = json.loads(args.config)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"invalid run config JSON: {error}") from error
        if not isinstance(config, dict):
            raise RuntimeError("run config must be a JSON object")
        return api_request(
            args.url,
            "/api/experiments/runs",
            method="POST",
            payload={
                "experiment_id": args.experiment,
                "name": args.name,
                "config": config,
            },
        )
    if args.command == "sources":
        if args.action == "list":
            query = (
                f"?{urllib.parse.urlencode({'run_id': args.run})}"
                if args.run
                else ""
            )
            return api_request(args.url, f"/api/experiments/sources{query}")
        if args.action == "update":
            return api_request(
                args.url,
                f"/api/experiments/sources/{urllib.parse.quote(args.source)}",
                method="PATCH",
                payload={"state": args.state},
            )
        return api_request(
            args.url,
            "/api/experiments/sources",
            method="POST",
            payload={
                "run_id": args.run,
                "attempt_id": args.attempt,
                "role": args.role,
                "endpoint": args.endpoint,
                "node_id": args.node,
                "rank": args.rank,
                "scrape_interval_ms": args.interval_ms,
                "timeout_ms": args.timeout_ms,
            },
        )
    if args.command == "snapshots":
        if args.action == "get":
            return api_request(args.url, f"/api/snapshots/{args.id}")
        if args.action == "diff":
            payload = {"before_id": args.before_id, "after_id": args.after_id}
        else:
            payload = {"run_id": args.run, "source_ids": args.source, "limit": args.limit}
            if args.action == "latest":
                payload["after_source_id"] = args.after_source_id
            else:
                payload.update({"before_id": args.before_id, "from": args.from_ns, "to": args.to_ns})
        return api_request(
            args.url, f"/api/snapshots/{args.action}", method="POST", payload=payload,
        )
    if args.command == "query":
        return api_request(
            args.url, "/api/snapshots/query", method="POST",
            payload={
                "run_ids": args.run, "paths": args.field, "source_ids": args.source,
                "axis": args.axis, "max_points": args.max_points,
                "from": args.from_ns, "to": args.to_ns,
            },
        )
    if args.command == "catalog":
        return api_request(
            args.url,
            "/api/charts/catalog",
            method="POST",
            payload={"run_ids": args.run},
        )
    raise RuntimeError(f"unsupported Rvx command: {args.command}")


def main(argv: Sequence[str] | None = None) -> int:
    """Run the Rvx control client or replace it with the central daemon."""
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = execute(args)
    except RuntimeError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def daemon_main(argv: Sequence[str] | None = None) -> int:
    """Expose the same packaged daemon launcher as the rvxd console command."""
    parser = argparse.ArgumentParser(
        prog="rvxd", description="Run the central RVX daemon with its bundled Web UI.",
    )
    add_server_arguments(parser)
    args = parser.parse_args(argv)
    args.command = "serve"
    try:
        execute(args)
    except RuntimeError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
