use rvx_core::{
    BrowserPreferences, SaveBrowserPreferences, SaveWorkspaces, Theme, UiState, WorkspaceDocument,
};

use crate::{Engine, Result};

/// A coherent bootstrap snapshot and the opaque preference identity to put in an HttpOnly cookie.
pub struct UiSession {
    pub browser_id: String,
    pub initialized: bool,
    pub state: UiState,
}

/// Recognize only server-generated UUID cookie values, never credentials or caller-selected keys.
pub fn valid_browser_id(value: &str) -> bool {
    value.strip_prefix("browser_").is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

impl Engine {
    /// Resolve the persisted browser theme for the first HTML paint, without changing preference state.
    pub fn ui_theme(&self, browser_id: Option<&str>) -> Result<Theme> {
        self.repository.ui_theme(browser_id)
    }

    /// Read shared and browser state under one metadata transaction, registering a new browser if needed.
    pub fn ui_state(&self, browser_id: Option<&str>) -> Result<UiSession> {
        self.repository.ui_state(browser_id)
    }

    /// Atomically replace shared definitions using exact revision CAS; prune deleted browser selections.
    /// Only the latest identical mutation can be retried; no acknowledgement precedes the durable commit.
    pub fn save_workspaces(
        &self,
        browser_id: &str,
        input: &SaveWorkspaces,
    ) -> Result<WorkspaceDocument> {
        self.repository.save_workspaces(browser_id, input)
    }

    /// Replace only an existing cookie browser's settings using its independent revision and mutation ID.
    /// Missing/unknown identities require GET bootstrap; invalid or stale writes never change stored state.
    pub fn save_browser_preferences(
        &self,
        browser_id: &str,
        input: &SaveBrowserPreferences,
    ) -> Result<BrowserPreferences> {
        self.repository.save_browser_preferences(browser_id, input)
    }
}
