# Native experiment tracker

`rvx.tracker` provides step-oriented experiment logging without adding a second
history store. Step assembly, summaries, alert expressions, watchdogs, delivery,
span aggregation, artifact hashing, and Source snapshots are implemented in
Rust. Python is only the SDK adapter.

```python
from rvx import tracker as et

run = et.init(
    project="demo",
    experiment="training",
    name="trial-1",
    run_id="trial-1",
    serve=True,
    port=9200,
    config={"batch_size": 32},
    alert_rules=[
        "isnan(loss) or isinf(loss) => critical: invalid loss",
        "zscore(loss[50]) > 4 => error: loss spike",
        "no_data(10m) => error: training stalled",
    ],
)

for step in range(1_000):
    et.log({}, step=step)
    with et.span("forward", batch_size=32):
        loss = train_step()
    et.log({"loss": loss, "lr": scheduler.lr}, step=step, commit=True)

et.finish()
```

Register `run.endpoint` as an ordinary Source, or place the endpoint in
`rvx.toml`. Streams and distributed ranks are independent Sources:

```python
et.init(
    project="demo",
    experiment="training",
    name="trial-1",
    run_id="trial-1",
    stream="learner",
    rank=0,
    serve=True,
)
```

## Snapshot contract

Every committed step produces one full RVX snapshot:

```json
{
  "axes": {"step": 42},
  "state": {
    "metrics": {"loss": 0.31, "lr": 0.0001},
    "summary": {"loss": 0.31, "lr": 0.0001},
    "config": {"batch_size": 32},
    "tracker": {
      "record_version": 1,
      "kind": "observation",
      "step": 42,
      "status": "running",
      "commit": 43,
      "nonfinite": []
    },
    "alerts": [],
    "spans": [],
    "artifacts": []
  }
}
```

Manual alerts, watchdog alerts, artifacts and terminal lifecycle notifications
use `tracker.kind = "event"` with the same Source/Session/sequence envelope.
They are retained in `/v1/snapshots/history` and daemon snapshot history, but
never replace the observation returned by `latest`, update chart heads, or add
null points to metric queries. An event-only Source has no latest observation.
Producer retention pins the latest observation within the configured byte
budget even when events evict its historical entry.

The daemon rebuilds old derived chart heads when upgrading the index. Legacy
records without `tracker.record_version` retain their original observation
meaning; the migration does not guess whether old snapshots were events.

`metrics` contains only values committed for that step. Missing metrics remain
missing instead of being repeated as new observations. `summary` contains the
last committed value of every metric. Numeric charts therefore query
`/metrics/loss`; current last-value panels may use `/summary/loss`.

RVX snapshots require finite JSON numbers. NaN and infinities use explicit
values such as `{"$rvx.nonfinite":"nan"}` and the corresponding field name is
listed in `tracker.nonfinite`. Alert predicates `isnan()` and `isinf()` evaluate
the native value before storage. Non-finite values are evidence, never silently
converted to zero or null.

## Step and commit semantics

The API follows the useful `wandb.log` conventions:

- `log(data)` commits the current step and advances it.
- `log(data, commit=False)` merges without committing.
- `log(data, step=N)` selects/merges step `N` without committing by default.
- Moving to a higher explicit step commits the previous open step.
- Reopening the most recently committed step creates a patch snapshot; local
  tracker history merges the patch.
- The default monotonic policy rejects older steps with a warning. Use
  `step_policy="allow"` when out-of-order producers are intentional.

`run.step` is the target of the next implicit `log()`: the selected open step,
if any, otherwise the committed high-water `next_step`. Selecting an older
open step with the `allow` policy does not lower that committed high-water mark.

There is no JSONL writer, sidecar, sparse file index, or separate metric cache.
The bounded local history exists only for synchronous SDK reads; durable and
cross-process history comes from the RVX daemon.

Tracker calls use a two-phase invariant: prepare the entire call's prospective
state, alert transitions and snapshots, append them in one atomic native
`capture_batch`, then apply the local state. Advancing and committing a new step
in one call can emit two observations; failure of the second leaves the previous
open step, history, summary, alert state and producer cursor unchanged.
History records and alert series use shared ownership during preparation,
rather than deep-copying the complete history.

### Accepted versus durable

Committed `log()`/ordinary `flush()` only mean accepted into the bounded Source
buffer; `commit=False` stages an open row and does not advance the Source cursor.
The result exposes the accepted `capture` interval when a record was emitted.
Neither promises SQLite persistence or remote alert delivery. Use an explicit
confirmation when training must not exit before its final records are retained:

```python
# source_id is returned by `rvx sources register` for this Run endpoint.
run.flush(durable=True, server_url="http://127.0.0.1:9110",
          source_id=source_id, timeout=30)
result = run.finish(exit_code=0, durable=True,
                    server_url="http://127.0.0.1:9110",
                    source_id=source_id, timeout=30)
assert result["persistence"]["complete"]
run.close()
```

The native SDK polls `POST /api/snapshots/ack` for the exact Run, registered
Source and Session cursor. Only a committed SQLite cursor with no earlier
retention gaps can confirm completeness. A future cursor, another Session,
unknown Source, gaps or a timeout cannot produce a successful acknowledgment.
Timeouts are bounded and surfaced as errors; `wait_persisted()` can retry
confirmation without writing the batch again. Keep the Source HTTP transport
running until confirmation succeeds. Closing without confirmation remains
explicitly best-effort.

`exit_code != 0` emits a `failed` tracker event. This is a per-Source lifecycle,
not permission to terminate other Sources in the shared registry Run; the
existing Run control API continues to own that aggregate lifecycle.

### SDK queries and budgets

History field projection, half-open step range, tail limit, missing-value
handling and `include_open` execute in Rust before crossing PyO3. Python only
converts the bounded result to dict/pandas/polars. Open patches merge with the
retained committed step for local reads without mutating it.

| Budget | Default |
| --- | --- |
| `max_state_bytes` (open row, spans, summary, config) | 8 MiB encoded JSON |
| `max_history_bytes` | 64 MiB encoded committed records |
| `history_steps` | 1,024 |
| `max_metrics` (open row, summary, alert series) | 4,096 |
| `max_spans` per open step | 4,096 |
| `max_alert_series_bytes` | 64 MiB accounted series storage |
| `history(..., max_bytes=...)` | 16 MiB result |

Oversized working state is rejected before admission. Committed local history
evicts oldest records to satisfy both count and bytes; `info()` exposes
`history_bytes` and `evicted_steps`. `history(-1)` means all *retained local*
steps, not all durable daemon history. These budgets are not a process RSS
guarantee. The existing producer count/byte limits remain independently enforced.

The Rust implementation keeps those responsibilities separated:

| Module | Responsibility |
| --- | --- |
| `model.rs` | Public tracker options, results, committed-step and span records |
| `state.rs` | Open-row admission, step policy, validation and numeric decoding |
| `snapshot.rs` | Canonical tracker-state snapshot construction and history merge |
| `alert/model.rs` | Rule and event contracts |
| `alert/expression/syntax.rs` | Lexer, AST and parser |
| `alert/expression/eval.rs` | Windows, functions and three-valued evaluation |
| `alert/mod.rs` | Rule state transitions and prepared alert updates |
| `alert_sink.rs` | Transport-neutral delivery interface |
| `delivery.rs` | Ordered bounded queue isolating tracker state from foreign sinks |
| `artifact.rs` | Deterministic digest and lineage records |

`rvx-config` is a separate neutral crate shared by `rvx` and `rvxd`; the CLI
does not depend on the server, engine, or SQLite implementation.
The default webhook worker lives in `rvx-alert-http`; `rvx-tracker` itself has
no HTTP client dependency and accepts any `AlertSink` implementation.

## Alerts

Rules run in Rust against rolling metric series. Supported expression features
include arithmetic and boolean operators, point/time windows, three-valued
logic, and:

- `mean`, `sum`, `min`, `max`, `count`, `first`, `last`
- `std`, `var`, `diff`, `rate`, `pct_change`, `slope`, `zscore`, `ema`
- `increasing`, `decreasing`, `stalled`
- `isnan`, `isinf`, `has`
- `step`, `elapsed`, `age`, `no_data`

Unknown functions, wrong arity, oversized expressions and windows larger than
`alert_window` fail at rule installation, not as silent `UNKNOWN` results.
`metric[N]` requires N recorded numeric samples by default; set
`partial_window=True` on a rule to opt into warm-up evaluation. Duration windows
require retained coverage of the whole interval. Missing values and arithmetic
over non-finite data yield `UNKNOWN`; only `isnan`/`isinf` interpret the explicit
non-finite encoding. Arithmetic comparisons do not carry forward a missing
metric from an earlier training step.

`for_steps` advances only for distinct committed steps, never timer ticks or
same-step patches. Time conditions can use `for_duration_ms`; a watchdog
evaluates only rules that actually reference time. `for_duration_ms` requires an
explicit time condition, and unknown coverage resets its continuous-duration
evidence. `rate` and `slope` use
observation seconds by default (`axis="wall_time"`), or explicit logical step
coordinates (`axis="step"`). Duplicate/regressing coordinates yield `UNKNOWN`.

```python
et.add_alert_rule({
    "alert": "loss-high",
    "expr": "loss > mean(loss[20]) * 2",
    "level": "error",
    "for": 3,
    "cooldown_seconds": 300,
    "notify_recovery": True,
    "message": "loss regression at {step}",
})
```

Time rules use a native watchdog and can fire when no `log()` call occurs.
Alert events are captured in snapshots and may also be delivered asynchronously:

```python
et.init(
    ...,
    alert={
        "channels": [
            {
                "type": "lark",       # webhook, slack, lark, dingtalk, wecom
                "name": "oncall",
                "url_env": "LARK_WEBHOOK_URL",
                "min_level": "warning",
                "tags": ["training"],
            }
        ],
        "policy": {
            "rate_limit_per_minute": 20,
            "dedup_window": 300,
            "max_retries": 3,
        },
    },
)
```

The tracker queues events in commit order without invoking user callbacks under
the state lock. Each HTTP channel has its own bounded queue and asynchronous
worker, so a slow/retrying channel does not block another. Deduplication follows
successful sends, not failed attempts; retriable responses honor `Retry-After`.
Delivery exposes accepted/completed/pending/dropped/failed/suppressed counters.

`shutdown_timeout_ms` on the tracker is a total waiting budget, including queue
flush and foreign callbacks. The HTTP adapter cancels in-flight work on close.
Rust cannot forcibly terminate an arbitrary custom sink callback: when one
ignores shutdown, RVX reports the timeout and abandons that worker rather than
blocking training indefinitely. Delivery is best-effort, not exactly-once and
not a crash-resumable outbox. Event evidence is retained independently in the
Source history and, after Pull, SQLite.

Replay uses the same Rust compiler and execution path:

```python
events = et.replay_alerts(
    ["mean(loss[2]) > 1 => error: high"],
    [
        {"kind": "step", "step": 0, "observed_at_ns": 1000000000,
         "metrics": {"loss": 1}},
        {"kind": "step", "step": 1, "observed_at_ns": 2000000000,
         "metrics": {"loss": 3}},
        {"kind": "tick", "step": 1, "observed_at_ns": 3000000000},
    ],
)
```

Replay inputs are chronological; explicit tick records preserve watchdog
semantics. Inputs, rule count, retained series and output size are bounded.

## Spans and traces

Nested synchronous and asynchronous spans aggregate duration metrics into the
open step and retain individual evidence records:

```python
with et.span("forward"):
    with et.span("attention"):
        attention()
```

This records `/metrics/time_ms~1forward` and
`/metrics/time_ms~1forward~1attention`. Enable `span_count=True` for matching
`count/...` metrics.

Export retained span records to Chrome Trace/Perfetto:

```bash
rvx trace --run RUN_ID --output trace.json
rvx trace --run RUN_ID --output trace.json --temp-dir /scratch
```

The exporter reads ordinary snapshot history, so source/time filters and server
authentication remain consistent with every other RVX read.
Events are sorted by start timestamp, with equal timestamps retaining their
original history traversal order. Export does not accumulate the entire trace
in RAM: HTTP pages are capped at 16 MiB, initial sort chunks use an 8 MiB budget,
and external merge passes read at most eight runs at a time. Memory depends on
one page, a bounded sort chunk and merge records, not the total event count.
Those encoded-byte budgets are not a process RSS guarantee.

Sorting uses temporary files in the output directory by default. `--temp-dir`
selects an existing scratch directory; choose disk-backed storage for large
traces rather than a memory-backed temporary filesystem. Scratch disk usage
grows with the trace, and the output filesystem needs room for the complete
replacement file. Temporary files are cleaned up on success or returned errors.
The previous destination is replaced atomically only after sorting, streaming
JSON output and file synchronization succeed.

## Artifact lineage

RVX records artifact evidence rather than introducing a second content store:

```python
et.log_artifact(
    "checkpoint.pt",
    name="model",
    type="checkpoint",
    aliases=["best"],
    metadata={"step": 1_000},
)

et.use_artifact(
    "s3://bucket/dataset",
    name="dataset",
    digest="sha256...",
    type="dataset",
)
```

Local files/directories are hashed in Rust with deterministic SHA-256 directory
ordering. Snapshots retain action, name, type, digest, size, URI, aliases, and
metadata. A rebuildable SQLite index supports bounded lineage and alias
resolution without becoming another source of truth:

```bash
rvx artifacts lineage --run RUN_ID --name model
rvx artifacts resolve --run RUN_ID --name model --alias best
```

The matching HTTP APIs are `POST /api/artifacts/lineage` and
`POST /api/artifacts/resolve`. RVX does not copy model checkpoints into its
SQLite database; content remains in the caller's filesystem or object store.
The versioned `ArtifactRecord` and its validation live in `rvx-core` and are
shared by producers and indexers. Legacy records without an explicit version
decode as version 1. Invalid historical records are retained as raw evidence
with indexed exclusion reasons. Lineage returns scope-wide `coverage` counts;
resolve rejects incomplete coverage instead of presenting a potentially stale
alias as authoritative. Pages are streamed with byte limits before collecting
large metadata. Alias lookups use a dedicated derived table; within the
explicit Run/Source scope, the newest `(snapshot_id, artifact_index)` wins.

## Migration from `expr_tracker`

Replace:

```python
import expr_tracker as et
```

with:

```python
from rvx import tracker as et
```

The core `init`, `log`, `finish`, `history`, `summary`, `span`, `alert`,
`log_artifact`, and `use_artifact` workflows are available. RVX intentionally
does not reproduce JSONL as a second source of truth. Wandb/trackio are external
mirrors rather than part of the native storage contract and can be operated
beside RVX when required. Passing `backends`/`backend_kwargs`, local storage
directories, cursor-resume modes, `define_metric`, or `quiet` raises an explicit
unsupported-operation error; these are not silently accepted compatibility
placeholders. `include_open` and `exit_code` have actual native semantics.
