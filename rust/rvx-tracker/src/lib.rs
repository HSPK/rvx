mod alert;
mod artifact;
mod dispatch;
mod model;
mod snapshot;
mod state;

use std::collections::{BTreeMap, VecDeque};
use std::sync::{mpsc, Arc, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use parking_lot::Mutex;
use rvx_core::now_ns;
use rvx_snapshots::{CaptureReceipt, ProducerError, SnapshotProducer};
use serde_json::Value;
use thiserror::Error;

pub use alert::{AlertEvent, AlertLevel, AlertMode, AlertRule};
pub use artifact::{ArtifactAction, ArtifactRecord};
pub use dispatch::{AlertSink, ChannelConfig, ChannelKind, DeliveryConfig};
pub use model::{CommittedStep, LogResult, SpanRecord, StepPolicy, TrackerInfo, TrackerOptions};
use snapshot::{merge_history, snapshot_event};
pub(crate) use state::numeric_value;
use state::{
    accumulate, ensure_active, object, resolve_step, step_decision, validate_metric_name,
    validate_span, StepDecision, TrackerState,
};

pub const NONFINITE_KEY: &str = "$rvx.nonfinite";

#[derive(Debug, Error)]
pub enum TrackerError {
    #[error("invalid tracker input: {0}")]
    InvalidInput(String),
    #[error("tracker is already finished")]
    Finished,
    #[error("snapshot producer error: {0}")]
    Producer(#[from] ProducerError),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, TrackerError>;

pub struct Tracker {
    producer: Arc<SnapshotProducer>,
    config: Value,
    options: TrackerOptions,
    state: Mutex<TrackerState>,
    watchdog: Mutex<Option<Watchdog>>,
    alert_sink: Option<Arc<dyn AlertSink>>,
}

struct Watchdog {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

impl Tracker {
    pub fn new(
        producer: Arc<SnapshotProducer>,
        config: Value,
        options: TrackerOptions,
        rules: Vec<AlertRule>,
        delivery: DeliveryConfig,
    ) -> Result<Arc<Self>> {
        let sink = dispatch::Dispatcher::new(delivery)?
            .map(|dispatcher| Arc::new(dispatcher) as Arc<dyn AlertSink>);
        Self::with_alert_sink(producer, config, options, rules, sink)
    }

    pub fn with_alert_sink(
        producer: Arc<SnapshotProducer>,
        config: Value,
        options: TrackerOptions,
        rules: Vec<AlertRule>,
        alert_sink: Option<Arc<dyn AlertSink>>,
    ) -> Result<Arc<Self>> {
        options.validate()?;
        if !config.is_object() {
            return Err(TrackerError::InvalidInput(
                "tracker config must be a JSON object".into(),
            ));
        }
        let started_at_ns = now_ns();
        let alerts = alert::AlertEngine::new(rules, started_at_ns, options.alert_window)?;
        let tracker = Arc::new(Self {
            producer,
            config,
            options,
            state: Mutex::new(TrackerState {
                status: "running",
                next_step: 0,
                open_step: None,
                open_metrics: BTreeMap::new(),
                open_spans: Vec::new(),
                last_committed_step: None,
                summary: BTreeMap::new(),
                history: VecDeque::new(),
                commits: 0,
                alerts,
                finished: false,
            }),
            watchdog: Mutex::new(None),
            alert_sink,
        });
        if tracker.options.watchdog_interval_ms > 0 && tracker.info().has_time_alerts {
            tracker.start_watchdog();
        }
        Ok(tracker)
    }

    pub fn log(
        &self,
        metrics: Value,
        step: Option<i64>,
        commit: Option<bool>,
        observed_at_ns: Option<i64>,
    ) -> Result<LogResult> {
        let metrics = object(metrics, "metrics")?;
        for key in metrics.keys() {
            validate_metric_name(key)?;
        }
        if step.is_some_and(|value| value < 0) {
            return Err(TrackerError::InvalidInput(
                "step must be non-negative".into(),
            ));
        }
        let should_commit = commit.unwrap_or(step.is_none());
        let observed_at_ns = observed_at_ns.unwrap_or_else(now_ns);
        let mut state = self.state.lock();
        ensure_active(&state)?;
        let status = state.status;
        let target = resolve_step(&state, step);
        let mut committed = 0;
        let mut capture = None;
        match step_decision(&state, target, &self.options.step_policy) {
            StepDecision::Keep => {}
            StepDecision::CommitOpen => {
                capture = self.commit_open_locked(&mut state, observed_at_ns, status)?;
                committed += usize::from(capture.is_some());
            }
            StepDecision::Reject(reason) => {
                return Ok(LogResult {
                    accepted: false,
                    step: Some(target),
                    committed,
                    reason: Some(reason),
                    capture,
                });
            }
        }
        let mut pending_metrics = if state.open_step == Some(target) {
            state.open_metrics.clone()
        } else {
            BTreeMap::new()
        };
        let pending_spans = if state.open_step == Some(target) {
            state.open_spans.clone()
        } else {
            Vec::new()
        };
        for (key, value) in metrics {
            pending_metrics.insert(key, value);
        }
        if should_commit {
            let receipt = self.commit_values_locked(
                &mut state,
                target,
                observed_at_ns,
                status,
                pending_metrics,
                pending_spans,
            )?;
            committed += 1;
            capture = Some(receipt);
        } else {
            state.open_step = Some(target);
            state.open_metrics = pending_metrics;
            state.open_spans = pending_spans;
        }
        Ok(LogResult {
            accepted: true,
            step: Some(target),
            committed,
            reason: None,
            capture,
        })
    }

    pub fn flush(&self, observed_at_ns: Option<i64>) -> Result<LogResult> {
        let mut state = self.state.lock();
        ensure_active(&state)?;
        let status = state.status;
        let receipt =
            self.commit_open_locked(&mut state, observed_at_ns.unwrap_or_else(now_ns), status)?;
        Ok(LogResult {
            accepted: true,
            step: state.last_committed_step,
            committed: usize::from(receipt.is_some()),
            reason: None,
            capture: receipt,
        })
    }

    pub fn record_span(&self, span: SpanRecord, step: Option<i64>) -> Result<LogResult> {
        validate_span(&span)?;
        if step.is_some_and(|value| value < 0) {
            return Err(TrackerError::InvalidInput(
                "span step must be non-negative".into(),
            ));
        }
        let mut state = self.state.lock();
        ensure_active(&state)?;
        let status = state.status;
        let target = resolve_step(&state, step);
        let mut committed = 0;
        let mut capture = None;
        match step_decision(&state, target, &self.options.step_policy) {
            StepDecision::Keep => {}
            StepDecision::CommitOpen => {
                capture = self.commit_open_locked(&mut state, span.end_ns, status)?;
                committed += usize::from(capture.is_some());
            }
            StepDecision::Reject(reason) => {
                return Ok(LogResult {
                    accepted: false,
                    step: Some(target),
                    committed,
                    reason: Some(reason),
                    capture,
                });
            }
        }
        state.open_step = Some(target);
        let time_path = format!("time_ms/{}", span.name);
        accumulate(&mut state.open_metrics, &time_path, span.duration_ms);
        if self.options.span_count {
            let count_path = format!("count/{}", span.name);
            accumulate(&mut state.open_metrics, &count_path, 1.0);
        }
        state.open_spans.push(span);
        Ok(LogResult {
            accepted: true,
            step: Some(target),
            committed,
            reason: None,
            capture,
        })
    }

    pub fn manual_alert(
        &self,
        title: &str,
        text: &str,
        level: AlertLevel,
        tags: Vec<String>,
        channels: Vec<String>,
        observed_at_ns: Option<i64>,
    ) -> Result<LogResult> {
        if title.trim().is_empty() {
            return Err(TrackerError::InvalidInput(
                "alert title must not be empty".into(),
            ));
        }
        let mut state = self.state.lock();
        ensure_active(&state)?;
        let status = state.status;
        let observed_at_ns = observed_at_ns.unwrap_or_else(now_ns);
        let step = state
            .open_step
            .or(state.last_committed_step)
            .unwrap_or(state.next_step);
        let event = state.alerts.manual(alert::ManualAlert {
            title: title.to_string(),
            text: text.to_string(),
            level,
            step,
            observed_at_ns,
            tags,
            channels,
        });
        let receipt = self.capture_auxiliary_locked(
            &mut state,
            step,
            observed_at_ns,
            vec![event],
            Vec::new(),
            None,
            status,
        )?;
        Ok(LogResult {
            accepted: true,
            step: Some(step),
            committed: 1,
            reason: None,
            capture: Some(receipt),
        })
    }

    pub fn artifact(
        &self,
        artifact: ArtifactRecord,
        observed_at_ns: Option<i64>,
    ) -> Result<LogResult> {
        let mut state = self.state.lock();
        ensure_active(&state)?;
        let status = state.status;
        let observed_at_ns = observed_at_ns.unwrap_or_else(now_ns);
        let step = state
            .open_step
            .or(state.last_committed_step)
            .unwrap_or(state.next_step);
        let receipt = self.capture_auxiliary_locked(
            &mut state,
            step,
            observed_at_ns,
            Vec::new(),
            vec![artifact],
            None,
            status,
        )?;
        Ok(LogResult {
            accepted: true,
            step: Some(step),
            committed: 1,
            reason: None,
            capture: Some(receipt),
        })
    }

    pub fn tick_alerts(&self, observed_at_ns: Option<i64>) -> Result<LogResult> {
        let mut state = self.state.lock();
        ensure_active(&state)?;
        let status = state.status;
        let observed_at_ns = observed_at_ns.unwrap_or_else(now_ns);
        let step = state
            .open_step
            .or(state.last_committed_step)
            .unwrap_or(state.next_step);
        let update = state.alerts.prepare_tick(step, observed_at_ns);
        if update.events().is_empty() {
            state.alerts.apply(update);
            return Ok(LogResult {
                accepted: true,
                step: Some(step),
                committed: 0,
                reason: None,
                capture: None,
            });
        }
        let alerts = update.events().to_vec();
        let receipt = self.capture_auxiliary_locked(
            &mut state,
            step,
            observed_at_ns,
            alerts,
            Vec::new(),
            Some(update),
            status,
        )?;
        Ok(LogResult {
            accepted: true,
            step: Some(step),
            committed: 1,
            reason: None,
            capture: Some(receipt),
        })
    }

    pub fn add_alert_rule(self: &Arc<Self>, rule: AlertRule) -> Result<()> {
        {
            let mut state = self.state.lock();
            if state.finished {
                return Err(TrackerError::Finished);
            }
            state.alerts.add_rule(rule)?;
        }
        if self.options.watchdog_interval_ms > 0
            && self.info().has_time_alerts
            && self.watchdog.lock().is_none()
        {
            self.start_watchdog();
        }
        Ok(())
    }

    pub fn remove_alert_rule(&self, name: &str) -> Result<bool> {
        let mut state = self.state.lock();
        if state.finished {
            return Err(TrackerError::Finished);
        }
        Ok(state.alerts.remove_rule(name))
    }

    pub fn alert_rules(&self) -> Vec<AlertRule> {
        self.state.lock().alerts.rules()
    }

    pub fn finish(&self, observed_at_ns: Option<i64>) -> Result<LogResult> {
        let mut state = self.state.lock();
        ensure_active(&state)?;
        let observed_at_ns = observed_at_ns.unwrap_or_else(now_ns);
        let receipt = if state.open_step.is_some() {
            self.commit_open_locked(&mut state, observed_at_ns, "finished")?
                .expect("open step produces one capture")
        } else {
            let step = state.last_committed_step.unwrap_or(state.next_step);
            self.capture_auxiliary_locked(
                &mut state,
                step,
                observed_at_ns,
                Vec::new(),
                Vec::new(),
                None,
                "finished",
            )?
        };
        state.status = "finished";
        state.finished = true;
        let result = LogResult {
            accepted: true,
            step: state.last_committed_step,
            committed: 1,
            reason: None,
            capture: Some(receipt),
        };
        drop(state);
        self.stop_watchdog();
        if let Some(sink) = &self.alert_sink {
            let _ = sink.flush(Duration::from_secs(5));
            sink.close();
        }
        self.producer.seal();
        Ok(result)
    }

    pub fn history(&self, limit: Option<usize>) -> Vec<CommittedStep> {
        let state = self.state.lock();
        let limit = limit.unwrap_or(state.history.len());
        state
            .history
            .iter()
            .skip(state.history.len().saturating_sub(limit))
            .cloned()
            .collect()
    }

    pub fn summary(&self) -> BTreeMap<String, Value> {
        self.state.lock().summary.clone()
    }

    pub fn info(&self) -> TrackerInfo {
        let state = self.state.lock();
        TrackerInfo {
            status: state.status.into(),
            next_step: state.next_step,
            open_step: state.open_step,
            last_committed_step: state.last_committed_step,
            commits: state.commits,
            history_steps: state.history.len(),
            summary_fields: state.summary.len(),
            has_time_alerts: state.alerts.has_time_rules(),
        }
    }

    fn commit_open_locked(
        &self,
        state: &mut TrackerState,
        observed_at_ns: i64,
        status: &'static str,
    ) -> Result<Option<CaptureReceipt>> {
        let Some(step) = state.open_step else {
            return Ok(None);
        };
        let receipt = self.commit_values_locked(
            state,
            step,
            observed_at_ns,
            status,
            state.open_metrics.clone(),
            state.open_spans.clone(),
        )?;
        Ok(Some(receipt))
    }

    fn commit_values_locked(
        &self,
        state: &mut TrackerState,
        step: i64,
        observed_at_ns: i64,
        status: &'static str,
        metrics: BTreeMap<String, Value>,
        spans: Vec<SpanRecord>,
    ) -> Result<CaptureReceipt> {
        let mut summary = state.summary.clone();
        for (name, value) in &metrics {
            summary.insert(name.clone(), value.clone());
        }
        let alert_update = state.alerts.prepare_step(step, observed_at_ns, &metrics);
        let alerts = alert_update.events().to_vec();
        let commits = state.commits.saturating_add(1);
        let event = snapshot_event(
            step,
            observed_at_ns,
            metrics.clone(),
            &summary,
            alerts.clone(),
            spans.clone(),
            Vec::new(),
            &self.config,
            status,
            commits,
            &self.options,
        );
        let receipt = self.producer.capture(event)?;
        if state.open_step == Some(step) {
            state.open_step = None;
            state.open_metrics.clear();
            state.open_spans.clear();
        }
        state.summary = summary.clone();
        state.alerts.apply(alert_update);
        state.commits = commits;
        state.next_step = state.next_step.max(step.saturating_add(1));
        state.last_committed_step = Some(step);
        state.status = status;
        merge_history(
            &mut state.history,
            CommittedStep {
                step,
                observed_at_ns,
                metrics,
                summary,
                alerts: alerts.clone(),
                spans,
                artifacts: Vec::new(),
            },
            self.options.history_steps,
        );
        self.dispatch_alerts(alerts);
        Ok(receipt)
    }

    #[allow(clippy::too_many_arguments)]
    fn capture_auxiliary_locked(
        &self,
        state: &mut TrackerState,
        step: i64,
        observed_at_ns: i64,
        alerts: Vec<AlertEvent>,
        artifacts: Vec<ArtifactRecord>,
        alert_update: Option<alert::AlertUpdate>,
        status: &'static str,
    ) -> Result<CaptureReceipt> {
        let commits = state.commits.saturating_add(1);
        let event = snapshot_event(
            step,
            observed_at_ns,
            BTreeMap::new(),
            &state.summary,
            alerts.clone(),
            Vec::new(),
            artifacts.clone(),
            &self.config,
            status,
            commits,
            &self.options,
        );
        let receipt = self.producer.capture(event)?;
        if let Some(update) = alert_update {
            state.alerts.apply(update);
        }
        state.commits = commits;
        state.status = status;
        if let Some(record) = state
            .history
            .iter_mut()
            .rev()
            .find(|record| record.step == step)
        {
            record.alerts.extend(alerts.clone());
            record.artifacts.extend(artifacts);
            record.observed_at_ns = record.observed_at_ns.max(observed_at_ns);
        }
        self.dispatch_alerts(alerts);
        Ok(receipt)
    }

    fn dispatch_alerts(&self, alerts: Vec<AlertEvent>) {
        if let Some(sink) = &self.alert_sink {
            for alert in alerts {
                sink.send(alert);
            }
        }
    }

    fn start_watchdog(self: &Arc<Self>) {
        let (stop, receiver) = mpsc::channel();
        let interval = Duration::from_millis(self.options.watchdog_interval_ms);
        let tracker: Weak<Self> = Arc::downgrade(self);
        let thread = std::thread::Builder::new()
            .name("rvx-tracker-watchdog".into())
            .spawn(move || loop {
                match receiver.recv_timeout(interval) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let Some(tracker) = tracker.upgrade() else {
                            return;
                        };
                        if let Err(error) = tracker.tick_alerts(None) {
                            if matches!(
                                error,
                                TrackerError::Finished
                                    | TrackerError::Producer(ProducerError::Sealed)
                            ) {
                                return;
                            }
                            eprintln!("RVX tracker watchdog failed: {error}");
                        }
                    }
                }
            })
            .expect("spawn RVX tracker watchdog");
        *self.watchdog.lock() = Some(Watchdog { stop, thread });
    }

    fn stop_watchdog(&self) {
        if let Some(watchdog) = self.watchdog.lock().take() {
            let _ = watchdog.stop.send(());
            if watchdog.thread.thread().id() != std::thread::current().id() {
                let _ = watchdog.thread.join();
            }
        }
    }
}

impl Drop for Tracker {
    fn drop(&mut self) {
        if let Some(watchdog) = self.watchdog.get_mut().take() {
            let _ = watchdog.stop.send(());
            if watchdog.thread.thread().id() != std::thread::current().id() {
                let _ = watchdog.thread.join();
            }
        }
    }
}

#[cfg(test)]
mod tests;
