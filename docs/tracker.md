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
    step_axis="trainer/step",
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

`step_axis` selects the logical axis stored in every committed Snapshot. It
defaults to `step`; asynchronous applications may use names such as
`trainer/step` or `policy/version`.

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

There is no JSONL writer, sidecar, sparse file index, or separate metric cache.
The bounded local history exists only for synchronous SDK reads; durable and
cross-process history comes from the RVX daemon.

Tracker commits use a two-phase invariant: construct the prospective step,
summary, alert transitions and snapshot first; append it to the native producer;
only then advance the in-memory step cursor, summary, history and rule state.
A rejected/oversized/sealed capture therefore cannot leave success-shaped local
state that the daemon never received.

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
| `dispatch.rs` | `AlertSink` plus the asynchronous HTTP delivery implementation |
| `artifact.rs` | Deterministic digest and lineage records |

`rvx-config` is a separate neutral crate shared by `rvx` and `rvxd`; the CLI
does not depend on the server, engine, or SQLite implementation.

## Alerts

Rules run in Rust against rolling metric series. Supported expression features
include arithmetic and boolean operators, point/time windows, three-valued
logic, and:

- `mean`, `sum`, `min`, `max`, `count`, `first`, `last`
- `std`, `var`, `diff`, `rate`, `pct_change`, `slope`, `zscore`, `ema`
- `increasing`, `decreasing`, `stalled`
- `isnan`, `isinf`, `has`
- `step`, `elapsed`, `age`, `no_data`

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

The Rust delivery worker owns routing, bounded queueing, token-bucket limiting,
deduplication, retry, and shutdown flushing. Delivery failures never raise in
the training thread.

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
```

The exporter reads ordinary snapshot history, so source/time filters and server
authentication remain consistent with every other RVX read.

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
metadata. RVX does not copy model checkpoints into its SQLite database; content
remains in the caller's filesystem or object store.

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
beside RVX when required.
