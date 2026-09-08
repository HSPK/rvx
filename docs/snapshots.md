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
- `ChartCatalogRequest` / `ChartCatalogResponse`

The engine owns `snapshot_latest`, `snapshot_history`, `snapshot_query`,
`snapshot_diff`, and `chart_catalog`, each accepting the corresponding request
by reference, plus `snapshot_get` for a stored ID.
Only the native Pull coordinator ingests new snapshots. Cursor advancement
and full-state persistence must be atomic and durable.

The snapshot store uses Rust-owned SQLite WAL transactions with full
state JSON, indexed Source/Session/sequence and observation time, and bounded
reads. A rebuildable numeric field/value/axis index is derived from snapshots
and committed atomically with raw state and cursor advancement. Absent indexes
are rebuilt from valid stored snapshots without changing IDs or inventing data.
No scalar WAL/Parquet readers or legacy query APIs remain.

## Consumer APIs

The charts-first interface uses the following current snapshot APIs. Obsolete
scalar metric APIs, hostmon dashboard proxies, and compatibility routes are
removed by this refactor. Authentication and same-origin protections remain.

### `POST /api/snapshots/records`

This bounded projection shares the table row request fields and exact-cell
response, adding required `identity_paths` and an aligned `identities` array.
It accepts 1-2,048 rows per page (default 1,000), while `/api/tables/rows`
retains its 256-row maximum.

Identity fields contain strings or exact signed/unsigned 64-bit integers.
Their composite identity is scoped by Run and Source. Missing/null/container/
floating identities and duplicates anywhere in the full filtered collection
are errors, even if the duplicate is outside the requested page. `$key` is
allowed only for object collections, never array positions.

Without explicit sorting, records are identity-ordered within each Source and
interleaved across Sources before pagination. This avoids one large publisher
monopolizing a multi-Run page. Returned row keys and snapshot IDs still identify
the immutable record for bounded detail reads. Display fields may be missing,
and empty collections remain valid zero-row observations. Filtering/sorting
keeps explicit validation; unsupported criteria are not silently dropped.

An explicit `sort: {"path": "/progress", "direction": "asc"}` orders the entire
filtered dataset **before pagination**, not just the first 1,000 records or
bounded display previews. `desc` reverses field order; ties retain stable
Run/Source and exact identity order, independent of source-array positions.
Numeric ordering preserves exact integers beyond JavaScript's safe-integer
range. Existing type order is missing, null, boolean, number, string, array,
object in ascending order, reversed for descending; missing/null are not zero.
Returned rows retain their Run, Source, original row key, and snapshot
provenance; aligned identities stay scoped to Run/Source.

#### Snapshot Status grid configuration

The canonical `snapshot-table` panel can store a `view` with
`type: "status-grid"`. Its existing `density` (`compact` or `comfortable`)
remains required. Optional configuration is:

| Field | Accepted value | When omitted |
| --- | --- | --- |
| `sort` | `{"path": "/progress", "direction": "asc"}` or `desc` | Source-fair stable identity order |
| `columns` | Integer 1–64 | Automatic responsive columns |
| `cellSize` | Integer 12–40, CSS pixels | Legacy density size: compact 15, comfortable 23 |
| `shadePath` | Numeric field selector | Uniform intensity within each status |
| `shadeScale` | `log` or `linear` | Logarithmic, when shading is enabled |
| `gap` | Integer 2–12, CSS pixels | 5 CSS pixels |

Sort and shade fields accept the record root (`""`), `$key`, `$value`, or valid RFC 6901
pointers; malformed escapes and NUL characters are rejected. Explicit null,
unknown fields, invalid types, and out-of-range values are rejected, not
silently defaulted. Older documents keep omitted options absent when saved.

The client sends `view.sort` to the records endpoint, independently of the
retained Table `query.sort`. This is automatic field-based ordering, not manual
cell dragging. Rendering keeps the server's record order within each existing
Run/Source/group section; Sources are not merged into a global visual grid.
A chosen column count is a responsive upper bound, not a forced overflow.
Columns, size, gap, density, and appearance change presentation only, never
measurements, identity, aggregation, or source provenance.

With `shadePath`, the records projection includes that field, and the same
pinned state-count aggregate also requests its `min` and `max`. Min measures
include `minimum_magnitude`, an exact `TableCell` containing the smallest nonzero
absolute numeric value in that Source/group, or missing when none exists.
Numeric strings and null/missing values never contribute to this anchor.
All selected Sources and pages share the resulting full-filtered-dataset scale.
The default signed log transform is `sign(x) * log1p(abs(x) / a)`, where `a`
is the global smallest nonzero magnitude; this separates common values from
large outliers without changing state hues or measurements. `shadeScale: "linear"`
retains min-max normalization. Switching scales only reuses cached statistics.
Extrema and exact integers are
not rounded before normalization. Constant fields use a uniform midpoint.
Missing, null, nonnumeric and truncated cell values have an explicit
unavailable-shading marker instead of being treated as zero. Omitting
`shadePath` restores state-only color without changing the snapshot data.

### `POST /api/snapshots/aggregate`

Aggregate the latest or explicitly pinned collection after applying all search
and filter criteria, independently of any record page:

```json
{
  "run_ids": ["run-id"],
  "path": "/workers",
  "group_by": ["/queue"],
  "measures": [
    {"id": "tasks", "op": "count"},
    {"id": "gpus", "op": "sum", "path": "/running_gpus"}
  ],
  "order": {"measure": "gpus", "direction": "desc"},
  "limit": 20
}
```

Responses contain `groups`, `total_groups`, `matched_rows`, `offset`, `limit`,
and `snapshots`. A group has a full canonical typed `key`, display `cells`,
and separate `series` per Run/Source. Each series includes its snapshot ID and
named measures containing an exact `TableCell` value plus `count`, `missing`,
`non_numeric`, and `approximate` accounting. Missing categories are absent
series, not invented zeros.

Supported operations are count, sum, min, and max. Integer sums use exact
128-bit arithmetic; min/max retain original numeric text. Floating-point sums
are explicitly approximate and reject nonfinite results. Numeric strings are
not coerced. Missing/null group values remain distinct.

Pagination selects global category keys with every contributing Source still
present. Measure ordering ranks a category by its maximum Source value without
merging Source values. Grouping supports up to two fields and eight measures,
50,000 categories, and 256 returned categories per page (default 50). Existing
snapshot, text-work, node, cancellation, and response-size budgets remain in
force. State grids pin their full-scope counts to the record-page snapshot IDs.

Collection discovery also includes bounded observed `kinds` per column and
`collection_kinds` per collection. These guide field selectors, not validation
or automatic conversion of missing/mixed values.

### `POST /api/charts/catalog`

Request: `{"run_ids": ["run-id", "..."]}`.
Response:

```json
{
  "runs": [
    {
      "run_id": "run-id",
      "snapshot_count": 2,
      "first_observed_at_ns": 1000000000,
      "last_observed_at_ns": 2000000000
    }
  ],
  "metrics": [
    {
      "path": "/progress/loss",
      "name": "Loss",
      "group": "Training",
      "unit": null,
      "run_ids": ["run-id"],
      "sources": [
        {
          "run_id": "run-id",
          "source_id": "source-id",
          "label": "Learner",
          "role": "learner",
          "rank": 0,
          "node_id": "node-a",
          "primary": true,
          "latest_value": 0.25,
          "observed_at_ns": 2000000000
        }
      ]
    }
  ],
  "defaults": ["/progress/loss"],
  "axes": ["wall_time", "elapsed", "optimizer_step"],
  "truncated": false
}
```

Run observation timestamps are null before any stored capture. Catalog fields
remain discoverable after they disappear from the latest state; a missing or
nonnumeric latest value is null, not a previous numeric value.

The catalog is derived from stored snapshots, never a new logging channel.
It returns metadata and current scalar summaries, not full state documents.
Primary reporters are unambiguous single reporters or explicitly declared by
the Source label `rvx.primary = "true"`; multiple undeclared reporters remain
separate. No implicit averaging is introduced.

The initial catalog indexes bounded numeric object fields, excluding array
contents from automatic discovery. Metadata/IDs and collector internals are
not default charts. Default chart ordering favors recorded training, pipeline,
throughput, and resource fields through explicit naming conventions; unknown
units remain null. Truncation is explicit. Full original state is retained
regardless of chart indexing.

Discovery visits at most 8,192 nodes per capture, expands objects with at most
256 entries, and retains at most 4,096 chart fields per Source. Already known
fields continue to update even if an object subsequently exceeds the discovery
limit. A catalog returns at most 16,384 reporter records, 256 logical axes, and
16 MiB. Fields excluded from indexing are not represented as invented null
series: explicit queries fail when index coverage is insufficient.

Shared Rust types are `ChartCatalogRequest`, `ChartCatalogResponse`,
`ChartRunInfo`, `ChartMetric`, and `ChartMetricSource`; the Engine method is
`chart_catalog(&ChartCatalogRequest)`.

### `POST /api/tables/summary`

Request:

```json
{"run_ids":["run-id"],"source_ids":["source-id"],"paths":["/progress/loss"],"axis":"elapsed","from":0,"to":1000000000}
```

`source_ids`, `axis`, `from`, and `to` are optional. Unlike the historical
chart query default, the summary default axis is **elapsed**. Range units,
inclusive bounds, Run observation baselines, logical-axis exclusion, and
numeric-index coverage checks are the same as `/api/snapshots/query`.

```json
{
  "axis":"elapsed",
  "rows":[{
    "run_id":"run-id","source_id":"source-id","path":"/progress/loss",
    "observations":4,"count":3,"missing":1,"current":null,
    "minimum":0.1,"average":0.2,"p95":0.3,"maximum":0.3,
    "snapshot_id":"42","observed_at_ns":1000000000
  }]
}
```

Each row describes one Run/Source/path, never an average across asynchronous
Sources. `observations` counts actual matching snapshots; `count` counts
finite indexed numbers; `missing = observations - count` includes missing,
null, boolean, and other nonnumeric values. `current` is the value in the last
matching actual observation ordered by observation time then stored ID,
including null when that capture no longer contains a number. Its evidence ID
and time remain present in that case. With no matching snapshots, all statistics,
`current`, the evidence ID, and time are null, and the three counts are zero.
Selected registered Sources without this numeric field still receive honest
missing-only rows. A path must be indexed somewhere in the selection; excluded
or incompletely covered index subtrees produce an error, not invented absence.

Min/average/p95/max use **every** finite numeric index value, not chart samples.
P95 is nearest rank `ceil(0.95 * count)`. The numeric index is `f64`; this API
does not promise exact integer statistics beyond `f64` precision. Complete raw
snapshots and structured table cells retain signed/unsigned 64-bit integers.
The shared index scan limits (100,000 observations, one million projection
cells, 256 MiB scanned index data) apply before computing statistics. Budget
failures are actionable HTTP 400 errors, never partial successful summaries.

### `POST /api/tables/catalog`

Request: `{"run_ids":["run-id"],"source_ids":["source-id"]}`.
`source_ids` is optional. The response is
`{"tables":TableDefinition[],"truncated":false}`. Each definition is:

```json
{
  "path":"/workers","name":"workers",
  "columns":[{"path":"$key","name":"Key"},{"path":"/rank","name":"rank"}],
  "sources":[{
    "run_id":"run-id","source_id":"source-id","label":"worker",
    "role":"worker","rank":null,"node_id":null,
    "snapshot_id":"42","observed_at_ns":1000000000,"row_count":2
  }]
}
```

Discovery reads complete current Source snapshots and merges equal collection
paths without merging Source identities. Sources with no completed snapshot do
not invent catalog entries. Collection paths use RFC 6901; `""` is the state
root, and a key `a/b~c` appears as `/a~1b~0c`. Object arrays, scalar arrays,
keyed record objects, scalar maps, and the root object are supported generically.
Every object or array can be selected directly with `/rows`, even when bounded
discovery omitted it.

Object members and array elements are rows. An object's original member name
or an array's decimal index is the exact `row_key` and the `$key` cell.
Object-row columns are relative JSON pointers; `$value` represents nonobject
rows, including scalars and nested arrays. Root tables therefore expose root
members, not a synthesized merged object. Direct object fields are discovered
as columns; nested containers remain previews. Arrays are never recursively
expanded into one table per row. Homogeneous object maps with shared scalar
record fields are similarly treated as record collections, not subtable trees.
This is a generic structural heuristic, not a producer-specific schema.
Small object namespaces (at most 32 members) with nested structured documents
remain traversable even when their members share scalar metadata. This exposes
collections inside wrappers such as `/collectors/<name>/document` without
special-casing producer field names. Larger record maps and all arrays still
stop at their row boundary.

Discovery is bounded to 256 collection definitions, 128 columns per definition,
50,000 discovery visits, 4,096-byte pointers, and a 16 MiB response. Incomplete
discovery or omitted columns/tables is explicit through `truncated:true`.
Returned table paths retain every compatible selected Source and exact row
counts; no partial row count is presented as an exact total.

### `POST /api/tables/rows`

Request:

```json
{
  "run_ids":["run-id"],"source_ids":["source-id"],"path":"/workers",
  "columns":["$key","/rank","/state"],
  "snapshot_ids":["42"],
  "search":"busy","filters":[{"path":"/rank","op":"gt","value":"0"}],
  "sort":{"path":"/rank","direction":"asc"},"offset":0,"limit":100
}
```

Only `run_ids` and `path` are required. `source_ids` defaults to all Sources in
the selected Runs; use catalog `sources` to select compatible reporters.
Omitted `columns` discovers direct row fields plus `$key`; explicit columns
may use nested pointers and select a bounded subset of wide schemas. Unknown
columns are rejected, not silently treated as globally missing.
`limit` defaults to 100 and must be 1..256; `offset` defaults to zero and is
at most one million. At most 128 columns and 32 filters are accepted.

```json
{
  "columns":[{"path":"$key","name":"Key"},{"path":"/rank","name":"rank"}],
  "rows":[{
    "run_id":"run-id","source_id":"source-id","snapshot_id":"42","row_key":"1",
    "cells":{
      "$key":{"kind":"string","text":"1","truncated":false},
      "/rank":{"kind":"number","text":"18446744073709551615","truncated":false}
    }
  }],
  "total":1,"offset":0,"limit":100,
  "snapshots":[{
    "run_id":"run-id","source_id":"source-id","label":"worker",
    "role":"worker","rank":null,"node_id":null,
    "snapshot_id":"42","observed_at_ns":1000000000,"row_count":2
  }]
}
```

`total` is the exact filtered count before pagination; `snapshots[].row_count`
is the unfiltered collection count. Empty arrays/maps yield zero rows.
Missing, null, scalar collection paths, and Sources with no completed capture
produce an actionable HTTP 400; no previous state is carried forward.

Omit `snapshot_ids` for current heads. Reuse the returned `snapshots` IDs to pin
pagination, sorting, and filters to immutable observations even as new captures
arrive. Supplied IDs are nonempty, unique, canonical positive decimal **strings**,
with exactly one snapshot per selected Source. Unknown IDs, wrong Run/Source
ownership, missing selected Sources, and two snapshots for one Source are
errors. If registrations change, keep explicit `source_ids` alongside pins.

All filtering, searching, and sorting evaluate the complete selected snapshots
before pagination. `contains` and global `search` are Unicode-lowercased
substring matches over full values, recursively including container keys and
values, never over truncated previews. `eq` compares scalar values: numeric
operands numerically, strings exactly, booleans as `true`/`false`, null as
`null`; missing never equals null. Container equality is unsupported.
`gt`/`lt` require finite JSON-number text; numeric equality operands must also
be finite. Integer comparisons preserve exact
i64/u64 values, including mixed integer/float comparisons. Numeric strings are
strings, not coerced numbers. Mixed-type ascending order is missing, null,
boolean, number, string, array, object; containers sort by size. Descending
reverses that order. Ties use Run ID, Source ID, then original collection order:
numeric array positions or lexicographic object keys, independent of sort
direction. Without an explicit sort, array records retain their source order.

Cell kinds are `missing`, `null`, `number`, `string`, `boolean`, `array`, and
`object`. Numbers are decimal text to avoid JavaScript precision loss.
Strings are UTF-8-safe previews of at most 1,024 bytes; arrays/objects are
explicit size previews with `truncated:true`. Use each row's snapshot ID with
`GET /api/snapshots/{id}` for exact unabridged evidence.

All three table APIs validate ownership, duplicate IDs, and request fields, and
use the existing authenticated/same-origin router. Selection is at most 64 Runs
and 256 registered Sources. Structured reads bound complete selected snapshots
to 64 MiB and one million state nodes, row evaluation to one million visits,
text search/filter work and conservative string-sort work to 64 MiB, and responses to 16 MiB. Search/filter text is
at most 4,096 bytes. These hard limits error rather than drop Sources or pretend
a partial scan has an exact total. Each table read has a 30-second cooperative
deadline and request-local cancellation; neither uses a global SQLite interrupt.
Snapshot reads reuse the Engine's existing SnapshotStore connection and lock,
and release that lock before row sorting/formatting.

Native Rust contracts are `TableSummaryRequest/Response`, `TableCatalogRequest/
Response`, and `TableRowsRequest/Response`; Engine methods are `table_summary`,
`table_catalog`, and `table_rows`. Their `_controlled` counterparts take a
`TableReadControl` for caller-owned cancellation.

### `GET /api/snapshots/{id}`

Returns the exact `StoredSnapshot` for a positive stored ID. This is the
contextual inspection path used by chart observations; an unknown ID returns
an explicit error. The Engine method is `snapshot_get(id)`.

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
`wall_time`, nanoseconds since each Run's first observation for `elapsed`,
or logical coordinates for an explicit axis. Elapsed alignment never uses
ingestion time or Run registration time.
Paths are RFC 6901 JSON pointers relative to `state`, e.g. `/progress/loss`.
The hostmon key `metrics["cpu/percent"]` is `/metrics/cpu~1percent`.
Response: `axis`, `series`, with each series containing `run_id`, `source_id`,
`path`, `snapshot_ids`, `source_session_ids`, `sequences`, `axes`,
`observed_at_ns`, `values`. The parallel `snapshot_ids` array identifies actual
stored observations, including after downsampling; it is not a synthetic ID.
`values` contains numbers or null. Missing, null, boolean, and nonnumeric
fields produce null, never a previous value. Missing explicit logical axes
exclude that observation. Point limits bound visual output, not raw storage.
Downsampling retains actual missing observations rather than connecting
numeric points across a known gap. A tight point budget may therefore omit
an earlier numeric point to preserve a gap and the latest observation.

Reads accept at most 64 Runs, 64 paths, and 256 Source IDs. Each projection
scans indexed data for at most 100,000 snapshots / 256 MiB, retains at most one million
projection cells, and returns at most 100,000 total points / 16 MiB.
`max_points` is 1..10,000 per series. Exceeding a budget returns an explicit
error requesting narrower filters, not silently truncated history. Wall-time
and elapsed bounds narrow the observation-index scan. Logical axis bounds do
not; narrow Source/Run selection for those queries. Latest/history pages accept
at most 256 records.

### `/api/snapshots/diff`

Request: `before_id`, `after_id`.
Response: those IDs, `changes`, and `truncated: boolean`.
Each change has `path`, `kind` (`added`, `removed`, `changed`) and optional
`before`/`after` JSON values. Omitted and JSON-null values remain distinct.
Changes are bounded; report truncation explicitly. Records may come from
different Runs for cross-experiment comparisons.

`/api/experiments/*` continues to own Project/Experiment/Run/Source metadata.
Stats report `projects`, `experiments`, `runs`, `sources`, `active_sources`,
`snapshots` (durable row count), `cursor_gaps`, and `scrape_failures`.

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
does not implicitly serve. Public producer exports are `Source`,
`SnapshotEvent`, `CaptureReceipt`, and `SourceStats`, without old-name aliases.

Consumer PyO3/Python APIs expose the snapshot read and chart catalog operations above.
CLI commands are `snapshots latest`, `snapshots history`, `snapshots diff`,
and `query --run RUN_ID --field /path` (time by default).

## Hostmon boundary

Hostmon remains independent of the RVX package. Its optional producer publishes
full observation state: numeric measurements, structured fields, public
collector results/documents and their freshness metadata, and alert observations.
Do not publish configuration credentials or dump the entire internal state.
Original monitoring, JSONL recording, Prometheus output, and UI remain unchanged.

Previously stored numeric history cannot reconstruct missing task/worker state.
Full-state history begins with actual captures. Old scalar files may remain
offline, but are not read or backfilled by the current runtime.
