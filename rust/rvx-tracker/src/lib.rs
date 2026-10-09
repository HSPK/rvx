mod alert;
mod alert_sink;
mod artifact;
mod delivery;
mod history;
mod model;
mod snapshot;
mod state;

use std::collections::{BTreeMap, VecDeque};
use std::sync::{mpsc, Arc, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use parking_lot::Mutex;
use rvx_core::{now_ns, TrackerRecordKind};
use rvx_snapshots::{ProducerError, SnapshotEvent, SnapshotProducer};
use serde_json::{json, Value};
use thiserror::Error;

pub use alert::{
    replay as replay_alerts, AlertEvent, AlertLevel, AlertMode, AlertRule, ReplayInput, RuleAxis,
};
pub use alert_sink::AlertSink;
pub use artifact::{
    local as local_artifact, reference as reference_artifact, ArtifactAction, ArtifactRecord,
};
pub use delivery::DeliveryStats;
pub use model::{
    CommittedStep, HistoryQuery, LogResult, SpanRecord, StepPolicy, TrackerInfo, TrackerOptions,
};
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
    #[error("tracker invariant failed: {0}")]
    Invariant(String),
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
    alert_queue: Option<delivery::AlertQueue>,
    owner_pid: u32,
}

struct Watchdog {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

/// History records and alert windows are shared; preparation copies only mutable working state.
struct PreparedBatch {
    next: TrackerState,
    events: Vec<SnapshotEvent>,
    alerts: Vec<AlertEvent>,
}

impl Tracker {
    pub fn new(
        producer: Arc<SnapshotProducer>,
        config: Value,
        options: TrackerOptions,
        rules: Vec<AlertRule>,
    ) -> Result<Arc<Self>> {
        Self::with_alert_sink(producer, config, options, rules, None)
    }

    pub fn with_alert_sink(
        producer: Arc<SnapshotProducer>,
        config: Value,
        options: TrackerOptions,
        rules: Vec<AlertRule>,
        sink: Option<Arc<dyn AlertSink>>,
    ) -> Result<Arc<Self>> {
        options.validate()?;
        if !config.is_object() {
            return Err(TrackerError::InvalidInput(
                "tracker config must be a JSON object".into(),
            ));
        }
        let alerts = alert::AlertEngine::new(rules, now_ns(), options.alert_window)?;
        let state = TrackerState {
            status: "running",
            next_step: 0,
            open_step: None,
            open_metrics: BTreeMap::new(),
            open_spans: Vec::new(),
            last_committed_step: None,
            summary: BTreeMap::new(),
            history: VecDeque::new(),
            history_bytes: 0,
            evicted_steps: 0,
            commits: 0,
            alerts,
            finished: false,
        };
        let alert_queue = sink
            .map(|sink| {
                delivery::AlertQueue::new(
                    sink,
                    options.delivery_queue_capacity,
                    options.max_state_bytes,
                )
            })
            .transpose()?;
        let tracker = Arc::new(Self {
            producer,
            config,
            options,
            state: Mutex::new(state),
            watchdog: Mutex::new(None),
            alert_queue,
            owner_pid: std::process::id(),
        });
        tracker.check_budget(&tracker.state.lock())?;
        if tracker.options.watchdog_interval_ms > 0 && tracker.info().has_time_alerts {
            tracker.start_watchdog()?;
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
        validate_step(step)?;
        let observed = observed_at_ns.unwrap_or_else(now_ns);
        self.transact(|batch| {
            let target = resolve_step(&batch.next, step);
            if let Some(rejected) = self.select_step(batch, target, observed)? {
                return Ok(rejected);
            }
            batch.next.open_step = Some(target);
            batch.next.open_metrics.extend(metrics);
            if commit.unwrap_or(step.is_none()) {
                self.prepare_commit(batch, observed)?;
            }
            Ok(accepted(Some(target)))
        })
    }

    pub fn flush(&self, observed_at_ns: Option<i64>) -> Result<LogResult> {
        self.transact(|batch| {
            self.prepare_commit(batch, observed_at_ns.unwrap_or_else(now_ns))?;
            Ok(accepted(batch.next.last_committed_step))
        })
    }

    pub fn record_span(&self, span: SpanRecord, step: Option<i64>) -> Result<LogResult> {
        validate_span(&span)?;
        validate_step(step)?;
        self.transact(|batch| {
            let target = resolve_step(&batch.next, step);
            if let Some(rejected) = self.select_step(batch, target, span.end_ns)? {
                return Ok(rejected);
            }
            batch.next.open_step = Some(target);
            accumulate(
                &mut batch.next.open_metrics,
                &format!("time_ms/{}", span.name),
                span.duration_ms,
            );
            if self.options.span_count {
                accumulate(
                    &mut batch.next.open_metrics,
                    &format!("count/{}", span.name),
                    1.0,
                );
            }
            batch.next.open_spans.push(span);
            Ok(accepted(Some(target)))
        })
    }

    #[allow(clippy::too_many_arguments)]
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
        self.transact(|batch| {
            let observed = observed_at_ns.unwrap_or_else(now_ns);
            let step = event_step(&batch.next);
            let event = batch.next.alerts.manual(alert::ManualAlert {
                title: title.into(),
                text: text.into(),
                level,
                step,
                observed_at_ns: observed,
                tags,
                channels,
            });
            self.prepare_event(batch, observed, vec![event], Vec::new())?;
            Ok(accepted(Some(step)))
        })
    }

    pub fn artifact(
        &self,
        artifact: ArtifactRecord,
        observed_at_ns: Option<i64>,
    ) -> Result<LogResult> {
        artifact
            .validate()
            .map_err(|e| TrackerError::InvalidInput(e.to_string()))?;
        self.transact(|batch| {
            let step = event_step(&batch.next);
            self.prepare_event(
                batch,
                observed_at_ns.unwrap_or_else(now_ns),
                Vec::new(),
                vec![artifact],
            )?;
            Ok(accepted(Some(step)))
        })
    }

    pub fn tick_alerts(&self, observed_at_ns: Option<i64>) -> Result<LogResult> {
        self.transact(|batch| {
            let step = event_step(&batch.next);
            let observed = observed_at_ns.unwrap_or_else(now_ns);
            let update = batch.next.alerts.prepare_tick(step, observed);
            let alerts = update.events().to_vec();
            batch.next.alerts.apply(update);
            if !alerts.is_empty() {
                self.prepare_event(batch, observed, alerts, Vec::new())?;
            }
            Ok(accepted(Some(step)))
        })
    }

    pub fn add_alert_rule(self: &Arc<Self>, rule: AlertRule) -> Result<()> {
        // Serialize watchdog ownership before changing rules so concurrent additions cannot leak workers.
        let mut owner = self.watchdog.lock();
        let mut state = self.state.lock();
        ensure_active(&state)?;
        let mut alerts = state.alerts.clone();
        alerts.add_rule(rule)?;
        if owner.is_none() && self.options.watchdog_interval_ms > 0 && alerts.has_time_rules() {
            *owner = Some(self.spawn_watchdog()?);
        }
        state.alerts = alerts;
        Ok(())
    }

    pub fn remove_alert_rule(&self, name: &str) -> Result<bool> {
        let mut state = self.state.lock();
        ensure_active(&state)?;
        Ok(state.alerts.remove_rule(name))
    }

    pub fn alert_rules(&self) -> Vec<AlertRule> {
        self.state.lock().alerts.rules()
    }

    pub fn finish(&self, observed_at_ns: Option<i64>) -> Result<LogResult> {
        self.finish_status(observed_at_ns, false)
    }

    pub fn finish_status(&self, observed_at_ns: Option<i64>, failed: bool) -> Result<LogResult> {
        if self.state.lock().finished {
            return Ok(accepted(self.state.lock().last_committed_step));
        }
        let result = self.transact(|batch| {
            let observed = observed_at_ns.unwrap_or_else(now_ns);
            self.prepare_commit(batch, observed)?;
            batch.next.status = if failed { "failed" } else { "finished" };
            self.prepare_event(batch, observed, Vec::new(), Vec::new())?;
            batch.next.finished = true;
            Ok(accepted(batch.next.last_committed_step))
        })?;
        self.stop_watchdog();
        if let Some(queue) = &self.alert_queue {
            if !queue.close(Duration::from_millis(self.options.shutdown_timeout_ms)) {
                eprintln!("RVX tracker finished with incomplete alert delivery");
            }
        }
        Ok(result)
    }

    pub fn history(&self, limit: Option<usize>) -> Vec<CommittedStep> {
        let state = self.state.lock();
        state
            .history
            .iter()
            .skip(
                state
                    .history
                    .len()
                    .saturating_sub(limit.unwrap_or(state.history.len())),
            )
            .map(|entry| (*entry.record).clone())
            .collect()
    }

    pub fn history_query(&self, query: &HistoryQuery) -> Result<Value> {
        history::query(&self.state.lock(), query)
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
            history_bytes: state.history_bytes,
            evicted_steps: state.evicted_steps,
            accepted_next_sequence: self.producer.stats().next_sequence,
        }
    }

    pub fn delivery_stats(&self) -> DeliveryStats {
        self.alert_queue
            .as_ref()
            .map_or_else(DeliveryStats::default, delivery::AlertQueue::stats)
    }

    pub fn sink_stats(&self) -> DeliveryStats {
        self.alert_queue
            .as_ref()
            .map_or_else(DeliveryStats::default, delivery::AlertQueue::sink_stats)
    }

    fn transact(
        &self,
        prepare: impl FnOnce(&mut PreparedBatch) -> Result<LogResult>,
    ) -> Result<LogResult> {
        let mut state = self.state.lock();
        ensure_active(&state)?;
        let mut batch = PreparedBatch {
            next: state.clone(),
            events: Vec::new(),
            alerts: Vec::new(),
        };
        let mut result = prepare(&mut batch)?;
        self.check_budget(&batch.next)?;
        result.committed = batch.events.len();
        if !batch.events.is_empty() {
            result.capture = Some(self.producer.capture_batch(batch.events)?);
        }
        *state = batch.next;
        if state.finished {
            self.producer.seal();
        }
        // Enqueue in commit order under the lock; the worker is the only caller of foreign sinks.
        if let Some(queue) = &self.alert_queue {
            for alert in batch.alerts {
                queue.send(alert);
            }
        }
        Ok(result)
    }

    fn select_step(
        &self,
        batch: &mut PreparedBatch,
        target: i64,
        observed: i64,
    ) -> Result<Option<LogResult>> {
        match step_decision(&batch.next, target, &self.options.step_policy) {
            StepDecision::Keep => Ok(None),
            StepDecision::CommitOpen => {
                self.prepare_commit(batch, observed)?;
                Ok(None)
            }
            StepDecision::Reject(reason) => Ok(Some(LogResult {
                accepted: false,
                step: Some(target),
                committed: 0,
                reason: Some(reason),
                capture: None,
            })),
        }
    }

    fn prepare_commit(&self, batch: &mut PreparedBatch, observed: i64) -> Result<()> {
        let state = &mut batch.next;
        let Some(step) = state.open_step.take() else {
            return Ok(());
        };
        let metrics = std::mem::take(&mut state.open_metrics);
        let spans = std::mem::take(&mut state.open_spans);
        state.summary.extend(metrics.clone());
        let update = state.alerts.prepare_step(step, observed, &metrics);
        let alerts = update.events().to_vec();
        state.alerts.apply(update);
        state.commits += 1;
        state.next_step = state.next_step.max(
            step.checked_add(1)
                .ok_or_else(|| TrackerError::InvalidInput("step cursor exhausted".into()))?,
        );
        state.last_committed_step = Some(step);
        let record = CommittedStep {
            step,
            observed_at_ns: observed,
            metrics: metrics.clone(),
            summary: state.summary.clone(),
            alerts: alerts.clone(),
            spans: spans.clone(),
            artifacts: Vec::new(),
        };
        batch.events.push(snapshot_event(
            step,
            observed,
            metrics,
            &state.summary,
            alerts.clone(),
            spans,
            Vec::new(),
            &self.config,
            state.status,
            state.commits,
            &self.options,
            TrackerRecordKind::Observation,
        ));
        merge_history(state, record, &self.options)?;
        self.check_budget(state)?;
        batch.alerts.extend(alerts);
        Ok(())
    }

    fn prepare_event(
        &self,
        batch: &mut PreparedBatch,
        observed: i64,
        alerts: Vec<AlertEvent>,
        artifacts: Vec<ArtifactRecord>,
    ) -> Result<()> {
        let state = &mut batch.next;
        let step = event_step(state);
        state.commits += 1;
        batch.events.push(snapshot_event(
            step,
            observed,
            BTreeMap::new(),
            &state.summary,
            alerts.clone(),
            Vec::new(),
            artifacts,
            &self.config,
            state.status,
            state.commits,
            &self.options,
            TrackerRecordKind::Event,
        ));
        batch.alerts.extend(alerts);
        Ok(())
    }

    fn check_budget(&self, state: &TrackerState) -> Result<()> {
        if state.open_metrics.len() > self.options.max_metrics
            || state.summary.len() > self.options.max_metrics
            || state.open_spans.len() > self.options.max_spans
        {
            return Err(TrackerError::InvalidInput(
                "tracker metric/span cardinality budget exceeded".into(),
            ));
        }
        let bytes = serde_json::to_vec(&json!({
            "open": state.open_metrics, "spans": state.open_spans,
            "summary": state.summary, "config": self.config,
        }))?
        .len();
        if bytes > self.options.max_state_bytes {
            return Err(TrackerError::InvalidInput(
                "tracker working-state byte budget exceeded".into(),
            ));
        }
        state.alerts.check_budget(
            self.options.max_metrics,
            self.options.max_alert_series_bytes,
        )
    }

    fn start_watchdog(self: &Arc<Self>) -> Result<()> {
        let mut owner = self.watchdog.lock();
        if owner.is_none() {
            *owner = Some(self.spawn_watchdog()?);
        }
        Ok(())
    }

    fn spawn_watchdog(self: &Arc<Self>) -> Result<Watchdog> {
        let (stop, receiver) = mpsc::channel();
        let interval = Duration::from_millis(self.options.watchdog_interval_ms);
        let tracker: Weak<Self> = Arc::downgrade(self);
        let thread = std::thread::Builder::new()
            .name("rvx-tracker-watchdog".into())
            .spawn(move || {
                while matches!(
                    receiver.recv_timeout(interval),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    let Some(tracker) = tracker.upgrade() else {
                        break;
                    };
                    if let Err(error) = tracker.tick_alerts(None) {
                        if matches!(
                            error,
                            TrackerError::Finished | TrackerError::Producer(ProducerError::Sealed)
                        ) {
                            break;
                        }
                        eprintln!("RVX tracker watchdog failed: {error}");
                    }
                }
            })?;
        Ok(Watchdog { stop, thread })
    }

    fn stop_watchdog(&self) {
        let owner = self.watchdog.lock().take();
        if let Some(owner) = owner {
            let _ = owner.stop.send(());
            if owner.thread.thread().id() != std::thread::current().id()
                && owner.thread.join().is_err()
            {
                eprintln!("RVX watchdog worker panicked");
            }
        }
    }
}

impl Drop for Tracker {
    fn drop(&mut self) {
        if self.owner_pid != std::process::id() {
            if let Some(watchdog) = self.watchdog.get_mut().take() {
                std::mem::forget(watchdog);
            }
            if let Some(queue) = self.alert_queue.take() {
                std::mem::forget(queue);
            }
        } else {
            self.stop_watchdog();
        }
    }
}

fn accepted(step: Option<i64>) -> LogResult {
    LogResult {
        accepted: true,
        step,
        committed: 0,
        reason: None,
        capture: None,
    }
}
fn event_step(state: &TrackerState) -> i64 {
    state
        .open_step
        .or(state.last_committed_step)
        .unwrap_or(state.next_step)
}
fn validate_step(step: Option<i64>) -> Result<()> {
    if step.is_some_and(|s| s < 0 || s == i64::MAX) {
        return Err(TrackerError::InvalidInput(
            "step must be in 0..i64::MAX".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
