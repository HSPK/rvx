use chrono::Utc;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

mod snapshots;
pub use snapshots::*;
mod tables;
pub use tables::*;
mod ui;
pub use ui::*;
mod snapshot_views;
pub use snapshot_views::*;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_SNAPSHOT_AXES: usize = 64;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("{field} must not be empty")]
    Empty { field: &'static str },
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u32),
    #[error("snapshot contains too many logical axes")]
    TooManyAxes,
    #[error("snapshot session does not match the response session")]
    SessionMismatch,
    #[error("snapshot sequence must be strictly increasing within a batch")]
    NonIncreasingSequence,
    #[error("next_sequence must be greater than every returned sequence")]
    InvalidNextSequence,
    #[error("invalid snapshot: {0}")]
    InvalidSnapshot(String),
}

pub type Result<T> = std::result::Result<T, ProtocolError>;

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
pub struct EngineStats {
    pub projects: u64,
    pub experiments: u64,
    pub runs: u64,
    pub sources: u64,
    pub active_sources: u64,
    pub snapshots: u64,
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
