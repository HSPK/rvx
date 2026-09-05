# RVX architecture and operation

Status: snapshot-first preview. Earlier scalar-metric Beta results do not
establish the performance or reliability of this architecture.

## Primary data and boundaries

RVX retains complete published runtime-state snapshots for asynchronous ML/RL
experiments: latest state, historical versions, replay, changes, and comparison.
Numeric trends are read-time projections from those snapshots. There is no
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
  full-state SQLite WAL transaction + snapshot cursor
        |
  latest / historical page / diff / numeric projection
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

The legacy numeric WAL/hot/Parquet read path is retained only to read existing
data. Old metric descriptors and archive identities are not evidence that
full structured state existed in that history.

## Code map

| Path | Responsibility |
| --- | --- |
| `rust/rvx-core` | Identity, shared snapshot contracts, validation, lifecycle types |
| `rust/rvx-snapshots` | Full-state producer buffer and HTTP Pull handlers |
| `rust/rvx-engine` | Registry, scheduler, durable snapshot store and read operations |
| `rust/rvx-server` | Control/read APIs, static UI, optional hostmon proxy, process lifetime |
| `rust/rvx-python` | Coarse PyO3 bindings and native producer runtime |
| `src/rvx` | Python SDK, control service, HTTP client CLI |
| `web/src/rvx` | Browser/navigation, analysis workspace, state/projection views |

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

The consumer provides POST read operations:

```text
/api/snapshots/latest
/api/snapshots/history
/api/snapshots/diff
/api/snapshots/query
```

Latest pages are ordered by Source ID. History pages are ordered by stored
snapshot ID, newest first. Storage IDs are not Source-local versions.
History can be selected and replayed in chronological order.

Field paths use RFC 6901 JSON pointers relative to state. For example:
`/progress/loss`, `/workers/0/queue_depth`, `/metrics/cpu~1percent`.
Queries may compare multiple Run IDs, and explicit logical axes exclude
observations without that axis. Wall time is the default.

Diffs may compare versions from different Sources or Runs. Added/removed
fields remain distinct from a value changing to JSON null. Large diffs report
truncation rather than silently claiming to be complete.

Metadata/control APIs remain under `/api/experiments/*`. The old numeric query
API remains explicitly legacy and read-only; it is not the source for the new
snapshot workspace.

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

The server accepts loopback listeners only and has no public authentication.
Local CLI requests may omit Origin; browser mutations must be same-origin.
Use secured tunneling for remote access.

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

## Hostmon migration and compatibility

Hostmon remains a separate Python monitor. Its original collectors, alert
rules/outbox, JSONL writer, Prometheus endpoint, and UI remain independent.
Only its optional observation producer changes to `[rvx_snapshots]` and
`/v1/snapshots/*`.

Hostmon captures complete current measurements and fields, public collector
health/documents with their freshness metadata, and public alert observations.
It does not export arbitrary internal plugin state, options, configuration,
or private delivery state. Optional collectors can contribute cached results;
their observation ages are preserved.

Upgrade producer and consumer together, retain the original Source URL and Run
identity, and keep the same RVX data directory. Fresh snapshot Sessions use
their own cursor namespace. Do not import old scalar records as fake snapshots.
Old numeric history stays readable; original hostmon JSONL files are neither
deleted nor backfilled.

The optional `--hostmon-url` proxy remains separate from storage. It allows
GET only for status, catalog, collectors, rules, and the GPU usage report.
It follows no redirects, forwards no browser credentials, and has no arbitrary
target URL. Unreachable hostmon returns 502 without disabling stored reads.
`/hostmon` redirects to the original dashboard; only settings/layouts navigation
query values are allowlisted.

## Performance evidence and limits

The snapshot architecture trades full-state fidelity for larger payloads and
read-time projection work. Serialized size, nesting, nodes, page size, count
retention, and byte retention are bounded. Those bounds are not a throughput
or whole-process RSS guarantee.

Former scalar-only measurements remain historical, not snapshot acceptance:

| Previous workload | Historical result |
| --- | --- |
| Synthetic metric WAL ingestion | 142k-163k scalar points/s |
| Scalar Parquet compaction | 569k-587k values/s |
| Scalar-only 24-hour synthetic soak | 8,628,500 points; 181.12 MiB maximum RSS |
| 10,000 registered endpoints | Mostly failing endpoints, not 10,000 healthy producers |

These numbers cannot be compared directly with structured capture/Pull/query
throughput, and there is no head-to-head W&B or Prometheus benchmark.
Large-scale healthy-target, multi-node RL, and long-duration snapshot workloads
still need their own controlled measurements.
