use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use rvx_tracker::{
    AlertLevel, AlertRule, ArtifactAction, ArtifactRecord, DeliveryConfig, SpanRecord, Tracker,
    TrackerOptions,
};
use serde_json::Value;

use crate::source::RvxSource;
use rvx_core::now_ns;

const MAX_TRACKER_INPUT_BYTES: usize = 16 * 1024 * 1024;

#[pyclass(module = "rvx._native")]
pub struct RvxTracker {
    source: RvxSource,
    tracker: Arc<Tracker>,
    owner_pid: u32,
}

#[pyclass(module = "rvx._native")]
pub struct RvxTrackerSpan {
    tracker: Arc<Tracker>,
    name: String,
    start_ns: i64,
    started: Instant,
    step: Option<i64>,
    owner_pid: u32,
    ended: Mutex<bool>,
}

#[pymethods]
impl RvxTracker {
    #[new]
    #[pyo3(signature = (
        identity_json,
        config_json="{}".to_string(),
        options_json="{}".to_string(),
        alert_rules_json="[]".to_string(),
        alert_config_json="{}".to_string(),
        capacity=1_024,
        max_buffer_bytes=67_108_864
    ))]
    fn new(
        py: Python<'_>,
        identity_json: String,
        config_json: String,
        options_json: String,
        alert_rules_json: String,
        alert_config_json: String,
        capacity: usize,
        max_buffer_bytes: usize,
    ) -> PyResult<Self> {
        for (name, value) in [
            ("tracker config", &config_json),
            ("tracker options", &options_json),
            ("tracker alert rules", &alert_rules_json),
            ("tracker alert config", &alert_config_json),
        ] {
            if value.len() > MAX_TRACKER_INPUT_BYTES {
                return Err(PyValueError::new_err(format!("{name} exceeds 16 MiB")));
            }
        }
        let source = RvxSource::new(py, identity_json, capacity, max_buffer_bytes)?;
        let config: Value = serde_json::from_str(&config_json).map_err(input_error)?;
        let options: TrackerOptions = serde_json::from_str(&options_json).map_err(input_error)?;
        let rules = rules(&alert_rules_json)?;
        let delivery: DeliveryConfig =
            serde_json::from_str(&alert_config_json).map_err(input_error)?;
        let tracker = Tracker::new(source.producer(), config, options, rules, delivery)
            .map_err(operation_error)?;
        Ok(Self {
            source,
            tracker,
            owner_pid: std::process::id(),
        })
    }

    fn log_json(
        &self,
        py: Python<'_>,
        metrics_json: String,
        step: Option<i64>,
        commit: Option<bool>,
        observed_at_ns: Option<i64>,
    ) -> PyResult<String> {
        self.check_process()?;
        if metrics_json.len() > MAX_TRACKER_INPUT_BYTES {
            return Err(PyValueError::new_err("tracker metrics exceed 16 MiB"));
        }
        py.allow_threads(|| {
            let metrics: Value = serde_json::from_str(&metrics_json).map_err(input_error)?;
            serde_json::to_string(
                &self
                    .tracker
                    .log(metrics, step, commit, observed_at_ns)
                    .map_err(operation_error)?,
            )
            .map_err(operation_error)
        })
    }

    fn flush_json(&self, py: Python<'_>, observed_at_ns: Option<i64>) -> PyResult<String> {
        self.check_process()?;
        py.allow_threads(|| {
            serde_json::to_string(
                &self
                    .tracker
                    .flush(observed_at_ns)
                    .map_err(operation_error)?,
            )
            .map_err(operation_error)
        })
    }

    fn start_span_json(
        &self,
        _py: Python<'_>,
        name: String,
        step: Option<i64>,
    ) -> PyResult<RvxTrackerSpan> {
        self.check_process()?;
        Ok(RvxTrackerSpan {
            tracker: Arc::clone(&self.tracker),
            name,
            start_ns: now_ns(),
            started: Instant::now(),
            step,
            owner_pid: self.owner_pid,
            ended: Mutex::new(false),
        })
    }

    #[pyo3(signature = (
        title,
        text,
        level="warning",
        tags=Vec::new(),
        channels=Vec::new(),
        observed_at_ns=None
    ))]
    fn alert_json(
        &self,
        py: Python<'_>,
        title: String,
        text: String,
        level: &str,
        tags: Vec<String>,
        channels: Vec<String>,
        observed_at_ns: Option<i64>,
    ) -> PyResult<String> {
        self.check_process()?;
        let level = parse_level(level)?;
        py.allow_threads(|| {
            serde_json::to_string(
                &self
                    .tracker
                    .manual_alert(&title, &text, level, tags, channels, observed_at_ns)
                    .map_err(operation_error)?,
            )
            .map_err(operation_error)
        })
    }

    fn add_alert_rule_json(&self, py: Python<'_>, rule_json: String) -> PyResult<()> {
        self.check_process()?;
        if rule_json.len() > MAX_TRACKER_INPUT_BYTES {
            return Err(PyValueError::new_err("alert rule exceeds 16 MiB"));
        }
        py.allow_threads(|| {
            let value: Value = serde_json::from_str(&rule_json).map_err(input_error)?;
            self.tracker
                .add_alert_rule(rule(value, self.tracker.alert_rules().len())?)
                .map_err(operation_error)
        })
    }

    fn remove_alert_rule(&self, py: Python<'_>, name: String) -> PyResult<bool> {
        self.check_process()?;
        py.allow_threads(|| {
            self.tracker
                .remove_alert_rule(&name)
                .map_err(operation_error)
        })
    }

    fn alert_rules_json(&self, py: Python<'_>) -> PyResult<String> {
        self.check_process()?;
        py.allow_threads(|| {
            serde_json::to_string(&self.tracker.alert_rules()).map_err(operation_error)
        })
    }

    #[allow(clippy::too_many_arguments)]
    #[pyo3(signature = (
        action,
        path,
        name,
        kind="artifact",
        aliases=Vec::new(),
        metadata_json="{}".to_string(),
        observed_at_ns=None
    ))]
    fn artifact_local_json(
        &self,
        py: Python<'_>,
        action: &str,
        path: String,
        name: String,
        kind: &str,
        aliases: Vec<String>,
        metadata_json: String,
        observed_at_ns: Option<i64>,
    ) -> PyResult<String> {
        self.check_process()?;
        let action = parse_action(action)?;
        py.allow_threads(|| {
            let metadata: Value = serde_json::from_str(&metadata_json).map_err(input_error)?;
            let artifact = ArtifactRecord::local(
                action,
                PathBuf::from(path),
                name,
                kind.to_string(),
                aliases,
                metadata,
            )
            .map_err(operation_error)?;
            serde_json::to_string(
                &self
                    .tracker
                    .artifact(artifact, observed_at_ns)
                    .map_err(operation_error)?,
            )
            .map_err(operation_error)
        })
    }

    #[allow(clippy::too_many_arguments)]
    #[pyo3(signature = (
        action,
        uri,
        name,
        digest,
        kind="artifact",
        aliases=Vec::new(),
        metadata_json="{}".to_string(),
        observed_at_ns=None
    ))]
    fn artifact_reference_json(
        &self,
        py: Python<'_>,
        action: &str,
        uri: String,
        name: String,
        digest: String,
        kind: &str,
        aliases: Vec<String>,
        metadata_json: String,
        observed_at_ns: Option<i64>,
    ) -> PyResult<String> {
        self.check_process()?;
        let action = parse_action(action)?;
        py.allow_threads(|| {
            let metadata: Value = serde_json::from_str(&metadata_json).map_err(input_error)?;
            let artifact = ArtifactRecord::reference(
                action,
                uri,
                name,
                kind.to_string(),
                digest,
                aliases,
                metadata,
            )
            .map_err(operation_error)?;
            serde_json::to_string(
                &self
                    .tracker
                    .artifact(artifact, observed_at_ns)
                    .map_err(operation_error)?,
            )
            .map_err(operation_error)
        })
    }

    #[pyo3(signature = (limit=None))]
    fn tracker_history_json(&self, py: Python<'_>, limit: Option<isize>) -> PyResult<String> {
        self.check_process()?;
        let limit = match limit {
            None | Some(-1) => None,
            Some(value) if value >= 0 => Some(value as usize),
            Some(_) => {
                return Err(PyValueError::new_err(
                    "history limit must be non-negative, -1, or None",
                ))
            }
        };
        py.allow_threads(|| {
            serde_json::to_string(&self.tracker.history(limit)).map_err(operation_error)
        })
    }

    fn summary_json(&self, py: Python<'_>) -> PyResult<String> {
        self.check_process()?;
        py.allow_threads(|| serde_json::to_string(&self.tracker.summary()).map_err(operation_error))
    }

    fn tracker_info_json(&self, py: Python<'_>) -> PyResult<String> {
        self.check_process()?;
        py.allow_threads(|| serde_json::to_string(&self.tracker.info()).map_err(operation_error))
    }

    fn finish_json(&self, py: Python<'_>, observed_at_ns: Option<i64>) -> PyResult<String> {
        self.check_process()?;
        py.allow_threads(|| {
            serde_json::to_string(
                &self
                    .tracker
                    .finish(observed_at_ns)
                    .map_err(operation_error)?,
            )
            .map_err(operation_error)
        })
    }

    #[pyo3(signature = (listen="127.0.0.1:0"))]
    fn serve(&self, py: Python<'_>, listen: &str) -> PyResult<String> {
        self.source.serve(py, listen)
    }

    #[getter]
    fn endpoint(&self, py: Python<'_>) -> PyResult<String> {
        self.source.endpoint(py)
    }

    #[getter]
    fn source_session_id(&self) -> PyResult<String> {
        self.source.source_session_id()
    }

    fn source_stats_json(&self, py: Python<'_>) -> PyResult<String> {
        self.source.stats_json(py)
    }

    fn descriptor_bytes<'py>(&self, py: Python<'py>) -> PyResult<&'py PyBytes> {
        self.source.descriptor_bytes(py)
    }

    fn latest_bytes<'py>(&self, py: Python<'py>) -> PyResult<&'py PyBytes> {
        self.source.latest_bytes(py)
    }

    #[pyo3(signature = (after=0, limit=64))]
    fn history_bytes<'py>(
        &self,
        py: Python<'py>,
        after: u64,
        limit: usize,
    ) -> PyResult<&'py PyBytes> {
        self.source.history_bytes(py, after, limit)
    }

    fn stop_serving(&self, py: Python<'_>) -> PyResult<()> {
        self.source.stop_serving(py)
    }

    fn close(&self, py: Python<'_>) -> PyResult<()> {
        self.check_process()?;
        if self.tracker.info().status == "running" {
            let _ = self.tracker.finish(None);
        }
        self.source.close(py)
    }
}

#[pymethods]
impl RvxTrackerSpan {
    fn end_json(
        &self,
        py: Python<'_>,
        attributes_json: String,
        error: Option<String>,
    ) -> PyResult<String> {
        if std::process::id() != self.owner_pid {
            return Err(PyRuntimeError::new_err(
                "do not reuse tracker spans after fork",
            ));
        }
        let mut ended = self.ended.lock();
        if *ended {
            return Ok("null".into());
        }
        if attributes_json.len() > MAX_TRACKER_INPUT_BYTES {
            return Err(PyValueError::new_err("span attributes exceed 16 MiB"));
        }
        let attributes: Value = serde_json::from_str(&attributes_json).map_err(input_error)?;
        if !attributes.is_object() {
            return Err(PyValueError::new_err(
                "span attributes must be a JSON object",
            ));
        }
        let elapsed = self.started.elapsed();
        let duration_ms = elapsed.as_secs_f64() * 1_000.0;
        let end_ns = self
            .start_ns
            .saturating_add(elapsed.as_nanos().min(i64::MAX as u128) as i64);
        let result = py.allow_threads(|| {
            self.tracker
                .record_span(
                    SpanRecord {
                        name: self.name.clone(),
                        start_ns: self.start_ns,
                        end_ns,
                        duration_ms,
                        attributes,
                        error,
                    },
                    self.step,
                )
                .map_err(operation_error)
        })?;
        *ended = true;
        serde_json::to_string(&serde_json::json!({
            "duration_ms": duration_ms,
            "result": result,
        }))
        .map_err(operation_error)
    }
}

impl RvxTracker {
    fn check_process(&self) -> PyResult<()> {
        if std::process::id() != self.owner_pid {
            return Err(PyRuntimeError::new_err(
                "construct Tracker inside each worker process; do not reuse it after fork",
            ));
        }
        Ok(())
    }
}

fn rules(payload: &str) -> PyResult<Vec<AlertRule>> {
    let values: Vec<Value> = serde_json::from_str(payload).map_err(input_error)?;
    values
        .into_iter()
        .enumerate()
        .map(|(index, value)| rule(value, index))
        .collect()
}

fn rule(value: Value, index: usize) -> PyResult<AlertRule> {
    match value {
        Value::String(value) => AlertRule::parse(&value, index).map_err(operation_error),
        value => serde_json::from_value(value).map_err(input_error),
    }
}

fn parse_level(value: &str) -> PyResult<AlertLevel> {
    serde_json::from_value(Value::String(value.to_ascii_lowercase())).map_err(input_error)
}

fn parse_action(value: &str) -> PyResult<ArtifactAction> {
    serde_json::from_value(Value::String(value.to_ascii_lowercase())).map_err(input_error)
}

fn input_error(error: impl std::fmt::Display) -> PyErr {
    PyValueError::new_err(error.to_string())
}

fn operation_error(error: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(error.to_string())
}
