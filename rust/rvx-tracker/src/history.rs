use crate::state::TrackerState;
use crate::{HistoryQuery, Result, TrackerError};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

pub(crate) fn query(state: &TrackerState, query: &HistoryQuery) -> Result<Value> {
    if query
        .from_step
        .zip(query.to_step)
        .is_some_and(|(a, b)| a > b)
        || query.max_bytes == 0
        || query.max_bytes > 16 * 1024 * 1024
        || query.limit.is_some_and(|n| n > 1_000_000)
    {
        return Err(TrackerError::InvalidInput(
            "invalid history range, limit or byte budget".into(),
        ));
    }
    if query.metrics.as_ref().is_some_and(|m| m.len() > 4096) {
        return Err(TrackerError::InvalidInput(
            "history field selection exceeds 4096".into(),
        ));
    }
    let selected = query
        .metrics
        .as_ref()
        .map(|m| m.iter().collect::<BTreeSet<_>>());
    let mut rows = Vec::new();
    let mut seen = BTreeSet::new();
    let mut bytes = 2;
    let open = query.include_open.then_some(state.open_step).flatten();
    let entries = open
        .into_iter()
        .map(|step| (step, rvx_core::now_ns(), &state.open_metrics))
        .chain(
            state
                .history
                .iter()
                .rev()
                .map(|e| (e.record.step, e.record.observed_at_ns, &e.record.metrics)),
        );
    for (step, observed, metrics) in entries {
        if rows.len() >= query.limit.unwrap_or(usize::MAX) {
            break;
        }
        if !seen.insert(step)
            || query.from_step.is_some_and(|from| step < from)
            || query.to_step.is_some_and(|to| step >= to)
        {
            continue;
        }
        let mut merged_open;
        let metrics = if open == Some(step) {
            merged_open = state
                .history
                .iter()
                .find(|e| e.record.step == step)
                .map_or_else(Default::default, |e| e.record.metrics.clone());
            merged_open.extend(metrics.clone());
            &merged_open
        } else {
            metrics
        };
        let mut values: Map<String, Value> = metrics
            .iter()
            .filter(|(key, _)| selected.as_ref().map_or(true, |s| s.contains(key)))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if query.fill_missing {
            if let Some(selected) = &selected {
                for key in selected {
                    values.entry((*key).clone()).or_insert(Value::Null);
                }
            }
        }
        if query.dropna && values.values().all(Value::is_null) {
            continue;
        }
        if query.include_meta {
            values.insert("_step".into(), step.into());
            values.insert("_time".into(), Value::from(observed as f64 / 1e9));
        }
        bytes += serde_json::to_vec(&values)?.len() + 1;
        if bytes > query.max_bytes {
            return Err(TrackerError::InvalidInput(
                "history result exceeds byte budget; narrow selection".into(),
            ));
        }
        rows.push(Value::Object(values));
    }
    rows.reverse();
    Ok(Value::Array(rows))
}
