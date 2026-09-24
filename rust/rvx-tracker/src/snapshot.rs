use std::collections::{BTreeMap, VecDeque};

use rvx_snapshots::SnapshotEvent;
use serde_json::{json, Value};

use crate::state::is_nonfinite;
use crate::{AlertEvent, ArtifactRecord, CommittedStep, SpanRecord, TrackerOptions};

#[allow(clippy::too_many_arguments)]
pub(crate) fn snapshot_event(
    step: i64,
    observed_at_ns: i64,
    metrics: BTreeMap<String, Value>,
    summary: &BTreeMap<String, Value>,
    alerts: Vec<AlertEvent>,
    spans: Vec<SpanRecord>,
    artifacts: Vec<ArtifactRecord>,
    config: &Value,
    status: &str,
    commits: u64,
    options: &TrackerOptions,
) -> SnapshotEvent {
    let nonfinite: Vec<_> = metrics
        .iter()
        .filter_map(|(name, value)| is_nonfinite(value).then_some(name.clone()))
        .collect();
    SnapshotEvent {
        state: json!({
            "metrics": metrics,
            "summary": summary,
            "config": config,
            "tracker": {
                "step": step,
                "status": status,
                "commit": commits,
                "nonfinite": nonfinite,
            },
            "alerts": alerts,
            "spans": spans,
            "artifacts": artifacts,
        }),
        observed_at_ns: Some(observed_at_ns),
        axes: BTreeMap::from([(options.step_axis.clone(), step)]),
    }
}

pub(crate) fn merge_history(
    history: &mut VecDeque<CommittedStep>,
    record: CommittedStep,
    capacity: usize,
) {
    if let Some(existing) = history
        .iter_mut()
        .rev()
        .find(|value| value.step == record.step)
    {
        existing.metrics.extend(record.metrics);
        existing.summary = record.summary;
        existing.alerts.extend(record.alerts);
        existing.spans.extend(record.spans);
        existing.artifacts.extend(record.artifacts);
        existing.observed_at_ns = existing.observed_at_ns.max(record.observed_at_ns);
    } else {
        history.push_back(record);
    }
    while history.len() > capacity {
        history.pop_front();
    }
}
