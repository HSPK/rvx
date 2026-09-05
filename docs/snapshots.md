# Snapshot-first contract

RVX's primary data is a versioned **structured runtime state snapshot**.
Keep latest state and historical snapshots for replay, change inspection,
cross-Run comparison, and numeric field projections. There is no independent
metric logging channel. A capture fully replaces the previous state; missing
fields are absent, not carried forward.

This is an observation of a role's published state, not a memory image or
model checkpoint. Each Source has its own consistency boundary. Combining
Sources by time does not imply a distributed atomic snapshot.

## Producer protocol

```text
GET /v1/snapshots/descriptor
GET /v1/snapshots/latest
GET /v1/snapshots/history?after=N&limit=M
```

The descriptor contains `protocol_version: 1`, `source_session_id`, `project`,
`experiment`, `run_id`, `attempt_id`, `role`, optional `rank`, `node_id`, `pid`,
`labels`, and `schema_version: 1` (the currently supported envelope schema).
It has no metric definitions.

A snapshot is:

```json
{
  "source_session_id": "session-example",
  "sequence": 12,
  "observed_at_ns": 1788595200000000000,
  "schema_version": 1,
  "axes": {"optimizer_step": 1024, "policy_version": 128},
  "state": {
    "phase": "training",
    "progress": {"step": 1024, "loss": 0.184},
    "queue": {"ready": 8, "inflight": ["batch-72", "batch-73"]},
    "workers": [{"rank": 0, "status": "busy"}]
  }
}
```

`sequence` is the Source-local snapshot version/cursor, not a training step.
It is monotonic within a Session; fresh sessions may begin at zero. State
must be a JSON object and may contain nested objects, arrays, strings,
booleans, nulls, and finite numbers. Snapshot observations do not merge with
earlier values.

The latest endpoint returns one snapshot, or HTTP 503 before the first capture.
History returns:

```json
{
  "protocol_version": 1,
  "source_session_id": "session-example",
  "oldest_sequence": 0,
  "next_sequence": 0,
  "dropped_before": null,
  "snapshots": []
}
```

This empty page is returned before the first capture. `after` is
an inclusive next sequence. `next_sequence` covers returned snapshots only;
it must not jump past unreturned pages. `dropped_before` is null unless the
requested cursor has expired. A fresh `after=0` starts at retained history.
Reject negative/future cursors and invalid limits. Each full snapshot is at
most 4 MiB, JSON nesting at most 64 levels below the state root (depth zero),
state at most 100,000 JSON nodes, and a history page at most 16 MiB.
Default page limit is 64 and maximum is 256; reduce page count to the byte
budget without dropping a snapshot. Empty objects are valid states.
Every child, including a scalar, increments depth. State integers must fit
signed or unsigned 64 bits; floating values must be finite.

Producer history is bounded by count and accounted bytes. Eviction and
validation failures must be explicit. `seal()` freezes capture but continues
serving history; closing HTTP never implies consumer acknowledgment.

## Native public contracts

The shared Rust core exports:

- `SnapshotDescriptor`
- `StateSnapshot` (producer snapshot above)
- `SnapshotHistoryResponse`
- `StoredSnapshot` (snapshot fields flattened, plus `id`, `run_id`,
  `source_id`, `ingested_at_ns`)
- `SnapshotLatestRequest` / `SnapshotLatestResponse`
- `SnapshotHistoryRequest` / `SnapshotHistoryPage`
- `SnapshotQueryRequest` / `SnapshotQueryResponse`
- `SnapshotDiffRequest` / `SnapshotDiffResponse`

The engine owns `snapshot_latest`, `snapshot_history`, `snapshot_query`,
and `snapshot_diff`, each accepting the corresponding request by reference.
Only the native Pull coordinator ingests new snapshots. Cursor advancement
and full-state persistence must be atomic and durable.

Raw snapshots are stored independently of legacy numeric WAL/Parquet data.
The first snapshot store uses Rust-owned SQLite WAL transactions with full
state JSON, indexed Source/Session/sequence and observation time, and bounded
reads. Numeric trends are derived on read, not independently ingested.
Legacy metric data remains readable through explicitly legacy query APIs;
it must not be fabricated into full historical state.

## Consumer APIs

All requests below are POST JSON read operations on the standalone RVX API.

### `/api/snapshots/latest`

Request: `run_id`, optional `source_ids` (default empty/all),
`limit` (default 100), `after_source_id` (default null).
Response: `snapshots: StoredSnapshot[]`, `next_source_id: string|null`.
Use deterministic Source ordering and the same 16 MiB page budget.

### `/api/snapshots/history`

Request: `run_id`, optional `source_ids`, `before_id`, `from`, `to`,
`limit` (default 100). Times are observation nanoseconds.
Response: `snapshots: StoredSnapshot[]`, `next_before_id: integer|null`.
Newest stored IDs first; callers can replay a selected page chronologically.
Storage IDs are distinct from producer-local sequences.

### `/api/snapshots/query`

Request: `run_ids`, `paths`, optional `source_ids`, `axis` (default `wall_time`),
`from`, `to`, `max_points` (default 1600).
Range bounds use the selected axis's units: observation nanoseconds for
`wall_time`, or logical coordinates for an explicit axis.
Paths are RFC 6901 JSON pointers relative to `state`, e.g. `/progress/loss`.
The hostmon key `metrics["cpu/percent"]` is `/metrics/cpu~1percent`.
Response: `axis`, `series`, with each series containing `run_id`, `source_id`,
`path`, `source_session_ids`, `sequences`, `axes`, `observed_at_ns`, `values`.
`values` contains numbers or null. Missing, null, boolean, and nonnumeric
fields produce null, never a previous value. Missing explicit logical axes
exclude that observation. Point limits bound visual output, not raw storage.
Downsampling retains actual missing observations rather than connecting
numeric points across a known gap. A tight point budget may therefore omit
an earlier numeric point to preserve a gap and the latest observation.

Reads accept at most 64 Runs, 64 paths, and 256 Source IDs. Each projection
scans at most 100,000 snapshots / 256 MiB, retains at most one million
projection cells, and returns at most 100,000 total points / 16 MiB.
`max_points` is 1..10,000 per series. Exceeding a budget returns an explicit
error requesting narrower filters, not silently truncated history. Logical
axis bounds do not reduce the observation-index scan; narrow Source/Run
selection for those queries. Latest/history pages accept at most 256 records.

### `/api/snapshots/diff`

Request: `before_id`, `after_id`.
Response: those IDs, `changes`, and `truncated: boolean`.
Each change has `path`, `kind` (`added`, `removed`, `changed`) and optional
`before`/`after` JSON values. Omitted and JSON-null values remain distinct.
Changes are bounded; report truncation explicitly. Records may come from
different Runs for cross-experiment comparisons.

`/api/experiments/*` continues to own Project/Experiment/Run/Source metadata.
Stats add `snapshots` (durable row count), separate from legacy metric counters.
Legacy `/api/experiments/query` remains read-only for existing numeric history.

## Python producer and control API

`Source(...)` allocates a producer without starting a server.
`serve(host=..., port=...)` optionally starts native HTTP; `asgi()` and
`attach_aiohttp(app, prefix="/rvx")` borrow an existing Python host instead.
`capture(state, observed_at_ns=None, axes=None)` returns a `CaptureReceipt`
whose `sequence` identifies that version.
`capture_batch([SnapshotEvent(...), ...])` atomically captures multiple full
objects. `stats`, `seal`, `close`, context management, and fresh-session
semantics remain. `stop_serving()` leaves the data Source alive, while
`close()` closes it without stopping an attached host app. Context management
does not implicitly serve. Public `SnapshotServer`/`SnapshotServerStats` are
now `Source`/`SourceStats`; the old metric logging exports remain removed.

Consumer PyO3/Python APIs expose the four snapshot read operations above.
CLI commands are `snapshots latest`, `snapshots history`, `snapshots diff`,
and `query --run RUN_ID --field /path` (time by default).

## Hostmon boundary

Hostmon remains independent of the RVX package. Its optional producer publishes
full observation state: numeric measurements, structured fields, public
collector results/documents and their freshness metadata, and alert observations.
Do not publish configuration credentials or dump the entire internal state.
Original monitoring, JSONL recording, Prometheus output, and UI remain unchanged.

Previously stored numeric history cannot reconstruct missing task/worker state.
The full-state history begins at this refactor's deployment, while old data
remains separately readable.
