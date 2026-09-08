# RVX architecture and operation

Status: **Pre-alpha / very early development**, with no backward-compatibility
guarantee. Earlier scalar-metric Beta results do not establish the performance
or reliability of this architecture.

This document describes the runtime behind the
[UX-first, charts-first interface](ui_design.md). The browser starts with
useful curves; complete snapshots remain the underlying evidence.

## Primary data and boundaries

RVX retains complete published runtime-state snapshots for asynchronous ML/RL
experiments: latest state, historical versions, replay, changes, and comparison.
Numeric trends are derived from those snapshots. There is no
independent metric/event `log` channel.

```text
Project -> Experiment -> Run -> Attempt -> Source -> Session -> Snapshot
```

One Source identifies one role instance endpoint. A Session identifies one
producer lifetime, and a monotonically increasing `sequence` identifies a
capture within it. Sequence is not optimizer step. Explicit axes may include
optimizer step, policy version, tokens, or environment step.

`observed_at_ns` is the caller's observation time; `ingested_at_ns` is storage
arrival time. Wall-time projections use the former. Cross-node clock skew
remains visible; RVX does not invent a shared distributed step or consistency
barrier.

Each state is a full JSON object, not a patch or a union of latest metrics.
Deleting a field means it is absent in the next capture. Null remains distinct
from absence. Numeric projection returns null for absent or nonnumeric values,
rather than carrying old values forward.

Applications own the observation boundary and decide which runtime fields are
public. The SDK does not serialize checkpoints, capture Python heaps, inspect
model internals, synchronize GPU tensors, or automatically make concurrent
application state consistent.

## Owners and data flow

```text
role's application state
        |
  Source.capture / capture_batch
        |
  native bounded immutable producer buffer
        |
  GET descriptor / latest / history
        |
  Rust Pull coordinator
        |
  full-state SQLite WAL transaction + cursor + derived chart index
        |
  chart catalog / numeric projection / exact observation / history / diff
        |
  Rust HTTP API -> TypeScript workspace / Python CLI
```

The producer owns capture validation, its Session, version assignment,
retention, and HTTP lifetime. The consumer coordinator owns scheduling,
timeouts, retry state, cancellation, and awaiting outstanding scrapes.
Producer eviction must be reported as a gap. A consumer cursor must not move
past records that have not been durably stored.

After a nonempty committed page, the coordinator promptly schedules the next
page through the same bounded concurrency pool. An empty page ends catch-up
and resumes the configured polling interval; failures also use that interval.
This handles count- and byte-limited pages without silently capping collection
at 64 snapshots per polling interval.

Raw states and new snapshot cursors live in a separate native-owned SQLite WAL
store. Metadata retains the existing Run/Source hierarchy and lifecycle.
Snapshot persistence and cursor advancement are transactional; numeric
projections do not create another primary data stream.

The numeric field/value/axis index is rebuildable from complete stored
snapshots. It avoids parsing raw historical documents for ordinary chart
requests and commits with the raw capture and cursor. It is not an independent
metric store or ingestion channel. Scalar WAL/hot/Parquet readers and their
compatibility APIs are removed; archived scalar files are not loaded.

## Code map

| Path | Responsibility |
| --- | --- |
| `rust/rvx-core` | Identity, shared snapshot contracts, validation, lifecycle types |
| `rust/rvx-snapshots` | Full-state producer buffer and HTTP Pull handlers |
| `rust/rvx-engine` | Registry, scheduler, durable snapshot store and read operations |
| `rust/rvx-server` | Authenticated control/read APIs, static UI, process lifetime |
| `rust/rvx-python` | Coarse PyO3 bindings and native producer runtime |
| `src/rvx` | Python SDK, control service, HTTP client CLI |
| `web/src/app` | Multi-run charts/tables, Run details, server workspace preferences and connection state |

Read [the shared contract](snapshots.md) first, then the engine/store, producer,
and API/UI consumers. Python is not on the standalone server's scrape or HTTP
request path. Python application calls still pay validation/encoding and FFI
costs; native HTTP does not mean Python capture is free.

## HTTP protocol and read APIs

Producers expose:

```text
GET /v1/snapshots/descriptor
GET /v1/snapshots/latest
GET /v1/snapshots/history?after=<next-sequence>&limit=<count>
```

The descriptor contains Source/Session identity and a state schema version,
not metric definitions. History uses inclusive cursors, bounded pages, and
explicit `dropped_before` information. Each whole snapshot must fit 4 MiB;
producer pages fit 16 MiB and at most 256 versions.

The consumer provides:

```text
POST /api/charts/catalog
POST /api/snapshots/query
GET  /api/snapshots/{id}
POST /api/snapshots/latest
POST /api/snapshots/history
POST /api/snapshots/diff
```

Latest pages are ordered by Source ID. History pages are ordered by stored
snapshot ID, newest first. Storage IDs are not Source-local versions.
History can be selected and replayed in chronological order.

Field paths use RFC 6901 JSON pointers relative to state. For example:
`/progress/loss`, `/metrics/cpu~1percent`.
Queries may compare multiple Run IDs, and explicit logical axes exclude
observations without that axis. Wall time is the query default; elapsed time
uses each Run's first observation, never its registration or ingestion time.
Catalog discovery indexes numeric object fields, not array contents.
Unindexed fields remain in raw state and must not masquerade as all-null
chart results. Every sampled chart observation retains its actual storage ID.

Diffs may compare versions from different Sources or Runs. Added/removed
fields remain distinct from a value changing to JSON null. Large diffs report
truncation rather than silently claiming to be complete.

Metadata/control APIs remain under `/api/experiments/*`. There is one numeric
query path, derived solely from snapshots; no legacy-query API remains.

## Server-owned UI state and connection telemetry

The UI uses these same-origin, authenticated endpoints:

```text
GET /api/ui/state
PUT /api/ui/workspaces
PUT /api/ui/browser
GET /api/ui/connection   (WebSocket upgrade)
```

`GET /api/ui/state` returns shared `{revision, sets}` workspace definitions
and a separate `{revision, theme, sidebar_width, selected, run_colors}` browser preference
document. An opaque HttpOnly, SameSite=Strict cookie identifies browser
preferences, not authentication. Theme, rail width, and Run colors can differ between
browsers; workspace layouts are shared. Data lives with registry metadata in
the current Engine-owned SQLite WAL database and survives process restarts.
`run_colors` contains at most 1,000 registered Run IDs mapped to six-digit
hex colors. Removing an override restores automatic palette assignment.
Old stored browser documents acquire an empty map without losing their
existing preferences; new browser writes include the full map.

Writes carry the expected revision and a mutation ID. They publish success
only after the transaction commits. A stale revision returns HTTP409 with the
current document; the client retains its working draft for explicit conflict
resolution. Shared-layout and per-browser revisions are independent. Retrying
the latest identical mutation is idempotent, not a second save. Limits and
layout validation prevent malformed, oversized, or orphaned panel definitions.
Deleting a workspace removes stale selection references without deleting Run
observations. A workspace's organizing experiment does not restrict explicit
reporter filters from Runs compared across experiments.

UI writes are limited to 2 MiB, with at most 100 shared workspaces and
24 panels/24 sections per workspace. The browser preference registry is
bounded at 10,000 identities and never silently evicts another browser's
settings. A missing or unknown browser cookie must bootstrap through
`GET /api/ui/state` before writing. The cookie is HttpOnly, SameSite=Strict,
and Secure when the explicitly configured public origin uses HTTPS.

The WebSocket validates both the existing authentication and the browser's
Origin on the GET handshake. Its only application message is a bounded
`{"type":"ping","id":"..."}` request and matching
`{"type":"pong","id":"..."}` response. The browser measures round-trip time
with its monotonic clock. This is connection telemetry, not snapshot Push
ingestion or an alternate metric stream. Reconnects use bounded backoff, and
server shutdown closes active sockets instead of waiting indefinitely.
Each server permits at most 128 concurrent sockets. Application messages
are limited to 1 KiB and ASCII ping identifiers to 64 bytes; sockets close
after 30 seconds without traffic or when exceeding 10 messages per second.

Visible charts and tables share continuous refresh. Table filters/sorting/page
are retained as new snapshots arrive, with page clamping when results shrink;
the UI does not retain an indefinite historical browse pin. Hidden pages
suspend expensive reads and resume when visible.

Workspace column preferences support optional `decimals` from 0 through 20;
omission preserves automatic display. Formatting never changes raw values,
sorting, filtering, or CSV export. Persisted filter definitions support optional
`enabled` (omission means true). The browser retains disabled definitions but
omits them, and the `enabled` property itself, from native table requests.
Native row sorting caches exact keys, partitions matching records to the
requested page, and sorts that page while retaining deterministic ties and
snapshot provenance.

## Lifecycle and retention

Run states are explicit:

```text
created -> running -> finished / failed / cancelled
```

Successful collection can start a Run, but temporary failures cannot finish
it. Terminal rollback is rejected. Terminal Run transitions stop remaining
Sources. Source control supports `draining`, `ended`, and `lost`; in-flight
scrapes cannot reactivate stopped Sources.

**Draining currently stops scheduling; it does not fetch a producer's final
history automatically.** Seal the producer while its HTTP server is still
available, allow the consumer to catch up, and only then end the Source.
Producer `close()` is not durability acknowledgment. Snapshot capture itself
only records into a bounded local producer buffer; durable retention begins
when the consumer commits it.

Capture frequency and pull frequency are different choices. To preserve each
training step, capture the complete published state at each desired step and
size retention for the longest expected scrape outage. Capturing only every
ten seconds cannot later reconstruct skipped intermediate states.

## Deploying a shared experiment server

Published wheels include the SDK, native daemon, and UI. After installation,
`rvx serve --data-dir PATH` uses packaged resources from any working directory;
it does not compile Rust or build JavaScript at startup.
For source development, use:

```bash
uv sync --locked
cargo build --locked --release -p rvx-server
npm --prefix web ci
npm --prefix web run build
uv run python scripts/package_assets.py --binary target/release/rvxd --ui web/dist
./target/release/rvxd --data-dir /absolute/path/to/rvx-data \
  --listen 127.0.0.1:9110 --ui-dir web/dist
```

Keep a persistent data directory and exactly one owner. SIGINT/SIGTERM shut
down serving and cancel/await the coordinator. Do not inspect live storage by
opening another `RvxService` or engine; use HTTP read APIs.

Without `RVX_API_TOKEN`, the server permits only loopback listeners and hosts.
Non-loopback binding requires a 32-256-character printable shared token.
When configured, workspace UI, data APIs, app assets, and health require authentication.
Browsers sign in at `/login` with the existing shared access password; the CLI
uses Bearer authentication through `RVX_API_TOKEN`. No password is accepted as a command
argument. Keep environment files outside source control with owner-only access.

Only `/login`, `/login/`, isolated `/login/assets/` resources, and
`GET /api/auth/session` are public read surfaces. Login posts the password to
`POST /api/auth/login`; `POST /api/auth/logout` revokes the current session.
Both POSTs require the same-origin Origin header. The separate login build
loads no private application assets before authentication.

Browser sessions use opaque HttpOnly/SameSite=Strict cookies and expire after
seven days. The server persists only a domain-separated keyed digest and expiry
in its existing metadata database. Sessions survive process restarts; logout
revokes them, and changing `RVX_API_TOKEN` invalidates earlier sessions.
Cookies are Secure when the explicitly configured public origin uses HTTPS.
The preference cookie is independent and is not removed at logout. Browser
Basic challenges are no longer used. Cookie expiry/revocation also retires
authenticated WebSockets; an active UI can renew authentication in place
without discarding its current draft.

Authenticated remote browser POST requests must still be same-origin;
origin-free authenticated CLI requests remain supported. Responses cannot be
framed, and authenticated content is marked private/no-store.
HTTP itself is not encrypted: use a secure tunnel or HTTPS reverse proxy on
untrusted networks. For HTTPS termination set `RVX_PUBLIC_ORIGIN` to the exact
external origin; forwarded headers alone never override the policy.
This is a shared administrative credential, not multi-user authorization.

In a cluster, one shared persistent server can hold many Projects and
Experiments. A per-training-job database cannot provide shared comparison by
itself. Source endpoints must address individual producers; a load-balanced
Service that mixes Sessions is invalid. Kubernetes registrar/controller,
automatic Pod identity reconciliation, multi-writer storage, and HA are not
implemented.

The control hierarchy can be managed with:

```bash
rvx projects create async-rl
rvx experiments create --project PROJECT_ID grpo
rvx runs create --experiment EXPERIMENT_ID trial-1
rvx sources register --run RUN_ID --role learner --endpoint http://learner-0:9200
rvx snapshots latest --run RUN_ID
rvx snapshots history --run RUN_ID
rvx query --run RUN_ID --field /progress/loss
```

`RVX_URL` or `--url` overrides the default `http://127.0.0.1:9110`.
See [the Source SDK guide](source.md) for standalone serving, ASGI/aiohttp
mounting, and independent data/HTTP lifetimes. Mounted adapters dispatch through
the Python host and offload Rust serialization from its event loop; optional
native `serve()` avoids Python request dispatch entirely.

## Hostmon as an ordinary producer

Hostmon remains a separate Python monitor. Its original collectors, alert
rules/outbox, JSONL writer, Prometheus endpoint, and UI remain independent.
Its optional `[rvx_snapshots]` observation producer exposes `/v1/snapshots/*`.

Hostmon captures complete current measurements and fields, public collector
health/documents with their freshness metadata, and public alert observations.
It does not export arbitrary internal plugin state, options, configuration,
or private delivery state. Optional collectors can contribute cached results;
their observation ages are preserved.

Register its reachable base URL as a Source with role `hostmon`. There is no
special hostmon proxy, server flag, or mirrored administration dashboard.
Fresh snapshot Sessions use their own cursor namespace. Structured history
begins with actual captures: old scalar records are not fake snapshots.
Original hostmon JSONL files and retired RVX scalar archives are neither
deleted nor backfilled; the snapshot-only runtime does not read those archives.

## Performance evidence and limits

The snapshot architecture preserves full-state fidelity at the cost of larger
payloads and derived-index write work. Serialized size, nesting, nodes, page size, count
retention, and byte retention are bounded. Those bounds are not a throughput
or whole-process RSS guarantee.

Old scalar-only benchmarks do not describe this implementation and are not
performance claims for RVX. There is no head-to-head W&B or Prometheus benchmark.
Large-scale healthy-target, multi-node RL, and long-duration snapshot workloads
still need their own controlled measurements.
