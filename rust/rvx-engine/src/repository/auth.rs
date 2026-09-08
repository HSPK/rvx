use rusqlite::{params, Connection, OptionalExtension};

use super::Repository;
use crate::{EngineError, Result, AUTH_SESSION_SECONDS, MAX_AUTH_SESSIONS};

pub(super) fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS auth_session_key (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            key_digest BLOB NOT NULL CHECK(length(key_digest)=32)
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
            digest BLOB PRIMARY KEY NOT NULL CHECK(length(digest)=32),
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);",
    )?;
    Ok(())
}

impl Repository {
    pub(crate) fn configure_auth_sessions(&self, key: &[u8; 32]) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let current: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT key_digest FROM auth_session_key WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if current.as_deref() != Some(key.as_slice()) {
            transaction.execute("DELETE FROM auth_sessions", [])?;
            transaction.execute(
                "INSERT INTO auth_session_key(singleton,key_digest) VALUES(1,?1)
                 ON CONFLICT(singleton) DO UPDATE SET key_digest=excluded.key_digest",
                [key.as_slice()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn create_auth_session(
        &self,
        key: &[u8; 32],
        digest: &[u8; 32],
        previous: Option<&[u8; 32]>,
    ) -> Result<()> {
        let now = rvx_core::now_ns() / 1_000_000_000;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let current: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM auth_session_key WHERE singleton=1 AND key_digest=?1)",
            [key.as_slice()],
            |row| row.get(0),
        )?;
        if !current {
            return Err(EngineError::AuthSessionUnavailable);
        }
        transaction.execute("DELETE FROM auth_sessions WHERE expires_at<=?1", [now])?;
        if let Some(previous) = previous {
            transaction.execute(
                "DELETE FROM auth_sessions WHERE digest=?1",
                [previous.as_slice()],
            )?;
        }
        let count: usize =
            transaction.query_row("SELECT COUNT(*) FROM auth_sessions", [], |row| row.get(0))?;
        if count >= MAX_AUTH_SESSIONS {
            return Err(EngineError::AuthSessionUnavailable);
        }
        transaction.execute(
            "INSERT INTO auth_sessions(digest,expires_at) VALUES(?1,?2)",
            params![digest.as_slice(), now + AUTH_SESSION_SECONDS],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn auth_session_active(&self, key: &[u8; 32], digest: &[u8; 32]) -> Result<bool> {
        Ok(self.connection.lock().query_row(
            "SELECT EXISTS(SELECT 1 FROM auth_sessions,auth_session_key
             WHERE digest=?1 AND expires_at>?2 AND singleton=1 AND key_digest=?3)",
            params![
                digest.as_slice(),
                rvx_core::now_ns() / 1_000_000_000,
                key.as_slice()
            ],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn revoke_auth_session(&self, digest: &[u8; 32]) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM auth_sessions WHERE digest=?1",
            [digest.as_slice()],
        )?;
        transaction.commit()?;
        Ok(())
    }
}
