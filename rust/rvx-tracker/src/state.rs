use std::collections::{BTreeMap, VecDeque};

use serde_json::Value;

use crate::alert::AlertEngine;
use crate::{CommittedStep, Result, SpanRecord, StepPolicy, TrackerError, NONFINITE_KEY};

pub(crate) struct TrackerState {
    pub(crate) status: &'static str,
    pub(crate) next_step: i64,
    pub(crate) open_step: Option<i64>,
    pub(crate) open_metrics: BTreeMap<String, Value>,
    pub(crate) open_spans: Vec<SpanRecord>,
    pub(crate) last_committed_step: Option<i64>,
    pub(crate) summary: BTreeMap<String, Value>,
    pub(crate) history: VecDeque<CommittedStep>,
    pub(crate) commits: u64,
    pub(crate) alerts: AlertEngine,
    pub(crate) finished: bool,
}

pub(crate) enum StepDecision {
    Keep,
    CommitOpen,
    Reject(String),
}

pub(crate) fn resolve_step(state: &TrackerState, requested: Option<i64>) -> i64 {
    requested.or(state.open_step).unwrap_or(state.next_step)
}

pub(crate) fn ensure_active(state: &TrackerState) -> Result<()> {
    if state.finished {
        Err(TrackerError::Finished)
    } else {
        Ok(())
    }
}

pub(crate) fn step_decision(
    state: &TrackerState,
    target: i64,
    policy: &StepPolicy,
) -> StepDecision {
    if let Some(open) = state.open_step {
        if target > open || target < open && *policy == StepPolicy::Allow {
            StepDecision::CommitOpen
        } else if target < open {
            StepDecision::Reject(format!(
                "step {target} is behind the open monotonic step {open}"
            ))
        } else {
            StepDecision::Keep
        }
    } else if target < state.next_step
        && *policy == StepPolicy::Monotonic
        && state.last_committed_step != Some(target)
    {
        StepDecision::Reject(format!(
            "step {target} is behind the next monotonic step {}",
            state.next_step
        ))
    } else {
        StepDecision::Keep
    }
}

pub(crate) fn object(value: Value, field: &str) -> Result<BTreeMap<String, Value>> {
    let Value::Object(value) = value else {
        return Err(TrackerError::InvalidInput(format!(
            "{field} must be a JSON object"
        )));
    };
    Ok(value.into_iter().collect())
}

pub(crate) fn validate_metric_name(value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.contains('\0')
        || value.len() > 4096
        || matches!(value, "_step" | "_time")
    {
        return Err(TrackerError::InvalidInput(format!(
            "invalid metric name {value:?}"
        )));
    }
    Ok(())
}

pub(crate) fn validate_span(span: &SpanRecord) -> Result<()> {
    if span.name.trim().is_empty() || span.name.contains('\0') || span.name.len() > 4096 {
        return Err(TrackerError::InvalidInput(
            "span name must contain 1..=4096 non-NUL bytes".into(),
        ));
    }
    if !span.duration_ms.is_finite() || span.duration_ms < 0.0 || span.end_ns < span.start_ns {
        return Err(TrackerError::InvalidInput(
            "span duration and timestamps are invalid".into(),
        ));
    }
    if !span.attributes.is_object() {
        return Err(TrackerError::InvalidInput(
            "span attributes must be a JSON object".into(),
        ));
    }
    Ok(())
}

pub(crate) fn accumulate(metrics: &mut BTreeMap<String, Value>, path: &str, value: f64) {
    let current = metrics
        .get(path)
        .and_then(Value::as_f64)
        .unwrap_or_default();
    metrics.insert(path.into(), Value::from(current + value));
}

pub(crate) fn numeric_value(value: &Value) -> Option<f64> {
    if let Some(value) = value.as_f64() {
        return Some(value);
    }
    value
        .as_object()
        .and_then(|object| object.get(NONFINITE_KEY))
        .and_then(Value::as_str)
        .and_then(|value| match value {
            "nan" => Some(f64::NAN),
            "inf" => Some(f64::INFINITY),
            "-inf" => Some(f64::NEG_INFINITY),
            _ => None,
        })
}

pub(crate) fn is_nonfinite(value: &Value) -> bool {
    numeric_value(value).is_some_and(|value| !value.is_finite())
}
