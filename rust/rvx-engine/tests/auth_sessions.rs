use rvx_engine::{Engine, EngineError, AUTH_SESSION_SECONDS, MAX_AUTH_SESSIONS};

fn directory() -> tempfile::TempDir {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

#[test]
fn sessions_survive_restart_expire_revoke_and_never_reappear_after_key_rotation() {
    let directory = directory();
    let engine = Engine::open(directory.path()).unwrap();
    let key = [1; 32];
    let digest = [2; 32];
    assert!(engine.create_auth_session(&key, &digest, None).is_err());
    engine.configure_auth_sessions(&key).unwrap();
    engine.create_auth_session(&key, &digest, None).unwrap();
    assert!(engine.auth_session_active(&key, &digest).unwrap());
    assert!(!engine.auth_session_active(&[9; 32], &digest).unwrap());
    drop(engine);
    let engine = Engine::open(directory.path()).unwrap();
    engine.configure_auth_sessions(&key).unwrap();
    assert!(engine.auth_session_active(&key, &digest).unwrap());
    let connection = rusqlite::Connection::open(directory.path().join("metadata.db")).unwrap();
    let expiration: i64 = connection
        .query_row("SELECT expires_at FROM auth_sessions", [], |row| row.get(0))
        .unwrap();
    assert!((AUTH_SESSION_SECONDS - 5..=AUTH_SESSION_SECONDS)
        .contains(&(expiration - rvx_core::now_ns() / 1_000_000_000)));
    connection
        .execute("UPDATE auth_sessions SET expires_at=0", [])
        .unwrap();
    assert!(!engine.auth_session_active(&key, &digest).unwrap());
    engine.create_auth_session(&key, &[3; 32], None).unwrap();
    let count: usize = connection
        .query_row("SELECT COUNT(*) FROM auth_sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
    engine.revoke_auth_session(&[3; 32]).unwrap();
    engine.revoke_auth_session(&[3; 32]).unwrap();
    assert!(!engine.auth_session_active(&key, &[3; 32]).unwrap());
    engine.create_auth_session(&key, &digest, None).unwrap();
    engine.configure_auth_sessions(&[4; 32]).unwrap();
    assert!(!engine.auth_session_active(&key, &digest).unwrap());
    assert!(!engine.auth_session_active(&[4; 32], &digest).unwrap());
    engine.configure_auth_sessions(&key).unwrap();
    assert!(!engine.auth_session_active(&key, &digest).unwrap());
}

#[test]
fn session_capacity_and_failed_replacement_never_evict_valid_sessions() {
    let directory = directory();
    let engine = Engine::open(directory.path()).unwrap();
    let key = [1; 32];
    engine.configure_auth_sessions(&key).unwrap();
    let mut connection = rusqlite::Connection::open(directory.path().join("metadata.db")).unwrap();
    let expires = rvx_core::now_ns() / 1_000_000_000 + AUTH_SESSION_SECONDS;
    let transaction = connection.transaction().unwrap();
    for index in 0..MAX_AUTH_SESSIONS {
        let mut digest = [0; 32];
        digest[..8].copy_from_slice(&(index as u64).to_be_bytes());
        transaction
            .execute(
                "INSERT INTO auth_sessions(digest,expires_at) VALUES(?1,?2)",
                rusqlite::params![digest.as_slice(), expires],
            )
            .unwrap();
    }
    transaction.commit().unwrap();
    assert!(matches!(
        engine.create_auth_session(&key, &[9; 32], None),
        Err(EngineError::AuthSessionUnavailable)
    ));
    assert!(engine.auth_session_active(&key, &[0; 32]).unwrap());
    connection
        .execute_batch(
            "CREATE TRIGGER reject_session BEFORE INSERT ON auth_sessions
         BEGIN SELECT RAISE(ABORT, 'fixture insertion failure'); END;",
        )
        .unwrap();
    assert!(matches!(
        engine.create_auth_session(&key, &[9; 32], Some(&[0; 32])),
        Err(EngineError::Sqlite(_))
    ));
    assert!(engine.auth_session_active(&key, &[0; 32]).unwrap());
    assert!(!engine.auth_session_active(&key, &[9; 32]).unwrap());
    connection
        .execute_batch("DROP TRIGGER reject_session;")
        .unwrap();
    engine
        .create_auth_session(&key, &[9; 32], Some(&[0; 32]))
        .unwrap();
    assert!(!engine.auth_session_active(&key, &[0; 32]).unwrap());
    assert!(engine.auth_session_active(&key, &[9; 32]).unwrap());
    let count: usize = connection
        .query_row("SELECT COUNT(*) FROM auth_sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, MAX_AUTH_SESSIONS);
}
