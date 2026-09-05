# Source SDK

RVX retains full structured runtime state. Numeric trends are projections of
that state **on read**, not a separate metric logging stream. See
[the authoritative snapshot contract](snapshots.md) for exact wire shapes.

`Source` is a data producer, not the central storage/query server (`rvxd`).
Construction and context entry allocate no HTTP listener. The Source owns its
Session and bounded buffer; an existing app can borrow read routes, or the
Source can optionally serve through its own native HTTP worker.

## Capture a complete observation

```python
from rvx import SnapshotEvent, Source

with Source(
    project="robotics",
    experiment="async-rl",
    run_id=run_id,  # persisted RVX Run ID
    role="learner",
    schema_version=1,  # optional; currently only version 1 is supported
) as producer:
    producer.serve(port=9200)  # optional: omit when mounting an existing app
    receipt = producer.capture(
        {
            "phase": "training",
            "progress": {"loss": 0.18, "step": 1024},
            "queue": {"ready": 8, "inflight": ["batch-72"]},
            "workers": [{"rank": 0, "busy": True}],
        },
        axes={"optimizer_step": 1024},
    )
    print(producer.endpoint, receipt.sequence)
    # Register the reachable endpoint through the RVX control API.
    # Keep HTTP alive while consumers pull the retained observations.
    producer.seal()
```

Each capture is a **replacement**, never a merge. A missing key is absent;
an explicit `None` becomes JSON null. Nested objects, arrays, strings, booleans,
nulls, and finite numbers are preserved. Empty objects are valid. Subsequent
caller mutations cannot change captured history. Python object keys must be
strings and state integers must fit signed or unsigned 64-bit storage.

The application chooses its consistency boundary and builds the JSON object.
There is no automatic tensor conversion, model serialization, heap dump, GPU
synchronization, or cross-Source atomic observation. Do not publish credentials.
The producer does no network I/O during capture.

## Mount an existing application

For FastAPI or Starlette, keep the original application and server:

```python
from fastapi import FastAPI
from rvx import Source

app = FastAPI()
source = Source(
    project="robotics", experiment="async-rl", run_id=run_id, role="learner",
)
app.mount("/rvx", source.asgi())

source.capture({"phase": "training", "queue": {"ready": 8}})
```

The SDK ASGI adapter has no FastAPI/Starlette dependency. It handles mounted
and nested root paths, HTTP GET/HEAD, and lifespan events. Lifespan completion
does not seal or close the borrowed Source; the creator owns its lifetime.
WebSockets and HTTP mutation methods are not ingestion channels.

For aiohttp:

```python
from aiohttp import web
from rvx import Source

app = web.Application()
source = Source(
    project="robotics", experiment="async-rl", run_id=run_id, role="actor",
)
source.attach_aiohttp(app, prefix="/rvx")
# Start app normally; its existing middleware and other routes remain in place.
```

aiohttp must be present in the host environment; the optional `rvx[aiohttp]`
extra declares that dependency. Attach before router freeze and before any
overlapping catch-all/static routes. Conflicts fail explicitly, rather than
silently shadowing existing paths. Multiple Sources can share one app using
distinct prefixes.

In either mode, register `http://HOST:PORT/rvx` as the consumer's Source URL.
For example, the descriptor is now
`http://HOST:PORT/rvx/v1/snapshots/descriptor`. `source.endpoint` is only for
an owned standalone listener; the public URL of a mounted app belongs to its
host. Middleware/authentication remains the host's responsibility and is not
bypassed by the adapter.

Mounted requests traverse Python HTTP dispatch. Both adapters offload blocking
native reads/serialization from the event loop and send Rust-produced bytes,
without decoding/re-encoding snapshot object trees in Python. Configure request
concurrency in the host server. For an entirely native HTTP path, use `serve()`.

Advanced framework integrations may call `descriptor_bytes()`, `latest_bytes()`,
and `history_bytes(after=0, limit=64)`. These are synchronous, GIL-releasing
native reads: call them off an async event-loop thread, as the built-in adapters
do. Successful payloads preserve all JSON values and supported integer precision.

`capture(state, *, observed_at_ns=None, axes=None)` returns a `CaptureReceipt`.
Its `sequence` (also `first_sequence`) identifies that observation. When omitted,
`observed_at_ns` is assigned by the native producer. Axis values and explicit
timestamps must be signed 64-bit integers; booleans are not coordinates.

## Atomic batches

```python
receipt = producer.capture_batch([
    SnapshotEvent({"workers": [{"status": "busy"}]}, observed_at_ns=100,
                  axes={"step": 1}),
    SnapshotEvent({"workers": [], "error": None}, observed_at_ns=200,
                  axes={"step": 2}),
])
print(receipt.first_sequence, receipt.next_sequence, receipt.accepted)
```

Validation of the entire batch precedes any sequence assignment or eviction.
Empty batches, unsupported values, nonfinite numbers, cycles, excessive nesting,
and oversized states fail explicitly. Each complete wire snapshot is at most
4 MiB and JSON depth is at most 64 levels below the `state` root (depth 0),
using the shared native validator. State is also bounded to 100,000 JSON nodes.
Every child value, including a scalar, increments depth; the transport envelope
does not count.
Batches are limited to `min(capacity, 256)` snapshots and 16 MiB.

Defaults retain at most 1,024 snapshots and 64 MiB of conservatively accounted
JSON-tree memory. `capacity` and `max_buffer_bytes` are independent bounds.
Accounting is not an exact allocator or process-RSS measurement. A snapshot
must fit the byte budget individually. A batch may evict its own earliest
members if its aggregate accounted size exceeds retention. Eviction is explicit
in `receipt.dropped_snapshots` and `producer.stats()`:

- `buffered_snapshots`, `buffered_bytes`
- `dropped_snapshots` (cumulative)
- `oldest_sequence`, `next_sequence`, `sealed`

## Pull endpoints and cursors

The native HTTP worker exposes only:

```text
GET /v1/snapshots/descriptor
GET /v1/snapshots/latest
GET /v1/snapshots/history?after=0&limit=64
GET /healthz
```

The descriptor has schema/session/Source identity, not metric definitions.
Latest returns HTTP 503 until the first capture. Initial history is an empty
page with zero cursors. `after` is an **inclusive next sequence**, not a storage
ID or training step. Always continue with the returned `next_sequence`; it
never jumps past an unreturned page. Fresh `after=0` begins at retained history.
If the requested cursor was evicted, `dropped_before` reports the retained lower
bound. Invalid/future/negative cursors and limits outside 1–256 are rejected.
History pages are reduced to the 16 MiB byte budget without discarding a state.

The HTTP implementation clones shared snapshot ownership under a short mutex
and serializes outside it. It does not hold the capture lock while copying a
JSON tree or sending a response.

## Lifecycle and processes

Construction allocates a fresh session but does not bind a socket. `serve()`
returns after binding, is idempotent for the same requested address, and creates
one native Tokio worker. Changing the address while serving is an explicit error.
Port zero chooses an ephemeral port; inspect `endpoint` afterward.
`seal()` freezes capture but leaves latest/history readable. `close()` stops
capture and the Source's owned HTTP listener/runtime, never an attached app;
**close is not an acknowledgment that a consumer persisted the final state**.
Mounted reads return unavailable after Source closure while other host routes
remain alive. Context exit and native Drop release owned resources. A closed
Source cannot restart.

Terminal closure releases retained local history even if mounted routes still
reference the Source. Seal it and allow consumer catch-up before closing;
closure is not a durability acknowledgment.

`stop_serving()` only stops the optional native listener. Captures and mounted
reads continue, and a later `serve()` reuses the same Session and sequence.
Stopping the host app likewise does not close the Source. Transport failure
must not prevent the Source from recording or serving another mounted reader.

Create one producer inside each worker process. Inherited producers reject
operations after `fork`; a fresh instance has a fresh session and starts its
sequence at zero. Public exports are `Source`, `SnapshotEvent`,
`CaptureReceipt`, and `SourceStats`. There is no `SnapshotServer` or `MetricServer` alias,
`MetricDefinition`, `MetricEvent`, `log`, `log_batch`, or Push ingestion API.

Migration from the preceding SDK: rename `SnapshotServer` to `Source` and
`SnapshotServerStats` to `SourceStats`; move `host`/`port` out of construction
into `serve()`, and replace `start()` with explicit `serve()`. A `with Source`
block no longer starts HTTP implicitly. The wire protocol, consumer data,
and existing registrations are unchanged. Hostmon keeps its independent
producer implementation and does not acquire a RVX dependency.

## Read retained state

`RvxService` exposes dictionary-in/dictionary-out methods matching the shared
consumer contract:

```python
latest = service.snapshot_latest({"run_id": run_id, "limit": 100})
history = service.snapshot_history({"run_id": run_id, "limit": 100})
trend = service.snapshot_query({
    "run_ids": [run_id], "paths": ["/progress/loss"], "axis": "wall_time",
})
diff = service.snapshot_diff({"before_id": before_id, "after_id": after_id})
```

Native `RvxEngine.snapshot_latest/history/query/diff` accept a JSON request
string and return a JSON response string in one GIL-releasing call.
History uses newest-first durable storage IDs and `next_before_id`; latest
uses deterministic Source ordering and `next_source_id`. Diff preserves
missing versus null values and reports truncation. JSON-pointer projections
return null for missing, null, boolean, and nonnumeric values, never stale data.
`/metrics/cpu~1percent` selects the literal key `metrics["cpu/percent"]`.

```console
rvx snapshots latest --run RUN_ID
rvx snapshots history --run RUN_ID --limit 50
rvx snapshots diff --before-id 10 --after-id 20
rvx query --run RUN_ID --field /progress/loss
rvx query --run RUN_ID --field /progress/loss --axis optimizer_step
```

Old numeric data remains read-only through `legacy-query --metric NAME` and
`RvxService.legacy_query`, `legacy_query_summaries`, and `legacy_query_arrow`.
It cannot reconstruct structured state that was never captured.

The CPU-local process integration test publishes concurrent actor, learner,
inference, and evaluator observations for two Runs into one standalone daemon.
It checks full-state Pull, independent logical axes, cross-Run projections,
and missing/null/removed-field diffs. This is an SDK/native plumbing simulation,
not an actual RL workload, multi-node test, or performance claim.
