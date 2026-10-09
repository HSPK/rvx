use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ProtocolError, Result};

pub const TRACKER_RECORD_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrackerRecordKind {
    Observation,
    Event,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TrackerHeader {
    pub record_version: u32,
    pub kind: TrackerRecordKind,
    pub step: i64,
    pub status: String,
    pub commit: u64,
    #[serde(default)]
    pub nonfinite: Vec<String>,
}

/// Only an explicitly versioned tracker record participates in event semantics.
pub fn tracker_header(state: &Value) -> Result<Option<TrackerHeader>> {
    let Some(value) = state
        .get("tracker")
        .filter(|v| v.get("record_version").is_some())
    else {
        return Ok(None);
    };
    let header: TrackerHeader = serde_json::from_value(value.clone())
        .map_err(|e| ProtocolError::InvalidSnapshot(format!("invalid tracker header: {e}")))?;
    if header.record_version != TRACKER_RECORD_VERSION || header.step < 0 {
        return Err(ProtocolError::InvalidSnapshot(
            "unsupported tracker record version or step".into(),
        ));
    }
    Ok(Some(header))
}

pub fn is_tracker_event(state: &Value) -> Result<bool> {
    Ok(tracker_header(state)?.is_some_and(|h| h.kind == TrackerRecordKind::Event))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedCursorRequest {
    pub run_id: String,
    pub source_id: String,
    pub source_session_id: String,
    pub next_sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PersistedCursorResponse {
    pub run_id: String,
    pub source_id: String,
    pub source_session_id: String,
    pub persisted_next_sequence: u64,
    pub complete: bool,
    pub has_gaps: bool,
}
