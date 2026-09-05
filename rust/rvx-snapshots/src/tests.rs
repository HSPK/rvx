use super::*;
use serde_json::json;

fn producer(limits: BufferLimits) -> Arc<SnapshotProducer> {
    SnapshotProducer::new(
        SnapshotDescriptor {
            protocol_version: 1,
            source_session_id: "session-test".into(),
            project: "p".into(),
            experiment: "e".into(),
            run_id: "r".into(),
            attempt_id: "a".into(),
            role: "worker".into(),
            rank: None,
            node_id: None,
            pid: None,
            labels: BTreeMap::new(),
            schema_version: 1,
        },
        limits,
    )
    .unwrap()
}

fn event(state: Value) -> SnapshotEvent {
    SnapshotEvent {
        state,
        observed_at_ns: Some(42),
        axes: BTreeMap::new(),
    }
}

#[test]
fn full_replacement_and_immutable_history() {
    let producer = producer(BufferLimits::default());
    let mut original = event(json!({"phase":"training", "queue":[1, {"ready":true}], "loss":0.4}));
    producer.capture(original.clone()).unwrap();
    original.state["queue"][0] = json!(999);
    let retained = producer.latest().unwrap();
    producer
        .capture(event(json!({"phase":null, "queue":[]})))
        .unwrap();
    assert_eq!(retained.state["queue"][0], 1);
    assert_eq!(retained.state["loss"], 0.4);
    assert!(producer.latest().unwrap().state.get("loss").is_none());
    assert!(producer.latest().unwrap().state["phase"].is_null());
    let history = producer.history(0, 64).unwrap();
    assert_eq!(history.snapshots.len(), 2);
    assert_eq!(history.snapshots[0].state, retained.state);
    assert_eq!(history.snapshots[1].schema_version, 1);
}

#[test]
fn empty_history_validation_and_seal() {
    let producer = producer(BufferLimits::default());
    let empty = producer.history(0, 64).unwrap();
    assert!(empty.snapshots.is_empty());
    assert_eq!(
        (
            empty.oldest_sequence,
            empty.next_sequence,
            empty.dropped_before
        ),
        (0, 0, None)
    );
    assert!(matches!(
        producer.latest(),
        Err(ProducerError::SnapshotUnavailable)
    ));
    for (after, limit) in [(1, 64), (0, 0), (0, 257)] {
        assert!(producer.history(after, limit).is_err());
    }
    producer.capture(event(json!({}))).unwrap();
    assert_eq!(producer.seal(), 1);
    assert_eq!(producer.seal(), 1);
    assert!(producer.stats().sealed);
    assert_eq!(producer.stats().buffered_snapshots, 1);
    assert!(producer.stats().buffered_bytes > 0);
    assert!(matches!(
        producer.capture(event(json!({}))),
        Err(ProducerError::Sealed)
    ));
    assert_eq!(producer.latest().unwrap().state, json!({}));
}

#[test]
fn releasing_history_preserves_session_counters_and_in_flight_readers() {
    let producer = producer(BufferLimits {
        max_snapshots: 2,
        ..BufferLimits::default()
    });
    for index in 0..3 {
        producer.capture(event(json!({"index": index}))).unwrap();
    }
    let descriptor = producer.descriptor_bytes().unwrap();
    let latest = producer.latest().unwrap();
    let selected = producer.select_history(0, 64).unwrap();
    assert_eq!(Arc::strong_count(&latest), 3);
    assert_eq!(producer.seal_and_release_history(), 3);
    assert_eq!(producer.seal_and_release_history(), 3);
    assert_eq!(producer.descriptor_bytes().unwrap(), descriptor);
    assert_eq!(
        producer.stats(),
        ProducerStats {
            buffered_snapshots: 0,
            buffered_bytes: 0,
            dropped_snapshots: 1,
            oldest_sequence: 3,
            next_sequence: 3,
            sealed: true,
        }
    );
    assert_eq!(Arc::strong_count(&latest), 2);
    assert_eq!(latest.state, json!({"index": 2}));
    assert_eq!(selected.snapshots[0].state, json!({"index": 1}));
    let bytes = serde_json::to_vec(&HistoryWire {
        protocol_version: 1,
        source_session_id: "session-test",
        oldest_sequence: selected.oldest_sequence,
        next_sequence: selected.next_sequence,
        dropped_before: selected.dropped_before,
        snapshots: selected.snapshots.iter().map(Arc::as_ref).collect(),
    })
    .unwrap();
    let page: SnapshotHistoryResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(page.snapshots.len(), 2);
    assert_eq!(page.next_sequence, 3);
    assert!(matches!(
        producer.latest_bytes(),
        Err(ProducerError::SnapshotUnavailable)
    ));
    let empty: SnapshotHistoryResponse =
        serde_json::from_slice(&producer.history_bytes(0, 64).unwrap()).unwrap();
    assert!(empty.snapshots.is_empty());
    assert_eq!(empty.next_sequence, 3);
    assert_eq!(empty.dropped_before, Some(3));
    assert!(matches!(
        producer.capture(event(json!({}))),
        Err(ProducerError::Sealed)
    ));
}

#[test]
fn raw_bytes_match_shared_protocol_dtos_and_errors() {
    let producer = producer(BufferLimits::default());
    assert_eq!(
        producer.descriptor_bytes().unwrap(),
        serde_json::to_vec(&producer.descriptor()).unwrap()
    );
    assert_eq!(
        producer.history_bytes(0, 64).unwrap(),
        serde_json::to_vec(&producer.history(0, 64).unwrap()).unwrap()
    );
    assert!(matches!(
        producer.latest_bytes(),
        Err(ProducerError::SnapshotUnavailable)
    ));
    for (after, limit) in [(1, 64), (u64::MAX, 64), (0, 0), (0, 257), (0, usize::MAX)] {
        assert!(matches!(
            producer.history_bytes(after, limit),
            Err(ProducerError::InvalidInput(_))
        ));
    }
    let mut observation = event(json!({"unicode": "来源", "nested": [null, {"ready": true}]}));
    observation.axes.insert("step".into(), -2);
    producer.capture(observation).unwrap();
    let latest_bytes = producer.latest_bytes().unwrap();
    assert_eq!(
        latest_bytes,
        serde_json::to_vec(producer.latest().unwrap().as_ref()).unwrap()
    );
    assert_eq!(
        producer.history_bytes(0, 64).unwrap(),
        serde_json::to_vec(&producer.history(0, 64).unwrap()).unwrap()
    );
    producer.seal();
    assert_eq!(producer.latest_bytes().unwrap(), latest_bytes);
    assert_eq!(
        producer.history_bytes(1, 64).unwrap(),
        serde_json::to_vec(&producer.history(1, 64).unwrap()).unwrap()
    );
}

#[test]
fn raw_history_pages_report_eviction_and_preserve_cursors() {
    let producer = producer(BufferLimits {
        max_snapshots: 3,
        ..BufferLimits::default()
    });
    for index in 0..5 {
        producer.capture(event(json!({"index": index}))).unwrap();
    }
    for (after, limit) in [(0, 1), (2, 2), (3, 1), (4, 64), (5, 64)] {
        let bytes = producer.history_bytes(after, limit).unwrap();
        assert_eq!(
            bytes,
            serde_json::to_vec(&producer.history(after, limit).unwrap()).unwrap()
        );
        let page: SnapshotHistoryResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(page.source_session_id, "session-test");
        assert_eq!(page.oldest_sequence, 2);
        assert_eq!(page.dropped_before, (after < 2).then_some(2));
        assert_eq!(
            page.next_sequence,
            page.snapshots
                .last()
                .map_or(after.max(2), |snapshot| snapshot.sequence + 1)
        );
    }
}

#[test]
fn raw_history_selection_shares_snapshots_after_buffer_eviction() {
    let producer = producer(BufferLimits {
        max_snapshots: 1,
        ..BufferLimits::default()
    });
    producer
        .capture(event(json!({"nested": [{"value": "original"}]})))
        .unwrap();
    let retained = producer.latest().unwrap();
    let selected = producer.select_history(0, 64).unwrap();
    assert!(Arc::ptr_eq(&retained, &selected.snapshots[0]));
    producer
        .capture(event(json!({"replacement": true})))
        .unwrap();
    assert_eq!(
        selected.snapshots[0].state,
        json!({"nested": [{"value": "original"}]})
    );
    assert_eq!(producer.stats().oldest_sequence, 1);
}

#[test]
fn pagination_reports_expired_cursors_without_skipping() {
    let producer = producer(BufferLimits {
        max_snapshots: 3,
        ..BufferLimits::default()
    });
    for index in 0..5 {
        producer.capture(event(json!({"index":index}))).unwrap();
    }
    let first = producer.history(0, 1).unwrap();
    assert_eq!(first.oldest_sequence, 2);
    assert_eq!(first.dropped_before, Some(2));
    assert_eq!(first.next_sequence, 3);
    assert_eq!(first.snapshots[0].sequence, 2);
    let second = producer.history(first.next_sequence, 1).unwrap();
    assert_eq!(second.next_sequence, 4);
    assert_eq!(second.dropped_before, None);
    assert_eq!(producer.history(4, 1).unwrap().next_sequence, 5);
    assert!(producer.history(5, 64).unwrap().snapshots.is_empty());
    assert_eq!(producer.stats().dropped_snapshots, 2);
}

#[test]
fn invalid_batch_never_mutates_history() {
    let producer = producer(BufferLimits::default());
    producer.capture(event(json!({"initial":1}))).unwrap();
    let before = producer.stats();
    for state in [Value::Null, json!([]), json!(true), json!("not an object")] {
        assert!(producer
            .capture_batch(vec![event(json!({"new":1})), event(state)])
            .is_err());
        assert_eq!(producer.stats(), before);
    }
    assert!(producer.capture_batch(vec![]).is_err());
    assert!(producer
        .capture(event(json!({"large": "x".repeat(MAX_SNAPSHOT_BYTES)})))
        .is_err());
    let mut nested = json!({});
    for _ in 0..=MAX_DEPTH {
        nested = json!({"child":nested});
    }
    assert!(producer.capture(event(nested)).is_err());
    assert_eq!(producer.stats(), before);
}

#[test]
fn depth_boundary_and_logical_axes() {
    let producer = producer(BufferLimits::default());
    for leaf in [
        json!({}),
        json!([]),
        Value::Null,
        json!(true),
        json!(1),
        json!(0.25),
        json!("leaf"),
    ] {
        let mut nested = leaf;
        for _ in 0..MAX_DEPTH {
            nested = json!({"child":nested});
        }
        let mut observation = event(nested.clone());
        observation.axes.insert("step".into(), -4);
        producer.capture(observation).unwrap();
        assert_eq!(producer.latest().unwrap().axes["step"], -4);
        rvx_core::validate_state_snapshot(&producer.latest().unwrap()).unwrap();
        let before = producer.stats();
        assert!(producer.capture(event(json!({"child":nested}))).is_err());
        assert_eq!(producer.stats(), before);
    }
    let mut invalid = event(json!({}));
    invalid.axes.insert(" ".into(), 1);
    assert!(producer.capture(invalid).is_err());
}

#[test]
fn accounted_byte_limit_evicts_and_rejects_atomically() {
    let producer = producer(BufferLimits {
        max_snapshots: 100,
        max_bytes: 2_048,
    });
    for index in 0..5 {
        producer.capture(event(json!({"index":index}))).unwrap();
    }
    assert!(producer.stats().dropped_snapshots > 0);
    assert!(producer.stats().buffered_bytes <= 2_048);
    let before = producer.stats();
    assert!(producer
        .capture_batch(vec![
            event(json!({"valid":1})),
            event(json!({"large":"x".repeat(3_000)})),
        ])
        .is_err());
    assert_eq!(producer.stats(), before);
    let wide_number: Value =
        serde_json::from_str(&format!("{{\"fraction\":0.{}1}}", "0".repeat(3_000))).unwrap();
    assert!(producer.capture(event(wide_number)).is_err());
    assert_eq!(producer.stats(), before);
}

#[test]
fn pages_respect_byte_budget_and_cursor() {
    let producer = producer(BufferLimits::default());
    for _ in 0..6 {
        producer
            .capture(event(json!({"large":"x".repeat(3 * 1024 * 1024)})))
            .unwrap();
    }
    let first = producer.history(0, 64).unwrap();
    assert_eq!(first.snapshots.len(), 5);
    assert_eq!(first.next_sequence, 5);
    assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_PAGE_BYTES);
    let second = producer.history(first.next_sequence, 64).unwrap();
    assert_eq!(second.snapshots.len(), 1);
    assert_eq!(second.next_sequence, 6);
    let bytes = producer.history_bytes(0, 64).unwrap();
    assert!(bytes.len() <= MAX_PAGE_BYTES);
    assert_eq!(bytes, serde_json::to_vec(&first).unwrap());
    assert_eq!(
        producer.history_bytes(first.next_sequence, 64).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
}

#[test]
fn concurrent_capture_and_reads_share_one_cursor() {
    let producer = producer(BufferLimits::default());
    std::thread::scope(|scope| {
        for worker in 0..4 {
            let producer = producer.clone();
            scope.spawn(move || {
                for index in 0..50 {
                    producer
                        .capture(event(json!({"worker":worker, "index":index})))
                        .unwrap();
                    let page = producer.history(0, 64).unwrap();
                    assert!(page.next_sequence <= producer.stats().next_sequence);
                    let bytes = producer.history_bytes(0, 64).unwrap();
                    let page: SnapshotHistoryResponse = serde_json::from_slice(&bytes).unwrap();
                    assert!(page.next_sequence <= producer.stats().next_sequence);
                }
            });
        }
    });
    assert_eq!(producer.stats().next_sequence, 200);
    let history = producer.history(0, 256).unwrap();
    assert_eq!(
        history
            .snapshots
            .iter()
            .map(|snapshot| snapshot.sequence)
            .collect::<Vec<_>>(),
        (0..200).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn http_protocol_is_read_only_and_does_not_cache() {
    let producer = producer(BufferLimits::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let router = producer.clone().router();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::new();
    for (path, status) in [
        ("/v1/snapshots/latest", 503),
        ("/v1/snapshots/history?after=-1", 400),
        ("/v1/snapshots/history?after=1", 400),
        ("/v1/snapshots/history?limit=257", 400),
        ("/v1/snapshots/history?other=1", 400),
        ("/v1/metrics/points", 404),
    ] {
        let response = client
            .get(format!("{endpoint}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status);
        assert!(response.headers()["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store"));
    }
    assert_eq!(
        client
            .post(format!("{endpoint}/v1/snapshots/history"))
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        405
    );
    producer
        .capture(event(json!({"workers":[{"busy":true}], "phase":null})))
        .unwrap();
    producer.seal();
    let latest: StateSnapshot = client
        .get(format!("{endpoint}/v1/snapshots/latest"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(latest.sequence, 0);
    assert_eq!(latest.state["workers"][0]["busy"], true);
    for (path, bytes) in [
        (
            "/v1/snapshots/descriptor",
            producer.descriptor_bytes().unwrap(),
        ),
        ("/v1/snapshots/latest", producer.latest_bytes().unwrap()),
        (
            "/v1/snapshots/history",
            producer.history_bytes(0, 64).unwrap(),
        ),
    ] {
        let url = format!("{endpoint}{path}");
        let response = client.get(&url).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "application/json");
        assert_eq!(response.bytes().await.unwrap().as_ref(), bytes.as_slice());
        let response = client.head(&url).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "application/json");
        assert!(response.headers()["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store"));
        assert!(response.bytes().await.unwrap().is_empty());
        let response = client.post(&url).send().await.unwrap();
        assert_eq!(response.status(), 405);
        assert_eq!(response.headers()["allow"], "GET, HEAD");
    }
    server.abort();
    let _ = server.await;
}
