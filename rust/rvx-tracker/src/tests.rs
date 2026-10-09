use std::collections::BTreeMap;

use rvx_core::{new_id, SnapshotDescriptor, PROTOCOL_VERSION};
use rvx_snapshots::BufferLimits;
use serde_json::json;

use super::*;

fn tracker(rules: Vec<AlertRule>) -> Arc<Tracker> {
    let producer = SnapshotProducer::new(
        SnapshotDescriptor {
            protocol_version: PROTOCOL_VERSION,
            source_session_id: new_id("session"),
            project: "project".into(),
            experiment: "experiment".into(),
            run_id: "run".into(),
            attempt_id: "attempt-1".into(),
            role: "tracker".into(),
            rank: None,
            node_id: None,
            pid: None,
            labels: BTreeMap::new(),
            schema_version: 1,
        },
        BufferLimits::default(),
    )
    .unwrap();
    Tracker::new(
        producer,
        json!({"seed": 1}),
        TrackerOptions::default(),
        rules,
    )
    .unwrap()
}

#[test]
fn wandb_style_commit_semantics_capture_full_tracker_states() {
    let tracker = tracker(Vec::new());
    assert_eq!(
        tracker
            .log(json!({"loss": 1.0}), Some(4), None, Some(10))
            .unwrap()
            .committed,
        0
    );
    assert_eq!(
        tracker
            .log(json!({"lr": 0.1}), Some(4), Some(true), Some(20))
            .unwrap()
            .committed,
        1
    );
    tracker
        .log(json!({"loss": 0.5}), None, None, Some(30))
        .unwrap();
    let history = tracker.history(None);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].step, 4);
    assert_eq!(history[0].metrics["loss"], 1.0);
    assert_eq!(history[0].metrics["lr"], 0.1);
    assert_eq!(history[1].step, 5);
    assert_eq!(tracker.summary()["loss"], 0.5);
}

#[test]
fn spans_alerts_and_artifacts_share_the_snapshot_evidence_stream() {
    let rules = vec![AlertRule::parse("loss > 2 => error: high loss", 0).unwrap()];
    let tracker = tracker(rules);
    tracker
        .record_span(
            SpanRecord {
                name: "forward".into(),
                start_ns: 10,
                end_ns: 20,
                duration_ms: 0.00001,
                attributes: json!({"batch": 2}),
                error: None,
            },
            None,
        )
        .unwrap();
    tracker
        .log(json!({"loss": 3.0}), None, None, Some(30))
        .unwrap();
    let history = tracker.history(None);
    assert_eq!(history[0].alerts.len(), 1);
    assert_eq!(history[0].spans.len(), 1);
    assert!(history[0].metrics.contains_key("time_ms/forward"));
}

#[test]
fn monotonic_policy_rejects_old_steps_but_allows_same_step_patches() {
    let tracker = tracker(Vec::new());
    tracker
        .log(json!({"x": 1}), Some(5), Some(true), None)
        .unwrap();
    let patch = tracker
        .log(json!({"y": 2}), Some(5), Some(true), None)
        .unwrap();
    assert!(patch.accepted);
    let rejected = tracker
        .log(json!({"z": 3}), Some(4), Some(true), None)
        .unwrap();
    assert!(!rejected.accepted);
    let history = tracker.history(None);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].metrics["x"], 1);
    assert_eq!(history[0].metrics["y"], 2);
}

#[test]
fn failed_capture_does_not_advance_tracker_or_alert_state() {
    let tracker = tracker(vec![AlertRule::parse("loss > 1 => error: high", 0).unwrap()]);
    let before = tracker.info();
    let error = tracker
        .log(
            json!({
                "loss": 2.0,
                "oversized": "x".repeat(rvx_core::MAX_SNAPSHOT_BYTES + 1),
            }),
            None,
            None,
            Some(10),
        )
        .unwrap_err();
    assert!(matches!(error, TrackerError::Producer(_)));
    assert_eq!(tracker.info(), before);
    assert!(tracker.summary().is_empty());
    assert!(tracker.history(None).is_empty());

    tracker
        .log(json!({"loss": 2.0}), None, None, Some(20))
        .unwrap();
    let history = tracker.history(None);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].alerts.len(), 1);
    assert_eq!(history[0].alerts[0].message, "high");
}

#[test]
fn custom_alert_sink_is_decoupled_from_tracker_state_machine() {
    struct RecordingSink(Mutex<Vec<AlertEvent>>);
    impl AlertSink for RecordingSink {
        fn send(&self, event: AlertEvent) {
            self.0.lock().push(event);
        }
        fn flush(&self, _timeout: Duration) -> bool {
            true
        }
        fn close(&self) {}
    }

    let producer = SnapshotProducer::new(
        SnapshotDescriptor {
            protocol_version: PROTOCOL_VERSION,
            source_session_id: new_id("session"),
            project: "project".into(),
            experiment: "experiment".into(),
            run_id: "run".into(),
            attempt_id: "attempt-1".into(),
            role: "tracker".into(),
            rank: None,
            node_id: None,
            pid: None,
            labels: BTreeMap::new(),
            schema_version: 1,
        },
        BufferLimits::default(),
    )
    .unwrap();
    let sink = Arc::new(RecordingSink(Mutex::new(Vec::new())));
    let tracker = Tracker::with_alert_sink(
        producer,
        json!({}),
        TrackerOptions::default(),
        vec![AlertRule::parse("loss > 1 => error: high", 0).unwrap()],
        Some(sink.clone()),
    )
    .unwrap();
    tracker
        .log(json!({"loss": 2.0}), None, None, Some(1))
        .unwrap();
    tracker.finish(Some(2)).unwrap();
    assert_eq!(sink.0.lock().len(), 1);
}

#[test]
fn an_entire_multi_step_call_is_atomic_and_retryable() {
    let tracker = tracker(vec![AlertRule::parse("loss > 1 => error: high", 0).unwrap()]);
    tracker
        .log(json!({"loss": 2}), Some(0), Some(false), Some(1))
        .unwrap();
    let before = tracker.info();
    assert!(tracker
        .log(
            json!({"huge":"x".repeat(rvx_core::MAX_SNAPSHOT_BYTES + 1)}),
            Some(1),
            Some(true),
            Some(2)
        )
        .is_err());
    assert_eq!(tracker.info(), before);
    assert!(tracker.summary().is_empty());
    assert!(tracker.history(None).is_empty());
    let result = tracker
        .log(json!({"loss":3}), Some(1), Some(true), Some(3))
        .unwrap();
    let receipt = result.capture.unwrap();
    assert_eq!(receipt.accepted, 2);
    assert_eq!(receipt.first_sequence, 0);
    assert_eq!(tracker.history(None)[0].alerts.len(), 1);
}

#[test]
fn event_records_and_finish_never_replace_the_latest_observation() {
    let prototype = tracker(vec![]);
    let producer = SnapshotProducer::new(
        prototype.producer.descriptor(),
        BufferLimits {
            max_snapshots: 1,
            ..BufferLimits::default()
        },
    )
    .unwrap();
    let tracker = Tracker::new(
        producer.clone(),
        json!({}),
        TrackerOptions::default(),
        vec![],
    )
    .unwrap();
    tracker
        .log(json!({"loss":0.25}), None, None, Some(1))
        .unwrap();
    for i in 2..6 {
        tracker
            .manual_alert("notice", "event", AlertLevel::Info, vec![], vec![], Some(i))
            .unwrap();
        assert_eq!(producer.latest().unwrap().state["metrics"]["loss"], 0.25);
        assert!(rvx_core::is_tracker_event(
            &producer.history(i as u64 - 1, 1).unwrap().snapshots[0].state
        )
        .unwrap());
    }
    tracker.finish_status(Some(6), true).unwrap();
    assert_eq!(producer.latest().unwrap().sequence, 0);
    assert_eq!(tracker.info().status, "failed");
    assert_eq!(tracker.info().accepted_next_sequence, 6);
}

#[test]
fn all_tracker_budgets_reject_before_mutating_state() {
    let prototype = tracker(vec![]);
    let tracker = Tracker::new(
        prototype.producer.clone(),
        json!({}),
        TrackerOptions {
            max_metrics: 1,
            max_state_bytes: 2048,
            max_history_bytes: 700,
            max_alert_series_bytes: 1024,
            ..TrackerOptions::default()
        },
        vec![],
    )
    .unwrap();
    for i in 0..10 {
        tracker.log(json!({"x":i}), None, None, Some(i)).unwrap();
    }
    assert!(tracker.info().history_bytes <= 700);
    assert!(tracker.info().evicted_steps > 0);
    let before = tracker.info();
    assert!(tracker.log(json!({"y":1}), None, Some(false), None).is_ok());
    assert!(tracker.log(json!({"z":2}), None, None, None).is_err());
    tracker.log(json!({"y":1}), None, None, None).unwrap_err();
    assert_eq!(tracker.info().commits, before.commits);
}

#[test]
fn history_selection_happens_before_output_budget_and_preserves_open_patches() {
    let tracker = tracker(vec![]);
    tracker
        .log(
            json!({"loss":1,"unused":"x".repeat(10000)}),
            Some(2),
            Some(true),
            Some(10),
        )
        .unwrap();
    tracker
        .log(json!({"lr":0.1}), Some(2), Some(false), Some(11))
        .unwrap();
    let result = tracker
        .history_query(&HistoryQuery {
            metrics: Some(vec!["loss".into(), "lr".into()]),
            max_bytes: 256,
            ..HistoryQuery::default()
        })
        .unwrap();
    assert_eq!(result[0]["loss"], 1);
    assert_eq!(result[0]["lr"], 0.1);
    assert_eq!(
        tracker
            .history_query(&HistoryQuery {
                limit: Some(0),
                ..HistoryQuery::default()
            })
            .unwrap(),
        json!([])
    );
    assert!(tracker
        .history_query(&HistoryQuery {
            include_open: false,
            max_bytes: 256,
            ..HistoryQuery::default()
        })
        .is_err());
}

#[test]
fn a_reentrant_sink_is_not_called_under_the_tracker_state_lock() {
    struct Reentrant(Mutex<Option<Weak<Tracker>>>);
    impl AlertSink for Reentrant {
        fn send(&self, _: AlertEvent) {
            if let Some(tracker) = self.0.lock().as_ref().and_then(Weak::upgrade) {
                tracker.info();
            }
        }
        fn flush(&self, _: Duration) -> bool {
            true
        }
        fn close(&self) {}
    }
    let prototype = tracker(vec![]);
    let sink = Arc::new(Reentrant(Mutex::new(None)));
    let tracker = Tracker::with_alert_sink(
        prototype.producer.clone(),
        json!({}),
        TrackerOptions::default(),
        vec![],
        Some(sink.clone()),
    )
    .unwrap();
    *sink.0.lock() = Some(Arc::downgrade(&tracker));
    tracker
        .manual_alert("a", "b", AlertLevel::Info, vec![], vec![], None)
        .unwrap();
    tracker.finish(None).unwrap();
    assert_eq!(tracker.delivery_stats().completed, 1);
}

#[test]
fn blocking_foreign_sink_cannot_extend_finish_deadline() {
    struct Blocking;
    impl AlertSink for Blocking {
        fn send(&self, _: AlertEvent) {
            std::thread::sleep(Duration::from_millis(300));
        }
        fn flush(&self, _: Duration) -> bool {
            true
        }
        fn close(&self) {}
    }
    let prototype = tracker(vec![]);
    let tracker = Tracker::with_alert_sink(
        prototype.producer.clone(),
        json!({}),
        TrackerOptions {
            shutdown_timeout_ms: 20,
            ..TrackerOptions::default()
        },
        vec![],
        Some(Arc::new(Blocking)),
    )
    .unwrap();
    tracker
        .manual_alert("a", "b", AlertLevel::Info, vec![], vec![], None)
        .unwrap();
    let started = std::time::Instant::now();
    tracker.finish(None).unwrap();
    assert!(started.elapsed() < Duration::from_millis(200));
}
