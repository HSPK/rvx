# RVX

Local-first **runtime-state snapshots for asynchronous experiments**. Each ML
role publishes complete structured states over HTTP; a shared RVX server pulls
and retains them for latest-state inspection, historical replay, state diffs,
and cross-Run comparison. Numeric trends are projections of snapshot fields,
not a separate metric log.

```text
Actor / Learner / Evaluator / node snapshot endpoints
                       |
                    HTTP Pull
                       |
              Rust collector + SQLite WAL
                       |
       latest / history / diff / field projections
                       |
             experiment UI + Python CLI
```

A capture is a full replacement: absent fields disappear, and old snapshots
remain unchanged. Nested objects, arrays, text, booleans, nulls, and finite
numbers are retained. The default axis is observation wall time, not ingestion
time or a synthetic global training step.

This is a published runtime observation, **not a model checkpoint or process
memory dump**. Each Source has its own consistency boundary; RVX does not
claim a globally atomic snapshot across asynchronous roles.

## Install a release

The `rvx` PyPI distribution is one complete package: Python SDK, internal
native extension, native `rvxd` executable, and the built Web UI.
Prebuilt wheels target Linux x86_64/arm64 (glibc 2.28+) and macOS
x86_64/arm64 (11+), with Python 3.11+. Rust and Node are not required by users.

After the first version is published:

```bash
uv tool install rvx
rvx serve --data-dir /absolute/path/to/rvx-data
```

To use the SDK inside an ML project's environment instead, run `uv add rvx`
and import `Source` from `rvx`.

Release artifacts and PyPI Trusted Publishing are configured in
[`.github/workflows/release.yml`](.github/workflows/release.yml);
see [the release guide](docs/releasing.md). A manual workflow run builds
artifacts but never publishes. The PyPI owner configures the `pypi` trusted
publisher before pushing a release tag.

## Build from source

Requires the pinned Rust toolchain, Python 3.11+, uv, and Node.js 22+:

```bash
uv sync --locked
cargo build --locked --release -p rvx-server
npm --prefix web ci
npm --prefix web run build
uv run python scripts/package_assets.py --binary target/release/rvxd --ui web/dist

./target/release/rvxd \
  --data-dir /absolute/path/to/rvx-data \
  --listen 127.0.0.1:9110 \
  --ui-dir /absolute/path/to/rvx/web/dist
```

Open <http://127.0.0.1:9110/rvx>. The UI and API are served by Rust, not Python.
`--data-dir` is required. Exactly one engine may own a data directory; do not
open a live server's directory from Python or a second server.

For a persistent service, copy `web/dist` into a versioned deployment directory
and point `--ui-dir` at that release (or an atomically switched symlink).
Do not point production at the working build directory: `npm run build`
would otherwise replace the live UI before its matching backend is deployed.

Only loopback listeners are supported. Browser mutations must be same-origin.
The server is not an authenticated public service. Use local access or a
secured tunnel; automatic Kubernetes discovery/registration is not included.

The package's uv cache keys include its Rust workspace dependencies.
After native changes, rebuild/synchronize the binding with:

```bash
uv sync --locked
```

For an explicit maturin development build, use
`uv run --no-sync maturin develop --release`
and `uv run --no-sync` while using that build. Ordinary `uv run` synchronizes
the local project and may replace a manually installed development
wheel; do not assume the previously loaded native binary is still selected.

## Capture a role's state

Create the metadata hierarchy using the CLI:

```bash
uv run rvx projects create async-rl
uv run rvx experiments create --project PROJECT_ID grpo
uv run rvx runs create --experiment EXPERIMENT_ID trial-1
```

In a role process:

```python
from rvx import Source

source = Source(
    project="async-rl",
    experiment="grpo",
    run_id="RUN_ID",
    role="learner",
)
source.serve(port=9200)

source.capture(
    {
        "phase": "training",
        "progress": {"step": 1024, "loss": 0.184},
        "queue": {"ready": 8, "inflight": ["batch-72", "batch-73"]},
        "workers": [{"rank": 0, "status": "busy"}],
    },
    axes={"optimizer_step": 1024, "policy_version": 128},
)
```

Register its reachable endpoint in the shared server:

```bash
uv run rvx sources register --run RUN_ID --role learner \
  --endpoint http://127.0.0.1:9200
uv run rvx snapshots latest --run RUN_ID
uv run rvx snapshots history --run RUN_ID
uv run rvx query --run RUN_ID --field /progress/loss
```

`Source` owns a bounded native snapshot buffer, not a mandatory HTTP server.
For an existing FastAPI/Starlette app, use
`app.mount("/rvx", source.asgi())`; for aiohttp, use
`source.attach_aiohttp(app, prefix="/rvx")` before starting the app.
Register the host's reachable base URL plus `/rvx` as the Source endpoint.
Neither adapter creates another listener or owns the host's lifecycle.

`serve()` is the optional all-Rust HTTP path shown above.
`capture_batch` amortizes the Python/native boundary; `seal()` stops captures
while keeping history readable. `stop_serving()` stops only the owned native
listener: capture and mounted readers keep working with the same Session.
`close()` closes the Source and its own listener, never the attached host;
it does **not** acknowledge consumer persistence. Retention gaps are explicit.

Each role instance needs its own Source endpoint and fresh Session. Do not
register a load-balanced Service that mixes multiple instances under one URL.
The application chooses the capture boundary and supplies already available,
JSON-compatible state; the SDK does not synchronize GPU tensors or inspect
arbitrary application memory.

See [Source SDK and mounting](docs/source.md) and the
[wire/query contracts](docs/snapshots.md).

## Inspect and compare

Project, Experiment, and Run metadata remain separate from analytical Views.
The workspace inspects Source state, selects/replays historical versions,
compares full states, and plots numeric JSON-pointer paths across Runs.
Missing, deleted, null, or nonnumeric fields produce gaps, never carried-forward
values. `/metrics/cpu~1percent` selects a literal `cpu/percent` object key.
Numeric projections use float64 for plotting; raw snapshots and state diffs
retain exact supported integer values.

Exact browser views and exports require native `JSON.parse` source context
and `JSON.rawJSON`. Unsupported browsers show an upgrade error rather than
silently round snapshot numbers. Plotting still uses normal numeric arrays.

The read APIs are:

| POST endpoint | Purpose |
| --- | --- |
| `/api/snapshots/latest` | Latest full state for each selected Source |
| `/api/snapshots/history` | Bounded, paginated historical versions |
| `/api/snapshots/diff` | Added, removed, and changed fields between stored versions |
| `/api/snapshots/query` | Numeric field projections, optionally across Runs |

Metadata and explicit lifecycle controls remain under `/api/experiments/*`.
`RVX_URL` or `rvx --url URL` chooses the CLI server.

## Hostmon and existing data

Hostmon is a separate project and process, with its original collectors, alerts,
Prometheus `/metrics`, JSONL history, and UI. Its optional `[rvx_snapshots]`
producer exposes full observations on its existing HTTP server. RVX requires
neither hostmon nor its Python dependencies.

For hostmon integration, add `--hostmon-url http://127.0.0.1:9108` to `rvxd`
and register that URL as a Source with role `hostmon`. The optional hostmon
operational proxy is GET-only and restricted to status, catalog, collectors,
rules, and the GPU usage document. It is independent of snapshot persistence.

**The former MetricServer/log API and `/v1/metrics/*` producer protocol are
retired.** Existing numeric WAL/Parquet records, archived Sources, and metric
cursors are preserved as legacy read-only history. They are not converted into
invented runtime states. Structured history starts with the first new capture.
There is no Push ingestion endpoint or JSONL importer.

## Development

```bash
mkdir -p .build
TMPDIR="$PWD/.build" cargo test --locked --workspace
TMPDIR="$PWD/.build" uv run python -m unittest discover -s tests -v
npm --prefix web run check
npm --prefix web run test:e2e
```

Use isolated data directories. Process tests use `target/debug/rvxd`, or
`RVXD_BINARY` for a different build. Browser tests use their own fixture server;
install its browser with `cd web && npx playwright install chromium`.

The snapshot architecture is a new preview, not certified by earlier scalar
metric benchmarks or the old 24-hour soak. See
[architecture and operation](docs/rvx.md),
[industrial UI design](docs/ui_design.md), and
[third-party notices](THIRD_PARTY_NOTICES.md).
