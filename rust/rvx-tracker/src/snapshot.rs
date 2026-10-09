use std::collections::BTreeMap;
use std::sync::Arc;

use rvx_snapshots::SnapshotEvent;
use serde_json::{json, Value};

use crate::state::is_nonfinite;
use crate::state::{HistoryEntry, TrackerState};
use crate::{
    AlertEvent, ArtifactRecord, CommittedStep, Result, SpanRecord, TrackerError, TrackerOptions,
};

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
    kind: rvx_core::TrackerRecordKind,
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
                "record_version": rvx_core::TRACKER_RECORD_VERSION,
                "kind": kind,
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
    state: &mut TrackerState,
    record: CommittedStep,
    options: &TrackerOptions,
) -> Result<()> {
    let mut record = record;
    let existing_position = state
        .history
        .iter()
        .position(|entry| entry.record.step == record.step);
    if let Some(position) = existing_position {
        let mut existing = (*state.history[position].record).clone();
        existing.metrics.extend(record.metrics);
        existing.summary = record.summary;
        existing.alerts.extend(record.alerts);
        existing.spans.extend(record.spans);
        existing.artifacts.extend(record.artifacts);
        existing.observed_at_ns = existing.observed_at_ns.max(record.observed_at_ns);
        record = existing;
    }
    let bytes = serde_json::to_vec(&record)?.len();
    if bytes > options.max_history_bytes {
        return Err(TrackerError::InvalidInput(
            "committed step exceeds history byte budget".into(),
        ));
    }
    if let Some(position) = existing_position {
        if let Some(old) = state.history.remove(position) {
            state.history_bytes -= old.bytes;
        }
    }
    state.history_bytes += bytes;
    state.history.push_back(HistoryEntry {
        record: Arc::new(record),
        bytes,
    });
    while state.history.len() > options.history_steps
        || state.history_bytes > options.max_history_bytes
    {
        if let Some(old) = state.history.pop_front() {
            state.history_bytes -= old.bytes;
            state.evicted_steps += 1;
        }
    }
    Ok(())
}
