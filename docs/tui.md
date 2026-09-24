# Config-driven daemon and TUI

RVX uses one strict TOML document for static Source discovery and terminal
presentation. The daemon writes observations into the same engine read by the
Web UI; the TUI calls the same public HTTP metadata, snapshot, and query APIs.
Both `rvx` and `rvxd` are native Rust executables. The TUI does not open the
SQLite data directory or maintain a second metrics store.

## Configuration

```toml
version = 1

[daemon]
data_dir = ".rvx/data"
listen = "127.0.0.1:9110"
scrape_concurrency = 64

[[runs]]
id = "grpo-20260921-001"
project = "async-rl"
experiment = "grpo"
name = "trial-1"
config = { model = "tiny-policy", batch_size = 32, learning_rate = 0.0001 }

[[runs.sources]]
endpoint = "http://127.0.0.1:9200"
role = "learner"
attempt_id = "attempt-1"
scrape_interval_ms = 1000
timeout_ms = 5000

[[runs.sources]]
endpoint = "http://127.0.0.1:9201"
role = "actor"
rank = 0
scrape_interval_ms = 1000
timeout_ms = 5000

[dashboard]
project = "async-rl"
experiment = "grpo"
refresh_ms = 1000
history_points = 120

[[dashboard.panels]]
type = "metrics"
title = "Learner"
paths = ["/progress/loss", "/progress/learning_rate"]
axis = "optimizer_step"
roles = ["learner"]

[[dashboard.panels]]
type = "snapshot-fields"
title = "Current training state"
paths = ["/phase", "/progress/step", "/queue/ready"]

[[dashboard.panels]]
type = "run-metadata"
title = "Run"
config_paths = ["/model", "/batch_size", "/learning_rate"]
```

Relative `daemon.data_dir` and `daemon.ui_dir` paths resolve from the TOML
file's directory. Command-line daemon options override values in `[daemon]`.
`dashboard.url` can select a different RVX API; otherwise the TUI derives the
URL from `daemon.listen`. `--url` or `RVX_URL` overrides both.

Each configured `runs.id` is caller-stable and must equal the `run_id` supplied
to every corresponding `Source`:

```python
from rvx import Source

source = Source(
    project="async-rl",
    experiment="grpo",
    run_id="grpo-20260921-001",
    role="learner",
).serve(port=9200)
```

The daemon idempotently creates the Project, Experiment, and Run and registers
the static endpoints before scraping starts. Restarting with the same document
does not duplicate records. A persisted Run ID cannot later be assigned a
different hierarchy, name, or training config; use a new Run ID for a new
training execution. Source descriptor project, experiment, Run, attempt, and
role must all match the configured registration.

The initial discovery mode is intentionally static. RVX does not scan local
processes or ports and does not discover Kubernetes Pods or Services.

## Run

Start the native daemon:

```bash
rvx daemon --config rvx.toml
```

`rvx serve --config rvx.toml` and `rvxd --config rvx.toml` are equivalent
launch surfaces. Existing `--data-dir` usage remains supported without a
config file.

Open the terminal dashboard:

```bash
rvx tui --config rvx.toml
```

The TUI selects the most recently started Run whose status is `running` within
the configured Project and Experiment. Override selection when diagnosing one
specific Run:

```bash
rvx tui --config rvx.toml --run grpo-20260921-001
```

Use `q` to quit, `r` to refresh immediately, and `j`/`k`, arrow keys, or
Page Up/Page Down to scroll. For logs, scripts, or non-interactive terminals:

```bash
rvx tui --config rvx.toml --once
```

Metric panels query numeric paths and render the latest value plus a compact
history sparkline. Snapshot panels read the latest full state per matching
Source. Metadata panels show Run identity, lifecycle, and selected JSON-pointer
paths from the immutable Run config. Panel order is the TOML order, and optional
`roles` filters use registered Source roles.

When the daemon is protected, export the same `RVX_API_TOKEN` used by the
ordinary CLI. Do not put access credentials in the TOML file or endpoint URLs.
