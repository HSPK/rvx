use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{validate_name, ProtocolError, Result, PROTOCOL_VERSION};

pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
pub const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SNAPSHOT_PAGE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_SNAPSHOT_DEPTH: usize = 64;
pub const MAX_SNAPSHOT_NODES: usize = 100_000;
pub const DEFAULT_SNAPSHOT_HISTORY_LIMIT: usize = 64;
pub const MAX_SNAPSHOT_HISTORY_LIMIT: usize = 256;
pub const MAX_SNAPSHOT_QUERY_RUNS: usize = 64;
pub const MAX_SNAPSHOT_QUERY_PATHS: usize = 64;
pub const MAX_SNAPSHOT_SOURCE_IDS: usize = 256;
pub const MAX_SNAPSHOT_QUERY_POINTS: usize = 10_000;
pub const MAX_SNAPSHOT_DIFF_CHANGES: usize = 1_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotDescriptor {
    pub protocol_version: u32,
    pub source_session_id: String,
    pub project: String,
    pub experiment: String,
    pub run_id: String,
    pub attempt_id: String,
    pub role: String,
    pub rank: Option<i64>,
    pub node_id: Option<String>,
    pub pid: Option<u32>,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default = "default_snapshot_schema_version")]
    pub schema_version: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StateSnapshot {
    pub source_session_id: String,
    pub sequence: u64,
    pub observed_at_ns: i64,
    #[serde(default = "default_snapshot_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub axes: BTreeMap<String, i64>,
    pub state: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotHistoryResponse {
    pub protocol_version: u32,
    pub source_session_id: String,
    pub oldest_sequence: u64,
    pub next_sequence: u64,
    #[serde(default)]
    pub dropped_before: Option<u64>,
    pub snapshots: Vec<StateSnapshot>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StoredSnapshot {
    pub id: i64,
    pub run_id: String,
    pub source_id: String,
    pub ingested_at_ns: i64,
    #[serde(flatten)]
    pub snapshot: StateSnapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotLatestRequest {
    pub run_id: String,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default = "default_snapshot_page_limit")]
    pub limit: usize,
    #[serde(default)]
    pub after_source_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotLatestResponse {
    pub snapshots: Vec<StoredSnapshot>,
    pub next_source_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotHistoryRequest {
    pub run_id: String,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub before_id: Option<i64>,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
    #[serde(default = "default_snapshot_page_limit")]
    pub limit: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotHistoryPage {
    pub snapshots: Vec<StoredSnapshot>,
    pub next_before_id: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotQueryRequest {
    pub run_ids: Vec<String>,
    pub paths: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default = "default_snapshot_axis")]
    pub axis: String,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
    #[serde(default = "default_snapshot_max_points")]
    pub max_points: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotQuerySeries {
    pub run_id: String,
    pub source_id: String,
    pub path: String,
    pub snapshot_ids: Vec<i64>,
    pub source_session_ids: Vec<String>,
    pub sequences: Vec<u64>,
    pub axes: Vec<i64>,
    pub observed_at_ns: Vec<i64>,
    pub values: Vec<Option<f64>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotQueryResponse {
    pub axis: String,
    pub series: Vec<SnapshotQuerySeries>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChartCatalogRequest {
    pub run_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChartRunInfo {
    pub run_id: String,
    pub snapshot_count: u64,
    pub first_observed_at_ns: Option<i64>,
    pub last_observed_at_ns: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChartGroup {
    Training,
    Throughput,
    Pipeline,
    Resources,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChartMetricSource {
    pub run_id: String,
    pub source_id: String,
    pub label: String,
    pub role: String,
    pub rank: Option<i64>,
    pub node_id: Option<String>,
    pub primary: bool,
    pub latest_value: Option<f64>,
    pub observed_at_ns: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChartMetric {
    pub path: String,
    pub name: String,
    pub group: ChartGroup,
    pub unit: Option<String>,
    pub run_ids: Vec<String>,
    pub sources: Vec<ChartMetricSource>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChartCatalogResponse {
    pub runs: Vec<ChartRunInfo>,
    pub metrics: Vec<ChartMetric>,
    pub defaults: Vec<String>,
    pub axes: Vec<String>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotDiffRequest {
    pub before_id: i64,
    pub after_id: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotChangeKind {
    Added,
    Removed,
    Changed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotChange {
    pub path: String,
    pub kind: SnapshotChangeKind,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    pub before: Option<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    pub after: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotDiffResponse {
    pub before_id: i64,
    pub after_id: i64,
    pub changes: Vec<SnapshotChange>,
    pub truncated: bool,
}

fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

pub fn default_snapshot_schema_version() -> u32 {
    SNAPSHOT_SCHEMA_VERSION
}
pub fn default_snapshot_page_limit() -> usize {
    100
}
pub fn default_snapshot_max_points() -> usize {
    1600
}
pub fn default_snapshot_axis() -> String {
    "wall_time".into()
}

pub fn validate_snapshot_descriptor(descriptor: &SnapshotDescriptor) -> Result<()> {
    if descriptor.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion(
            descriptor.protocol_version,
        ));
    }
    if descriptor.schema_version != SNAPSHOT_SCHEMA_VERSION {
        return Err(ProtocolError::InvalidSnapshot(
            "unsupported schema_version".into(),
        ));
    }
    for (field, value) in [
        ("source_session_id", descriptor.source_session_id.as_str()),
        ("project", descriptor.project.as_str()),
        ("experiment", descriptor.experiment.as_str()),
        ("run_id", descriptor.run_id.as_str()),
        ("attempt_id", descriptor.attempt_id.as_str()),
        ("role", descriptor.role.as_str()),
    ] {
        validate_name(field, value)?;
        if value.len() > 4096 {
            return Err(ProtocolError::InvalidSnapshot(
                "descriptor identifier exceeds 4096 bytes".into(),
            ));
        }
    }
    Ok(())
}

pub fn validate_state_snapshot(snapshot: &StateSnapshot) -> Result<()> {
    validate_name("source_session_id", &snapshot.source_session_id)?;
    if snapshot.source_session_id.len() > 4096 {
        return Err(ProtocolError::InvalidSnapshot(
            "session identifier exceeds 4096 bytes".into(),
        ));
    }
    if snapshot.schema_version != SNAPSHOT_SCHEMA_VERSION || !snapshot.state.is_object() {
        return Err(ProtocolError::InvalidSnapshot(
            "schema_version must be 1 and state must be an object".into(),
        ));
    }
    if snapshot.sequence >= i64::MAX as u64 {
        return Err(ProtocolError::InvalidSnapshot(
            "sequence exceeds durable cursor range".into(),
        ));
    }
    if snapshot.axes.len() > crate::MAX_SNAPSHOT_AXES {
        return Err(ProtocolError::TooManyAxes);
    }
    let mut stack = vec![(&snapshot.state, 0)];
    let mut nodes = 0;
    while let Some((value, depth)) = stack.pop() {
        nodes += 1;
        if nodes > MAX_SNAPSHOT_NODES {
            return Err(ProtocolError::InvalidSnapshot(
                "state exceeds 100000 JSON nodes".into(),
            ));
        }
        if depth > MAX_SNAPSHOT_DEPTH {
            return Err(ProtocolError::InvalidSnapshot(
                "JSON nesting exceeds 64 levels".into(),
            ));
        }
        match value {
            Value::Object(map) => stack.extend(map.values().map(|v| (v, depth + 1))),
            Value::Array(array) => stack.extend(array.iter().map(|v| (v, depth + 1))),
            Value::Number(number)
                if !number.is_i64()
                    && !number.is_u64()
                    && !(number.is_f64() && number.as_f64().is_some_and(f64::is_finite)) =>
            {
                return Err(ProtocolError::InvalidSnapshot(
                    "state numbers must be signed/unsigned 64-bit integers or finite floats".into(),
                ));
            }
            _ => (),
        }
    }
    if serde_json::to_vec(snapshot)
        .map_err(|e| ProtocolError::InvalidSnapshot(e.to_string()))?
        .len()
        > MAX_SNAPSHOT_BYTES
    {
        return Err(ProtocolError::InvalidSnapshot(
            "snapshot exceeds 4 MiB".into(),
        ));
    }
    Ok(())
}

pub fn validate_snapshot_history_response(response: &SnapshotHistoryResponse) -> Result<()> {
    if response.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion(response.protocol_version));
    }
    validate_name("source_session_id", &response.source_session_id)?;
    if response.snapshots.len() > MAX_SNAPSHOT_HISTORY_LIMIT {
        return Err(ProtocolError::InvalidSnapshot(
            "history page exceeds 256 snapshots".into(),
        ));
    }
    if response.oldest_sequence > response.next_sequence || response.next_sequence > i64::MAX as u64
    {
        return Err(ProtocolError::InvalidNextSequence);
    }
    if response
        .dropped_before
        .is_some_and(|n| n != response.oldest_sequence)
    {
        return Err(ProtocolError::InvalidSnapshot(
            "dropped_before must equal oldest_sequence".into(),
        ));
    }
    let mut prior = None;
    for snapshot in &response.snapshots {
        validate_state_snapshot(snapshot)?;
        if snapshot.source_session_id != response.source_session_id {
            return Err(ProtocolError::SessionMismatch);
        }
        if snapshot.sequence < response.oldest_sequence
            || prior.is_some_and(|n| snapshot.sequence != n + 1)
        {
            return Err(ProtocolError::NonIncreasingSequence);
        }
        prior = Some(snapshot.sequence);
    }
    if prior.is_some_and(|n| response.next_sequence != n + 1) {
        return Err(ProtocolError::InvalidNextSequence);
    }
    if serde_json::to_vec(response)
        .map_err(|e| ProtocolError::InvalidSnapshot(e.to_string()))?
        .len()
        > MAX_SNAPSHOT_PAGE_BYTES
    {
        return Err(ProtocolError::InvalidSnapshot(
            "history page exceeds 16 MiB".into(),
        ));
    }
    Ok(())
}

/// Reject malformed RFC 6901 escapes instead of silently treating them as missing fields.
pub fn validate_snapshot_pointer(path: &str) -> Result<()> {
    if path.len() > 4096 || (!path.is_empty() && !path.starts_with('/')) {
        return Err(ProtocolError::InvalidSnapshot(
            "field path must be an RFC 6901 JSON pointer".into(),
        ));
    }
    let mut chars = path.chars();
    while let Some(ch) = chars.next() {
        if ch == '~' && !matches!(chars.next(), Some('0' | '1')) {
            return Err(ProtocolError::InvalidSnapshot(
                "invalid JSON pointer escape".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_defaults_and_diff_null_presence_round_trip() {
        let snapshot: StateSnapshot = serde_json::from_value(json!({
            "source_session_id": "s", "sequence": 0, "observed_at_ns": 1,
            "state": {"nested": [true, null, "ready", {"n": 2}]}
        }))
        .unwrap();
        assert_eq!(snapshot.schema_version, 1);
        validate_state_snapshot(&snapshot).unwrap();
        let request: SnapshotQueryRequest =
            serde_json::from_value(json!({"run_ids":["r"],"paths":["/n"]})).unwrap();
        assert_eq!(
            (request.axis.as_str(), request.max_points),
            ("wall_time", 1600)
        );
        let change: SnapshotChange =
            serde_json::from_value(json!({"path":"/n","kind":"added","after":null})).unwrap();
        assert_eq!(change.before, None);
        assert_eq!(change.after, Some(Value::Null));
        assert_eq!(
            serde_json::to_value(change).unwrap(),
            json!({"path":"/n","kind":"added","after":null})
        );
    }

    #[test]
    fn rejects_invalid_shapes_depth_size_and_pointer_escapes() {
        let mut snapshot = StateSnapshot {
            source_session_id: "s".into(),
            sequence: 0,
            observed_at_ns: 0,
            schema_version: 1,
            axes: BTreeMap::new(),
            state: json!({}),
        };
        for invalid in [
            json!(null),
            json!([]),
            json!(true),
            json!("string"),
            json!(1),
        ] {
            snapshot.state = invalid;
            assert!(validate_state_snapshot(&snapshot).is_err());
        }
        snapshot.state = json!({"huge": "x".repeat(MAX_SNAPSHOT_BYTES)});
        assert!(validate_state_snapshot(&snapshot).is_err());
        let mut value = json!({});
        for _ in 0..=MAX_SNAPSHOT_DEPTH {
            value = json!({"nested": value});
        }
        snapshot.state = value;
        assert!(validate_state_snapshot(&snapshot).is_err());
        snapshot.state = json!({"nodes": vec![Value::Null; MAX_SNAPSHOT_NODES]});
        assert!(validate_state_snapshot(&snapshot).is_err());
        for pointer in ["", "/metrics/cpu~1percent", "/a~0b/0", "/"] {
            validate_snapshot_pointer(pointer).unwrap();
        }
        for pointer in ["field", "/bad~", "/bad~2", "/bad~01~"] {
            assert!(validate_snapshot_pointer(pointer).is_err());
        }
    }

    #[test]
    fn depth_starts_at_state_root_and_large_integers_are_not_rounded() {
        let mut state = Value::Null;
        for _ in 0..MAX_SNAPSHOT_DEPTH {
            state = json!({"nested":state});
        }
        let mut snapshot = StateSnapshot {
            source_session_id: "s".into(),
            sequence: 0,
            observed_at_ns: 0,
            schema_version: 1,
            axes: BTreeMap::new(),
            state,
        };
        validate_state_snapshot(&snapshot).unwrap();
        snapshot.state = json!({"nested":snapshot.state});
        assert!(validate_state_snapshot(&snapshot).is_err());
        for raw in ["18446744073709551616", "-9223372036854775809", "1e400"] {
            snapshot.state = serde_json::from_str(&format!("{{\"number\":{raw}}}")).unwrap();
            assert!(
                validate_state_snapshot(&snapshot).is_err(),
                "{raw} must not round into an accepted float"
            );
        }
        snapshot.state = serde_json::from_str(
            "{\"low\":-9223372036854775808,\"high\":18446744073709551615,\"float\":1e30}",
        )
        .unwrap();
        validate_state_snapshot(&snapshot).unwrap();
        assert_eq!(snapshot.state["high"].as_u64(), Some(u64::MAX));
    }
}
