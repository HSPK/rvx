use std::collections::BTreeMap;
use std::io::Write;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use axum::{routing::get, Json, Router};
use rvx_core::{
    MetricBatch, MetricPoint, QueryRequest, SnapshotHistoryRequest, SourceRegistration,
};
use rvx_engine::Engine;
use serde_json::json;

#[tokio::test]
async fn legacy_wal_is_read_only_and_snapshot_cursors_start_in_a_separate_namespace() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
    std::fs::create_dir_all(&root).unwrap();
    let directory = tempfile::tempdir_in(root).unwrap();
    let engine = Engine::open(directory.path(), 1).unwrap();
    let project = engine.create_project("p").unwrap();
    let experiment = engine.create_experiment(&project.id, "e").unwrap();
    let run = engine.create_run(&experiment.id, "r", "{}").unwrap();
    let run_id = run.id.clone();
    let old_requests = Arc::new(AtomicUsize::new(0));
    let seen = old_requests.clone();
    let application=Router::new()
        .route("/v1/snapshots/descriptor",get(move || {
            let run_id=run_id.clone();
            async move { Json(json!({
                "protocol_version":1,"schema_version":1,"source_session_id":"shared-session",
                "project":"p","experiment":"e","run_id":run_id,"attempt_id":"a","role":"learner"
            })) }
        }))
        .route("/v1/snapshots/history",get(|| async { Json(json!({
            "protocol_version":1,"source_session_id":"shared-session","oldest_sequence":0,"next_sequence":1,"dropped_before":null,
            "snapshots":[{"source_session_id":"shared-session","sequence":0,"observed_at_ns":100,
                "state":{"full":{"workers":[{"ready":true}]}}}]
        })) }))
        .route("/v1/metrics/descriptor",get(move || { let seen=seen.clone(); async move {
            seen.fetch_add(1,Ordering::Relaxed); Json(json!({}))
        }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, application).await.unwrap();
    });
    let source = engine
        .register_source(&SourceRegistration {
            run_id: run.id.clone(),
            attempt_id: "a".into(),
            role: "learner".into(),
            endpoint: format!("http://{address}"),
            rank: None,
            node_id: None,
            scrape_interval_ms: 1000,
            timeout_ms: 500,
        })
        .unwrap();
    assert!(!directory.path().join("metrics.wal").exists());
    drop(engine);
    // Construct an existing archive fixture; no production ingestion interface is exposed.
    let legacy = MetricBatch {
        run_id: run.id.clone(),
        source_id: source.id.clone(),
        source_session_id: "shared-session".into(),
        oldest_sequence: 50,
        next_sequence: 52,
        dropped_before: None,
        points: (50..52)
            .map(|sequence| MetricPoint {
                source_session_id: "shared-session".into(),
                sequence,
                event_time_ns: sequence as i64,
                ingest_time_ns: 0,
                axes: BTreeMap::new(),
                values: BTreeMap::from([("loss".into(), sequence as f64)]),
            })
            .collect(),
    };
    let bytes = serde_json::to_vec(&legacy).unwrap();
    let path = directory.path().join("metrics.wal");
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(&(bytes.len() as u32).to_le_bytes()).unwrap();
    file.write_all(&crc32fast::hash(&bytes).to_le_bytes())
        .unwrap();
    file.write_all(&bytes).unwrap();
    file.write_all(b"partial").unwrap();
    file.sync_all().unwrap();
    drop(file);
    let original = std::fs::read(&path).unwrap();
    let connection = rusqlite::Connection::open(directory.path().join("metadata.db")).unwrap();
    connection.execute("INSERT INTO cursors(source_id,source_session_id,next_sequence,updated_at_ns) VALUES (?1,'shared-session',52,0)",[&source.id]).unwrap();
    drop(connection);
    let engine = Engine::open(directory.path(), 1).unwrap();
    let request = QueryRequest {
        run_id: run.id.clone(),
        source_ids: vec![],
        metrics: vec!["loss".into()],
        axis: "wall_time".into(),
        from: None,
        to: None,
        max_points: 100,
    };
    assert_eq!(
        engine.query(&request).unwrap().series[0].values,
        vec![50.0, 51.0]
    );
    assert_eq!(engine.scrape_source(&source).await.unwrap(), 1);
    assert_eq!(engine.stats().unwrap().snapshots, 1);
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert_eq!(old_requests.load(Ordering::Relaxed), 0);
    let history = engine
        .snapshot_history(&SnapshotHistoryRequest {
            run_id: run.id.clone(),
            source_ids: vec![],
            before_id: None,
            from: None,
            to: None,
            limit: 100,
        })
        .unwrap();
    assert_eq!(history.snapshots.len(), 1);
    assert_eq!(history.snapshots[0].snapshot.sequence, 0);
    assert_eq!(history.snapshots[0].source_id, source.id);
    let connection = rusqlite::Connection::open(directory.path().join("metadata.db")).unwrap();
    let cursor: i64 = connection
        .query_row(
            "SELECT next_sequence FROM cursors WHERE source_id=?1",
            [&source.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cursor, 52);
    drop(engine);
    let reopened = Engine::open(directory.path(), 1).unwrap();
    assert_eq!(
        reopened.query(&request).unwrap().series[0].values,
        vec![50.0, 51.0]
    );
    assert_eq!(reopened.stats().unwrap().snapshots, 1);
    assert_eq!(std::fs::read(&path).unwrap(), original);
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn mismatched_http_sessions_fail_atomically_and_no_metric_fallback_is_attempted() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
    std::fs::create_dir_all(&root).unwrap();
    let directory = tempfile::tempdir_in(root).unwrap();
    let engine = Engine::open(directory.path(), 1).unwrap();
    let project = engine.create_project("p").unwrap();
    let experiment = engine.create_experiment(&project.id, "e").unwrap();
    let run = engine.create_run(&experiment.id, "r", "{}").unwrap();
    let run_id = run.id.clone();
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = requests.clone();
    let application=Router::new().fallback(get(move |axum::extract::OriginalUri(uri):axum::extract::OriginalUri| {
        let seen=seen.clone(); let run_id=run_id.clone();
        async move {
            seen.lock().unwrap().push(uri.path().to_string());
            Json(if uri.path().ends_with("descriptor") { json!({
                "protocol_version":1,"source_session_id":"before-restart","project":"p","experiment":"e",
                "run_id":run_id,"attempt_id":"a","role":"learner"
            }) } else { json!({
                "protocol_version":1,"source_session_id":"after-restart","oldest_sequence":0,"next_sequence":1,
                "snapshots":[{"source_session_id":"after-restart","sequence":0,"observed_at_ns":1,"state":{}}]
            }) })
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, application).await.unwrap();
    });
    let source = engine
        .register_source(&SourceRegistration {
            run_id: run.id,
            attempt_id: "a".into(),
            role: "learner".into(),
            endpoint: format!("http://{address}"),
            rank: None,
            node_id: None,
            scrape_interval_ms: 1000,
            timeout_ms: 500,
        })
        .unwrap();
    assert!(engine.scrape_source(&source).await.is_err());
    assert_eq!(engine.stats().unwrap().snapshots, 0);
    assert_eq!(
        *requests.lock().unwrap(),
        vec!["/v1/snapshots/descriptor", "/v1/snapshots/history"]
    );
    assert!(!directory.path().join("metrics.wal").exists());
    server.abort();
    let _ = server.await;
}
