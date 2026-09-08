use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use rvx_core::{
    new_id, BrowserPreferences, SaveBrowserPreferences, SaveWorkspaces, Theme, UiState,
    WorkspaceDocument, MAX_UI_REQUEST_BYTES, MAX_UI_REVISION,
};
use serde::Serialize;

use super::Repository;
use crate::{valid_browser_id, EngineError, Result, UiSession};

const MAX_BROWSERS: usize = 10_000;
const BOOTSTRAP: &str = "missing, invalid, or unknown rvx_browser cookie; GET /api/ui/state to bootstrap before retrying";
type Stored = (String, Option<String>, Option<String>);

/// Create configuration-only tables alongside the existing metadata transaction owner.
pub(super) fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS ui_workspaces (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            document_json TEXT NOT NULL,
            mutation_id TEXT,
            mutation_json TEXT
        );
        INSERT OR IGNORE INTO ui_workspaces(singleton, document_json)
            VALUES (1, '{\"revision\":0,\"sets\":[]}');
        CREATE TABLE IF NOT EXISTS ui_browsers (
            browser_id TEXT PRIMARY KEY,
            document_json TEXT NOT NULL,
            mutation_id TEXT,
            mutation_json TEXT
        );",
    )?;
    Ok(())
}

impl Repository {
    /// Read appearance without registering a browser or loading shared workspace definitions.
    pub(crate) fn ui_theme(&self, requested: Option<&str>) -> Result<Theme> {
        let Some(id) = requested.filter(|id| valid_browser_id(id)) else {
            return Ok(BrowserPreferences::default().theme);
        };
        let connection = self.connection.lock();
        let document: Option<String> = connection
            .query_row(
                "SELECT document_json FROM ui_browsers WHERE browser_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        match document {
            Some(document) => Ok(serde_json::from_str::<BrowserPreferences>(&document)?.theme),
            None => Ok(BrowserPreferences::default().theme),
        }
    }

    /// Atomically read shared settings and register an opaque browser identity when needed.
    pub(crate) fn ui_state(&self, requested: Option<&str>) -> Result<UiSession> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let workspaces = workspace_row(&transaction)?.0;
        let existing = match requested.filter(|id| valid_browser_id(id)) {
            Some(id) => browser_row(&transaction, id)?.map(|row| (id.to_owned(), row.0)),
            None => None,
        };
        let initialized = existing.is_none();
        let (browser_id, browser) = match existing {
            Some((id, document)) => (id, serde_json::from_str(&document)?),
            None => {
                let count: usize =
                    transaction
                        .query_row("SELECT COUNT(*) FROM ui_browsers", [], |row| row.get(0))?;
                if count >= MAX_BROWSERS {
                    return Err(EngineError::InvalidInput(
                        "browser registry limit of 10000 reached; no preferences were evicted"
                            .into(),
                    ));
                }
                let id = new_id("browser");
                let browser = BrowserPreferences::default();
                transaction.execute(
                    "INSERT INTO ui_browsers(browser_id, document_json) VALUES (?1, ?2)",
                    params![id, serde_json::to_string(&browser)?],
                )?;
                (id, browser)
            }
        };
        let state = UiState {
            workspaces: serde_json::from_str(&workspaces)?,
            browser,
        };
        transaction.commit()?;
        Ok(UiSession {
            browser_id,
            initialized,
            state,
        })
    }

    /// Replace shared definitions with revision CAS and prune selections in the same commit.
    pub(crate) fn save_workspaces(
        &self,
        browser_id: &str,
        input: &SaveWorkspaces,
    ) -> Result<WorkspaceDocument> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        require_browser(&transaction, browser_id)?;
        input.validate().map_err(EngineError::InvalidInput)?;
        let payload = bounded_payload(input)?;
        let row = workspace_row(&transaction)?;
        let current: WorkspaceDocument = serde_json::from_str(&row.0)?;
        if retry(&row, &input.mutation_id, &payload, &current)? {
            transaction.commit()?;
            return Ok(current);
        }
        revision_matches(input.revision, current.revision, &current)?;
        validate_workspace_relations(&transaction, input)?;
        let changed = current.sets != input.sets;
        let document = WorkspaceDocument {
            revision: if changed {
                increment(current.revision)?
            } else {
                current.revision
            },
            sets: input.sets.clone(),
        };
        if changed {
            prune_selections(&transaction, &document)?;
        }
        transaction.execute(
            "UPDATE ui_workspaces SET document_json=?1, mutation_id=?2, mutation_json=?3 WHERE singleton=1",
            params![serde_json::to_string(&document)?, input.mutation_id, payload],
        )?;
        transaction.commit()?;
        Ok(document)
    }

    /// Durably update an existing browser's settings without changing shared layout revisions.
    pub(crate) fn save_browser_preferences(
        &self,
        browser_id: &str,
        input: &SaveBrowserPreferences,
    ) -> Result<BrowserPreferences> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let row = require_browser(&transaction, browser_id)?;
        input.validate().map_err(EngineError::InvalidInput)?;
        let payload = bounded_payload(input)?;
        let current: BrowserPreferences = serde_json::from_str(&row.0)?;
        if retry(&row, &input.mutation_id, &payload, &current)? {
            transaction.commit()?;
            return Ok(current);
        }
        revision_matches(input.revision, current.revision, &current)?;
        let workspaces: WorkspaceDocument = serde_json::from_str(&workspace_row(&transaction)?.0)?;
        let sets = set_experiments(&workspaces);
        if !input
            .selected
            .iter()
            .all(|(experiment, set)| sets.get(set.as_str()) == Some(&experiment.as_str()))
        {
            return Err(EngineError::InvalidInput(
                "selected must reference an existing workspace in the specified experiment".into(),
            ));
        }
        validate_run_colors(&transaction, input)?;
        let changed = current.theme != input.theme
            || current.sidebar_width != input.sidebar_width
            || current.selected != input.selected
            || current.run_colors != input.run_colors;
        let document = BrowserPreferences {
            revision: if changed {
                increment(current.revision)?
            } else {
                current.revision
            },
            theme: input.theme.clone(),
            sidebar_width: input.sidebar_width,
            selected: input.selected.clone(),
            run_colors: input.run_colors.clone(),
        };
        transaction.execute(
            "UPDATE ui_browsers SET document_json=?2, mutation_id=?3, mutation_json=?4 WHERE browser_id=?1",
            params![browser_id, serde_json::to_string(&document)?, input.mutation_id, payload],
        )?;
        transaction.commit()?;
        Ok(document)
    }
}

/// Resolve color overrides against the global Run registry in the same browser-write transaction.
fn validate_run_colors(connection: &Connection, input: &SaveBrowserPreferences) -> Result<()> {
    let mut statement = connection.prepare("SELECT EXISTS(SELECT 1 FROM runs WHERE id=?1)")?;
    for run_id in input.run_colors.keys() {
        let exists: bool = statement.query_row([run_id], |row| row.get(0))?;
        if !exists {
            return Err(EngineError::InvalidInput(
                "run_colors must reference registered Run IDs".into(),
            ));
        }
    }
    Ok(())
}

/// Read the singleton document together with its latest idempotent mutation record.
fn workspace_row(connection: &Connection) -> Result<Stored> {
    Ok(connection.query_row(
        "SELECT document_json, mutation_id, mutation_json FROM ui_workspaces WHERE singleton=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?)
}

/// Look up a browser document without creating caller-selected identities.
fn browser_row(connection: &Connection, id: &str) -> Result<Option<Stored>> {
    Ok(connection
        .query_row(
            "SELECT document_json, mutation_id, mutation_json FROM ui_browsers WHERE browser_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
}

/// Reject writes lacking an existing, server-created preference identity.
fn require_browser(connection: &Connection, id: &str) -> Result<Stored> {
    if !valid_browser_id(id) {
        return Err(EngineError::UiBootstrap(BOOTSTRAP.into()));
    }
    browser_row(connection, id)?.ok_or_else(|| EngineError::UiBootstrap(BOOTSTRAP.into()))
}

/// Bound non-HTTP callers too and retain the exact typed payload used for retry comparison.
fn bounded_payload(input: &impl Serialize) -> Result<String> {
    let payload = serde_json::to_string(input)?;
    if payload.len() > MAX_UI_REQUEST_BYTES {
        return Err(EngineError::InvalidInput("UI request exceeds 2 MiB".into()));
    }
    Ok(payload)
}

/// Include authoritative state in a conflict without discarding the caller's draft.
fn conflict(current: &impl Serialize, error: &str) -> Result<EngineError> {
    Ok(EngineError::UiConflict {
        error: error.into(),
        current: serde_json::to_value(current)?,
    })
}

/// Acknowledge only the latest identical mutation and reject conflicting identifier reuse.
fn retry<T: Serialize>(row: &Stored, id: &str, payload: &str, current: &T) -> Result<bool> {
    if row.1.as_deref() != Some(id) {
        return Ok(false);
    }
    if row.2.as_deref() != Some(payload) {
        return Err(conflict(
            current,
            "mutation_id was already used with a different payload",
        )?);
    }
    Ok(true)
}

/// Enforce exact compare-and-swap rather than silently overwriting concurrent edits.
fn revision_matches(requested: u64, revision: u64, current: &impl Serialize) -> Result<()> {
    if requested != revision {
        return Err(conflict(
            current,
            "stale revision; preserve your draft and reconcile with current",
        )?);
    }
    Ok(())
}

/// Advance revisions without exceeding the integer range browsers can represent exactly.
fn increment(revision: u64) -> Result<u64> {
    revision
        .checked_add(1)
        .filter(|next| *next <= MAX_UI_REVISION)
        .ok_or_else(|| EngineError::InvalidInput("UI revision limit reached".into()))
}

/// Resolve experiment and reporter references against the same transaction being committed.
fn validate_workspace_relations(connection: &Connection, input: &SaveWorkspaces) -> Result<()> {
    let experiments = connection
        .prepare("SELECT id FROM experiments")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<HashSet<_>, _>>()?;
    let mut checked_sources = HashSet::new();
    let mut source_exists =
        connection.prepare("SELECT EXISTS(SELECT 1 FROM sources WHERE id=?1)")?;
    for set in &input.sets {
        if !experiments.contains(&set.experiment_id) {
            return Err(EngineError::InvalidInput(
                "workspace references an unknown experiment".into(),
            ));
        }
        for id in set.panels.iter().flat_map(|panel| panel.source_ids()) {
            if !checked_sources.insert(id) {
                continue;
            }
            // A workspace's organizing experiment does not restrict cross-experiment Run overlays.
            if !source_exists.query_row([id], |row| row.get::<_, bool>(0))? {
                return Err(EngineError::InvalidInput(
                    "panel references an unknown Source ID".into(),
                ));
            }
        }
    }
    Ok(())
}

/// Index workspace ownership for selection validation and deletion pruning.
fn set_experiments(document: &WorkspaceDocument) -> HashMap<&str, &str> {
    document
        .sets
        .iter()
        .map(|set| (set.id.as_str(), set.experiment_id.as_str()))
        .collect()
}

/// Remove invalid selections atomically and invalidate retries based on pre-pruning revisions.
fn prune_selections(connection: &Connection, document: &WorkspaceDocument) -> Result<()> {
    let sets = set_experiments(document);
    let mut statement = connection.prepare("SELECT browser_id, document_json FROM ui_browsers")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (id, json) = row?;
        let mut browser: BrowserPreferences = serde_json::from_str(&json)?;
        let previous = browser.selected.len();
        browser
            .selected
            .retain(|experiment, set| sets.get(set.as_str()) == Some(&experiment.as_str()));
        if browser.selected.len() != previous {
            browser.revision = increment(browser.revision)?;
            // Pruning is a new authoritative mutation, so pre-prune retries must reconcile.
            connection.execute(
                "UPDATE ui_browsers SET document_json=?2, mutation_id=NULL, mutation_json=NULL WHERE browser_id=?1",
                params![id, serde_json::to_string(&browser)?],
            )?;
        }
    }
    Ok(())
}
