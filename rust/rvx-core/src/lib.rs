use std::collections::BTreeMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

mod snapshots;
pub use snapshots::*;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_BATCH_POINTS: usize = 100_000;
pub const MAX_METRICS_PER_POINT: usize = 4_096;
pub const MAX_AXES_PER_POINT: usize = 64;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("{field} must not be empty")]
    Empty { field: &'static str },
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u32),
    #[error("point batch exceeds {MAX_BATCH_POINTS} points")]
    TooManyPoints,
    #[error("point contains too many metric values")]
    TooManyMetrics,
    #[error("point contains too many logical axes")]
    TooManyAxes,
    #[error("metric {0:?} is not finite")]
    NonFiniteMetric(String),
    #[error("point sequence must be strictly increasing within a batch")]
    NonIncreasingSequence,
    #[error("point session does not match the response session")]
    SessionMismatch,
    #[error("next_sequence must be greater than every returned sequence")]
    InvalidNextSequence,
    #[error("invalid snapshot: {0}")]
    InvalidSnapshot(String),
}

pub type Result<T> = std::result::Result<T, ProtocolError>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MetricKind {
    Gauge,
    Counter,
    WeightedMean,
    Histogram,
    Event,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Reducer {
    Last,
    Sum,
    Minimum,
    Maximum,
    WeightedMean,
    MergeHistogram,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Created,
    Running,
    Finished,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Discovered,
    Active,
    Stale,
    Draining,
    Ended,
    Lost,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MetricDefinition {
    pub name: String,
    pub kind: MetricKind,
    pub unit: String,
    pub default_axis: String,
    pub source_scope: String,
    pub reducer: Reducer,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SourceDescriptor {
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
    #[serde(default)]
    pub metrics: Vec<MetricDefinition>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MetricPoint {
    pub source_session_id: String,
    pub sequence: u64,
    pub event_time_ns: i64,
    #[serde(default)]
    pub ingest_time_ns: i64,
    #[serde(default)]
    pub axes: BTreeMap<String, i64>,
    #[serde(default)]
    pub values: BTreeMap<String, f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SnapshotResponse {
    pub protocol_version: u32,
    pub source_session_id: String,
    pub sequence: u64,
    pub event_time_ns: i64,
    #[serde(default)]
    pub axes: BTreeMap<String, i64>,
    #[serde(default)]
    pub metrics: BTreeMap<String, f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PointsResponse {
    pub protocol_version: u32,
    pub source_session_id: String,
    pub oldest_sequence: u64,
    pub next_sequence: u64,
    #[serde(default)]
    pub dropped_before: Option<u64>,
    #[serde(default)]
    pub points: Vec<MetricPoint>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MetricBatch {
    pub run_id: String,
    pub source_id: String,
    pub source_session_id: String,
    pub oldest_sequence: u64,
    pub next_sequence: u64,
    #[serde(default)]
    pub dropped_before: Option<u64>,
    pub points: Vec<MetricPoint>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at_ns: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Experiment {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub created_at_ns: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Run {
    pub id: String,
    pub experiment_id: String,
    pub name: String,
    pub status: RunStatus,
    pub config_json: String,
    pub created_at_ns: i64,
    pub updated_at_ns: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub role: String,
    pub endpoint: String,
    pub node_id: Option<String>,
    pub rank: Option<i64>,
    pub state: SourceState,
    pub source_session_id: Option<String>,
    pub last_success_at_ns: Option<i64>,
    pub last_error: Option<String>,
    pub scrape_interval_ms: u64,
    pub timeout_ms: u64,
    pub descriptor: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SourceRegistration {
    pub run_id: String,
    pub attempt_id: String,
    pub role: String,
    pub endpoint: String,
    pub node_id: Option<String>,
    pub rank: Option<i64>,
    pub scrape_interval_ms: u64,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QueryRequest {
    pub run_id: String,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub metrics: Vec<String>,
    #[serde(default = "default_query_axis")]
    pub axis: String,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
    #[serde(default = "default_max_points")]
    pub max_points: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QuerySeries {
    pub metric: String,
    pub source_id: String,
    pub source_session_ids: Vec<String>,
    pub sequences: Vec<u64>,
    pub axes: Vec<i64>,
    pub event_time_ns: Vec<i64>,
    pub values: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QueryResponse {
    pub run_id: String,
    pub axis: String,
    pub series: Vec<QuerySeries>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SummaryRequest {
    pub run_ids: Vec<String>,
    pub metrics: Vec<String>,
    #[serde(default = "default_query_axis")]
    pub axis: String,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RunSummary {
    pub run_id: String,
    pub values: BTreeMap<String, f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SummaryResponse {
    pub summaries: Vec<RunSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EngineStats {
    pub snapshots: u64,
    pub projects: u64,
    pub experiments: u64,
    pub runs: u64,
    pub sources: u64,
    pub active_sources: u64,
    pub hot_points: u64,
    pub parquet_files: u64,
    pub wal_bytes: u64,
    pub ingested_points: u64,
    pub compacted_values: u64,
    pub duplicate_points: u64,
    pub cursor_gaps: u64,
    pub scrape_failures: u64,
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}

pub fn now_ns() -> i64 {
    Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| Utc::now().timestamp_micros() * 1_000)
}

pub fn validate_name(field: &'static str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(ProtocolError::Empty { field });
    }
    Ok(())
}

pub fn validate_descriptor(descriptor: &SourceDescriptor) -> Result<()> {
    if descriptor.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion(
            descriptor.protocol_version,
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
    }
    Ok(())
}

pub fn validate_points_response(response: &PointsResponse) -> Result<()> {
    if response.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion(response.protocol_version));
    }
    validate_name("source_session_id", &response.source_session_id)?;
    if response.points.len() > MAX_BATCH_POINTS {
        return Err(ProtocolError::TooManyPoints);
    }
    let mut prior = None;
    for point in &response.points {
        if point.source_session_id != response.source_session_id {
            return Err(ProtocolError::SessionMismatch);
        }
        if point.values.len() > MAX_METRICS_PER_POINT {
            return Err(ProtocolError::TooManyMetrics);
        }
        if point.axes.len() > MAX_AXES_PER_POINT {
            return Err(ProtocolError::TooManyAxes);
        }
        if point.values.iter().any(|(name, value)| {
            if value.is_finite() {
                false
            } else {
                let _ = name;
                true
            }
        }) {
            let name = point
                .values
                .iter()
                .find(|(_, value)| !value.is_finite())
                .map(|(name, _)| name.clone())
                .unwrap_or_default();
            return Err(ProtocolError::NonFiniteMetric(name));
        }
        if prior.is_some_and(|sequence| point.sequence <= sequence) {
            return Err(ProtocolError::NonIncreasingSequence);
        }
        prior = Some(point.sequence);
    }
    if prior.is_some_and(|sequence| response.next_sequence <= sequence) {
        return Err(ProtocolError::InvalidNextSequence);
    }
    Ok(())
}

/// Use observation time unless callers explicitly request a logical training axis.
fn default_query_axis() -> String {
    "wall_time".to_string()
}

fn default_max_points() -> usize {
    2_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_monotonic_batches() {
        let response = PointsResponse {
            protocol_version: PROTOCOL_VERSION,
            source_session_id: "session".to_string(),
            oldest_sequence: 1,
            next_sequence: 3,
            dropped_before: None,
            points: vec![
                MetricPoint {
                    source_session_id: "session".to_string(),
                    sequence: 2,
                    event_time_ns: 1,
                    ingest_time_ns: 0,
                    axes: BTreeMap::new(),
                    values: BTreeMap::new(),
                },
                MetricPoint {
                    source_session_id: "session".to_string(),
                    sequence: 2,
                    event_time_ns: 2,
                    ingest_time_ns: 0,
                    axes: BTreeMap::new(),
                    values: BTreeMap::new(),
                },
            ],
        };

        assert!(matches!(
            validate_points_response(&response),
            Err(ProtocolError::NonIncreasingSequence)
        ));
    }
}
