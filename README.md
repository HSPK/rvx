# RVX

> **Pre-alpha / very early development.** RVX is evolving rapidly and is not
> presented as production-ready. APIs, data/configuration formats, and UI
> behavior may change without backward-compatibility guarantees.
> The [UX-first, charts-first design](docs/ui_design.md) defines the current
> product direction.

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
numbers are retained. Time alignment uses actual observations, not ingestion
time or a synthetic global training step.

This is a published runtime observation, **not a model checkpoint or process
memory dump**. Each Source has its own consistency boundary; RVX does not
claim a globally atomic snapshot across asynchronous roles.

## Install a release

The `rvx` PyPI distribution is one complete package: Python SDK, internal
native extension, native `rvxd` executable, and the built Web UI.
Prebuilt wheels target Linux x86_64/arm64 (glibc 2.28+) and macOS
x86_64/arm64 (11+), with Python 3.11+. Rust and Node are not required by users.

```bash
uv tool install rvx
rvx serve --data-dir /absolute/path/to/rvx-data
```

Version `0.2.0` includes the charts-first workspace, browser sign-in, and snapshot
Bar/Status views. The older `0.1.0` release predates this redesign; published
releases are immutable. Back up persistent storage before upgrading this
Pre-alpha application.

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

The default listener is loopback-only. Non-loopback listeners require a strong
`RVX_API_TOKEN`; workspace UI, assets, health, and data APIs then require
authentication. Only the isolated sign-in page/assets and authentication
endpoints are public. Browser state-changing/read POST requests remain same-origin.
Automatic Kubernetes discovery/registration is not included.

### Authenticated network access

Set `RVX_API_TOKEN` in a protected environment file or secret manager (32-256
printable ASCII characters), then start with `--listen 0.0.0.0:9110`.
Do not put the secret in command-line arguments or source control.

Browsers use RVX's sign-in page and the existing `RVX_API_TOKEN` as the server
access password. The primary password is never stored in browser storage or
URLs. A revocable HttpOnly, SameSite=Strict session cookie lasts up to seven
days and survives server restarts. Signing out revokes that session; changing
the server password invalidates existing sessions. The CLI continues to send
the same environment variable as a Bearer token.
Authentication also applies to local requests when the token is configured.

Expired sessions can be renewed in place without losing unsaved workspace
changes. Sign-out offers the existing save/discard guard. Browser preferences
remain separate from authentication and are retained when signing out.

HTTP authentication does not encrypt traffic. Use a secured tunnel or HTTPS
reverse proxy on untrusted networks. For HTTPS termination, configure
`RVX_PUBLIC_ORIGIN=https://your-rvx-host` explicitly and preserve authentication
and browser-origin headers through the proxy. RVX does not trust arbitrary
`X-Forwarded-*` headers to override its origin policy. Hostmon and independently
served Source endpoints retain their own access policies.

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

## Analyze and compare

Runs and Charts share one analysis workspace. Filter Runs by Project and
Experiment, then toggle them to add or remove their curves immediately.
Comparison is native: there is no Compare action or separate Run-chart page.
The compact selector sits beside charts on desktop and opens as a sheet on
mobile. Header and Run controls stay fixed while chart content scrolls.
The interface has a light default and dark alternative.
The compact header identifies the current workspace and uses one Save/Saved
slot beside the name: Save for edits, Saving during submission, and Saved for
three seconds after server persistence. The anchored workspace picker switches
views in place; its pencil (or F2 on the name) renames the existing workspace
without saving unrelated panel edits.
Switching or resetting an
edited layout asks whether to save, discard, or cancel; failed writes keep
the draft and never claim it was saved.

The [workspace](docs/ui_design.md) provides one **Add** entry
point with tabs for multi-metric charts, metric statistics tables, structured
snapshot tables, and shallow sections. Metrics can be added as independent charts or
explicitly combined when their units permit it. Real previews and display
settings remain isolated until Add or Save; Cancel leaves the workspace intact.

Centered panel titles support dragging within/across sections without a separate
grip gutter. Fullscreen remains in the options menu; concise cursor readouts show
multiple Runs beside the hovered point instead of in a permanent footer.
Snapshot collections can be displayed as tables, category bars, or task-state
grids from the same full JSON path. Bars aggregate the full filtered collection
and keep Runs/reporters separate. State grids use stable identity fields,
virtualized cells, full-scope counts, and pinned task details rather than raw
snapshot downloads. These are current-state views, not historical event heatmaps.

Tables support sorting, search/filtering, column configuration and paging.
Numeric columns can display Auto or 0-20 decimal places without changing
raw values or exports. Filters can be enabled, disabled, and edited while
retaining their saved definitions.
Metric summaries use all numeric
observations in the selected range, not sampled chart points; structured tables
use explicit per-Source snapshots with stable pagination.

Open the Run details drawer from a Run's information action or its selected
name to see status, identity, project, experiment, timestamps and configuration.
Configuration previews are bounded and preserve exact integers; the download
contains the complete original configuration. Opening details does not change
the chart selection.

The point/table **Inspect** feature and raw-snapshot UI are removed. Stored
snapshots and their APIs/CLI remain unchanged. There are no nested boards,
split panes, or layout migration chains.
Named workspace definitions are stored on the server and shared across
browsers. Theme, Run color overrides, resizable sidebar width and active-workspace preference
are separately server-stored for each browser using an opaque cookie.
Revision checks prevent silent overwrites of another browser's saved edits.
Old browser-only preferences remain untouched rather than automatically
overwriting server definitions. Combined plots
currently require compatible units, and CSV export covers the displayed page.

The workspace defaults to **Since first observation**, aligning each Run to
its earliest retained observation, not its registration time. Selecting another
Run preserves the metric set, chart instances, zoom, and chosen axis. Observation
wall time and recorded logical axes remain available.
The concise picker offers **15m, 1h, 6h, 24h, 3d, 7d, All**, and **Custom**.
Run selection and time bounds remain URL state; saved workspaces contain
panels, sections, and table configuration rather than transient hover or page
positions.
Visible charts and tables refresh continuously on the same cadence; there is
no Live/Pause toggle or table Refresh action. Table searches, filters, sorting
and pagination survive fresh data. The header connection dot reports a real
WebSocket heartbeat, with round-trip latency available on hover.
Missing, deleted, null, or nonnumeric fields produce gaps, never carried-forward
values. `/metrics/cpu~1percent` selects a literal `cpu/percent` object key.
Numeric projections use float64 for plotting; raw snapshots and state diffs
retain exact supported integer values.
Independent Source reporters are not silently averaged. Raw JSON remains
available on demand and exact.

Exact browser views and exports require native `JSON.parse` source context
and `JSON.rawJSON`. Unsupported browsers show an upgrade error rather than
silently round snapshot numbers. Plotting still uses normal numeric arrays.

The read APIs are:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/charts/catalog` | Discover fields, reporter scope, defaults, and observed time bounds without loading full state |
| `POST /api/snapshots/query` | Snapshot-derived curves with actual observation IDs |
| `GET /api/snapshots/{id}` | Exact full observation behind a chart point |
| `POST /api/snapshots/latest` | Latest full state for each selected Source |
| `POST /api/snapshots/history` | Bounded, paginated historical versions |
| `POST /api/snapshots/diff` | Added, removed, and changed fields between stored versions |

Metadata and explicit lifecycle controls remain under `/api/experiments/*`.
`RVX_URL` or `rvx --url URL` chooses the CLI server.

## Hostmon and existing data

Hostmon is a separate project and process, with its original collectors, alerts,
Prometheus `/metrics`, JSONL history, and UI. Its optional `[rvx_snapshots]`
producer exposes full observations on its existing HTTP server. RVX requires
neither hostmon nor its Python dependencies.

Register the hostmon HTTP URL as an ordinary Source with role `hostmon`.
No hostmon-specific server flag, proxy, or mirrored dashboard is needed.

The runtime is snapshot-only: no scalar WAL/Parquet reader, independent metric
log, Push ingestion endpoint, or JSONL importer. Existing structured snapshots
remain the source of truth; chart indexes can be rebuilt from them. Retired
scalar archives may be kept offline, but are neither loaded nor converted
into invented runtime states. Back up persistent storage before upgrading
this Pre-alpha application, and never run two owners on the same directory.

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
[UI design](docs/ui_design.md), and
[third-party notices](THIRD_PARTY_NOTICES.md).
