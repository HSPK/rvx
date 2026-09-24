use std::collections::BTreeMap;

use rvx_snapshots::CaptureReceipt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{AlertEvent, ArtifactRecord, Result, TrackerError};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StepPolicy {
    #[default]
    Monotonic,
    Allow,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct TrackerOptions {
    pub step_axis: String,
    pub history_steps: usize,
    pub step_policy: StepPolicy,
    pub span_count: bool,
    pub alert_window: usize,
    pub watchdog_interval_ms: u64,
}

impl Default for TrackerOptions {
    fn default() -> Self {
        Self {
            step_axis: "step".into(),
            history_steps: 1_024,
            step_policy: StepPolicy::Monotonic,
            span_count: false,
            alert_window: 1_024,
            watchdog_interval_ms: 30_000,
        }
    }
}

impl TrackerOptions {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.step_axis.trim().is_empty()
            || self.step_axis.contains('\0')
            || self.step_axis.len() > 256
        {
            return Err(TrackerError::InvalidInput(
                "step_axis must contain 1..=256 non-NUL bytes".into(),
            ));
        }
        if !(1..=1_000_000).contains(&self.history_steps) {
            return Err(TrackerError::InvalidInput(
                "history_steps must be between 1 and 1000000".into(),
            ));
        }
        if !(1..=100_000).contains(&self.alert_window) {
            return Err(TrackerError::InvalidInput(
                "alert_window must be between 1 and 100000".into(),
            ));
        }
        if self.watchdog_interval_ms != 0 && !(100..=3_600_000).contains(&self.watchdog_interval_ms)
        {
            return Err(TrackerError::InvalidInput(
                "watchdog_interval_ms must be zero or between 100 and 3600000".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SpanRecord {
    pub name: String,
    pub start_ns: i64,
    pub end_ns: i64,
    pub duration_ms: f64,
    #[serde(default)]
    pub attributes: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct CommittedStep {
    pub step: i64,
    pub observed_at_ns: i64,
    pub metrics: BTreeMap<String, Value>,
    pub summary: BTreeMap<String, Value>,
    pub alerts: Vec<AlertEvent>,
    pub spans: Vec<SpanRecord>,
    pub artifacts: Vec<ArtifactRecord>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LogResult {
    pub accepted: bool,
    pub step: Option<i64>,
    pub committed: usize,
    pub reason: Option<String>,
    pub capture: Option<CaptureReceipt>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct TrackerInfo {
    pub status: String,
    pub next_step: i64,
    pub open_step: Option<i64>,
    pub last_committed_step: Option<i64>,
    pub commits: u64,
    pub history_steps: usize,
    pub summary_fields: usize,
    pub has_time_alerts: bool,
}
