use crate::{diagnostics::WriteTiming, Engine};
use rvx_core::{SnapshotDescriptor, SourceRegistration, SourceState};
use std::collections::BTreeMap;

#[test]
fn unchanged_descriptors_do_not_write_but_success_time_and_identity_stay_current() {
    let directory = crate::test_directory().unwrap();
    let engine = Engine::open(directory.path()).unwrap();
    let (_, _, run) = engine.ensure_hierarchy("p", "e", "r", "{}").unwrap();
    let source = engine
        .register_source(&SourceRegistration {
            run_id: run.id.clone(),
            attempt_id: "a".into(),
            role: "worker".into(),
            endpoint: "http://127.0.0.1:1".into(),
            node_id: None,
            rank: None,
            scrape_interval_ms: 1000,
            timeout_ms: 500,
        })
        .unwrap();
    let mut descriptor = SnapshotDescriptor {
        protocol_version: 1,
        source_session_id: "session".into(),
        project: "p".into(),
        experiment: "e".into(),
        run_id: run.id,
        attempt_id: "a".into(),
        role: "worker".into(),
        rank: None,
        node_id: None,
        pid: None,
        labels: BTreeMap::new(),
        schema_version: 1,
    };
    let repository = &engine.repository;
    let mut timing = WriteTiming::default();
    repository
        .update_source_success_batch(&[(&source.id, &descriptor)], &mut timing)
        .unwrap();
    let initial = repository.source_by_id(&source.id).unwrap().source;
    repository
        .connection
        .lock()
        .execute_batch(
            "CREATE TRIGGER reject_unchanged_descriptor BEFORE UPDATE ON source_descriptors
         WHEN NEW.descriptor_json=OLD.descriptor_json
         BEGIN SELECT RAISE(ABORT, 'unchanged descriptor was rewritten'); END;",
        )
        .unwrap();
    repository
        .update_source_success_batch(&[(&source.id, &descriptor)], &mut timing)
        .unwrap();
    let refreshed = repository.source_by_id(&source.id).unwrap().source;
    assert_eq!(refreshed.state, SourceState::Active);
    assert!(refreshed.last_success_at_ns > initial.last_success_at_ns);
    descriptor.source_session_id = "new-session".into();
    descriptor.labels.insert("name".into(), "changed".into());
    repository
        .update_source_success_batch(&[(&source.id, &descriptor)], &mut timing)
        .unwrap();
    let changed = repository.source_by_id(&source.id).unwrap().source;
    assert_eq!(changed.source_session_id.as_deref(), Some("new-session"));
    assert_eq!(changed.descriptor.unwrap()["labels"]["name"], "changed");
}
