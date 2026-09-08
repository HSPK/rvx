use crate::{Engine, Result};

pub const AUTH_SESSION_SECONDS: i64 = 7 * 24 * 60 * 60;
pub const MAX_AUTH_SESSIONS: usize = 10_000;

impl Engine {
    /// Establish a keyed session generation, atomically revoking old sessions after password rotation.
    pub fn configure_auth_sessions(&self, key_digest: &[u8; 32]) -> Result<()> {
        self.repository.configure_auth_sessions(key_digest)
    }

    /// Commit a seven-day session digest, optionally replacing this browser's previous session.
    /// Expired rows are pruned; unexpired sessions are never evicted to make room.
    pub fn create_auth_session(
        &self,
        key_digest: &[u8; 32],
        digest: &[u8; 32],
        previous: Option<&[u8; 32]>,
    ) -> Result<()> {
        self.repository
            .create_auth_session(key_digest, digest, previous)
    }

    /// Check current-key membership, expiry, and revocation without extending a session's lifetime.
    pub fn auth_session_active(&self, key_digest: &[u8; 32], digest: &[u8; 32]) -> Result<bool> {
        self.repository.auth_session_active(key_digest, digest)
    }

    /// Durably revoke an opaque session digest; absent or already-expired sessions are harmless.
    pub fn revoke_auth_session(&self, digest: &[u8; 32]) -> Result<()> {
        self.repository.revoke_auth_session(digest)
    }
}
