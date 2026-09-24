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
        DeliveryConfig::default(),
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
    assert_eq!(sink.0.lock().len(), 1);
}
