from __future__ import annotations

import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request


def request(base: str, path: str, payload: dict | None = None):
    """Use only installed-package HTTP surfaces, never a checkout-owned engine."""
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        base + path, data=data, headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def smoke() -> None:
    """Prove the installed wheel contains a runnable native daemon, UI, and producer."""
    import rvx
    from rvx import Source

    if not Path(rvx.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()):
        raise RuntimeError("smoke must import an installed wheel, not the source checkout")
    scripts = Path(sys.executable).parent
    os.environ["PATH"] = str(scripts)
    with tempfile.TemporaryDirectory(prefix="rvx-installed-", dir=Path.cwd()) as directory:
        process = subprocess.Popen(
            [str(scripts / "rvx"), "serve", "--data-dir", str(Path(directory) / "data"),
             "--listen", "127.0.0.1:0"],
            cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            if not select.select([process.stdout], [], [], 30)[0]:
                raise RuntimeError("installed daemon did not report readiness")
            line = process.stdout.readline().strip()
            if not line.startswith("rvxd listening on http://"):
                raise RuntimeError(f"unexpected daemon startup: {line}")
            base = line.removeprefix("rvxd listening on ")
            with urllib.request.urlopen(base + "/rvx", timeout=5) as response:
                html = response.read().decode("utf-8")
            if "RVX" not in html:
                raise RuntimeError("bundled RVX UI was not served")
            for asset in re.findall(r'(?:src|href)="(/assets/[^"]+)"', html):
                with urllib.request.urlopen(base + asset, timeout=5) as response:
                    if not response.read():
                        raise RuntimeError(f"empty bundled UI asset: {asset}")
            project = request(base, "/api/experiments/projects", {"name": "wheel-smoke"})
            experiment = request(base, "/api/experiments/experiments", {
                "project_id": project["id"], "name": "installed",
            })
            run = request(base, "/api/experiments/runs", {
                "experiment_id": experiment["id"], "name": "packaged", "config": {},
            })
            with Source(
                project="wheel-smoke", experiment="installed", run_id=run["id"], role="learner",
            ) as source:
                source.capture({"progress": {"loss": 0.8}, "exact": 2**64 - 1}, observed_at_ns=10)
                source.capture({"progress": {"loss": None}, "exact": 2**64 - 1}, observed_at_ns=20)
                source.seal()
                source.serve()
                request(base, "/api/experiments/sources", {
                    "run_id": run["id"], "attempt_id": "attempt-1", "role": "learner",
                    "endpoint": source.endpoint, "scrape_interval_ms": 100, "timeout_ms": 500,
                })
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if request(base, "/api/experiments/stats")["snapshots"] == 2:
                        break
                    time.sleep(0.05)
                else:
                    raise RuntimeError("installed daemon did not persist Source snapshots")
                latest = request(base, "/api/snapshots/latest", {"run_id": run["id"]})["snapshots"][0]
                if latest["state"]["exact"] != 2**64 - 1:
                    raise RuntimeError("installed snapshot round-trip lost integer precision")
                trend = request(base, "/api/snapshots/query", {
                    "run_ids": [run["id"]], "paths": ["/progress/loss"],
                })
                if trend["axis"] != "wall_time" or trend["series"][0]["values"] != [0.8, None]:
                    raise RuntimeError("installed projection lost snapshot semantics")
                catalog = request(base, "/api/charts/catalog", {"run_ids": [run["id"]]})
                if catalog["defaults"] != ["/progress/loss"]:
                    raise RuntimeError("installed catalog selected nonsemantic defaults")
                snapshot_id = trend["series"][0]["snapshot_ids"][-1]
                if request(base, f"/api/snapshots/{snapshot_id}") != latest:
                    raise RuntimeError("chart provenance does not identify its raw snapshot")
                if set(request(base, "/api/experiments/stats")) != {
                    "projects", "experiments", "runs", "sources", "active_sources",
                    "snapshots", "cursor_gaps", "scrape_failures",
                }:
                    raise RuntimeError("installed server exposes obsolete counters")
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=10)
                if process.returncode != 0:
                    raise RuntimeError(f"installed daemon failed: {stdout}\n{stderr}")
        finally:
            if process.poll() is None:
                process.kill()
            stdout, stderr = process.communicate(timeout=10)
            if process.returncode != 0:
                raise RuntimeError(f"installed daemon exited {process.returncode}: {stdout}\n{stderr}")
    print("Installed SDK, native server, UI, Pull, and shutdown are functional without build tools.")


if __name__ == "__main__":
    smoke()
