use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use rvx_core::{new_id, now_ns, Experiment, Project, Run, RunStatus, Source, SourceState};

use crate::{EngineError, Result};

mod ui;
mod auth;

pub struct Repository {
    connection: Mutex<Connection>,
}

impl Repository {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                created_at_ns INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS experiments (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id),
                name TEXT NOT NULL,
                created_at_ns INTEGER NOT NULL,
                UNIQUE(project_id, name)
            );
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                experiment_id TEXT NOT NULL REFERENCES experiments(id),
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                config_json TEXT NOT NULL,
                created_at_ns INTEGER NOT NULL,
                updated_at_ns INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sources (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id),
                attempt_id TEXT NOT NULL,
                role TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                node_id TEXT,
                rank INTEGER,
                state TEXT NOT NULL,
                source_session_id TEXT,
                last_success_at_ns INTEGER,
                last_error TEXT,
                scrape_interval_ms INTEGER NOT NULL,
                timeout_ms INTEGER NOT NULL,
                UNIQUE(run_id, endpoint)
            );
            CREATE TABLE IF NOT EXISTS source_descriptors (
                source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
                descriptor_json TEXT NOT NULL,
                updated_at_ns INTEGER NOT NULL
            );
            ",
        )?;
        ui::initialize(&connection)?;
        auth::initialize(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn create_project(&self, name: &str) -> Result<Project> {
        rvx_core::validate_name("project name", name)?;
        let project = Project {
            id: new_id("project"),
            name: name.trim().to_string(),
            created_at_ns: now_ns(),
        };
        self.connection.lock().execute(
            "INSERT INTO projects(id, name, created_at_ns) VALUES (?1, ?2, ?3)",
            params![project.id, project.name, project.created_at_ns],
        )?;
        Ok(project)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT id, name, created_at_ns FROM projects ORDER BY created_at_ns")?;
        let projects = statement
            .query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at_ns: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(projects)
    }

    pub fn create_experiment(&self, project_id: &str, name: &str) -> Result<Experiment> {
        rvx_core::validate_name("experiment name", name)?;
        let experiment = Experiment {
            id: new_id("experiment"),
            project_id: project_id.to_string(),
            name: name.trim().to_string(),
            created_at_ns: now_ns(),
        };
        self.connection.lock().execute(
            "INSERT INTO experiments(id, project_id, name, created_at_ns)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                experiment.id,
                experiment.project_id,
                experiment.name,
                experiment.created_at_ns
            ],
        )?;
        Ok(experiment)
    }

    pub fn list_experiments(&self, project_id: Option<&str>) -> Result<Vec<Experiment>> {
        let connection = self.connection.lock();
        let sql = if project_id.is_some() {
            "SELECT id, project_id, name, created_at_ns
             FROM experiments WHERE project_id = ?1 ORDER BY created_at_ns"
        } else {
            "SELECT id, project_id, name, created_at_ns
             FROM experiments ORDER BY created_at_ns"
        };
        let mut statement = connection.prepare(sql)?;
        let map = |row: &rusqlite::Row<'_>| {
            Ok(Experiment {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                created_at_ns: row.get(3)?,
            })
        };
        let rows = match project_id {
            Some(id) => statement.query_map([id], map)?,
            None => statement.query_map([], map)?,
        };
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn create_run(&self, experiment_id: &str, name: &str, config_json: &str) -> Result<Run> {
        rvx_core::validate_name("run name", name)?;
        serde_json::from_str::<serde_json::Value>(config_json)
            .map_err(|error| EngineError::InvalidInput(error.to_string()))?;
        let now = now_ns();
        let run = Run {
            id: new_id("run"),
            experiment_id: experiment_id.to_string(),
            name: name.trim().to_string(),
            status: RunStatus::Created,
            config_json: config_json.to_string(),
            created_at_ns: now,
            updated_at_ns: now,
        };
        self.connection.lock().execute(
            "INSERT INTO runs(
                id, experiment_id, name, status, config_json,
                created_at_ns, updated_at_ns
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                run.id,
                run.experiment_id,
                run.name,
                status_text(&run.status),
                run.config_json,
                run.created_at_ns,
                run.updated_at_ns
            ],
        )?;
        Ok(run)
    }

    pub fn list_runs(&self, experiment_id: Option<&str>) -> Result<Vec<Run>> {
        let connection = self.connection.lock();
        let sql = if experiment_id.is_some() {
            "SELECT id, experiment_id, name, status, config_json,
                    created_at_ns, updated_at_ns
             FROM runs WHERE experiment_id = ?1 ORDER BY created_at_ns DESC"
        } else {
            "SELECT id, experiment_id, name, status, config_json,
                    created_at_ns, updated_at_ns
             FROM runs ORDER BY created_at_ns DESC"
        };
        let mut statement = connection.prepare(sql)?;
        let rows = match experiment_id {
            Some(id) => statement.query_map([id], run_from_row)?,
            None => statement.query_map([], run_from_row)?,
        };
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn update_run_status(&self, run_id: &str, target: &RunStatus) -> Result<Run> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let current = transaction
            .query_row("SELECT status FROM runs WHERE id=?1", [run_id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .ok_or_else(|| EngineError::InvalidInput(format!("unknown run: {run_id}")))?;
        let current = parse_run_status(&current);
        if !valid_run_transition(&current, target) {
            return Err(EngineError::InvalidInput(format!(
                "invalid run status transition: {} -> {}",
                status_text(&current),
                status_text(target)
            )));
        }
        if current != *target {
            transaction.execute(
                "UPDATE runs SET status=?2, updated_at_ns=?3 WHERE id=?1",
                params![run_id, status_text(target), now_ns()],
            )?;
            let terminal_source_state = match target {
                RunStatus::Finished | RunStatus::Cancelled => Some("ended"),
                RunStatus::Failed => Some("lost"),
                RunStatus::Created | RunStatus::Running => None,
            };
            if let Some(source_state) = terminal_source_state {
                transaction.execute(
                    "UPDATE sources SET state=?2
                     WHERE run_id=?1 AND state NOT IN ('ended', 'lost')",
                    params![run_id, source_state],
                )?;
            }
        }
        let run = transaction.query_row(
            "SELECT id, experiment_id, name, status, config_json,
                    created_at_ns, updated_at_ns
             FROM runs WHERE id=?1",
            [run_id],
            run_from_row,
        )?;
        transaction.commit()?;
        Ok(run)
    }

    pub fn register_source(&self, source: &Source) -> Result<Source> {
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO sources(
                id, run_id, attempt_id, role, endpoint, node_id, rank, state,
                source_session_id, last_success_at_ns, last_error,
                scrape_interval_ms, timeout_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(run_id, endpoint) DO UPDATE SET
                attempt_id=excluded.attempt_id,
                role=excluded.role,
                node_id=excluded.node_id,
                rank=excluded.rank,
                scrape_interval_ms=excluded.scrape_interval_ms,
                timeout_ms=excluded.timeout_ms",
            params![
                source.id,
                source.run_id,
                source.attempt_id,
                source.role,
                source.endpoint,
                source.node_id,
                source.rank,
                source_state_text(&source.state),
                source.source_session_id,
                source.last_success_at_ns,
                source.last_error,
                source.scrape_interval_ms as i64,
                source.timeout_ms as i64
            ],
        )?;
        self.source_by_run_endpoint(&connection, &source.run_id, &source.endpoint)?
            .ok_or_else(|| EngineError::InvalidInput("source registration failed".into()))
    }

    /// Validate table ownership and bound metadata before any snapshot read.
    pub(crate) fn table_sources(&self, runs: &[String], ids: &[String]) -> Result<Vec<Source>> {
        let connection = self.connection.lock();
        for run in runs {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM runs WHERE id=?)",
                [run],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(EngineError::InvalidInput(format!("unknown Run {run:?}")));
            }
        }
        let mut values = runs.to_vec();
        let mut filter = format!("run_id IN ({})", vec!["?"; runs.len()].join(","));
        if !ids.is_empty() {
            filter.push_str(&format!(" AND id IN ({})", vec!["?"; ids.len()].join(",")));
            values.extend_from_slice(ids);
        }
        let mut statement = connection.prepare(&format!(
            "SELECT id,run_id,attempt_id,role,endpoint,node_id,rank,state,
                    source_session_id,last_success_at_ns,last_error,scrape_interval_ms,timeout_ms,
                    (SELECT descriptor_json FROM source_descriptors WHERE source_id=sources.id)
             FROM sources WHERE {filter} ORDER BY run_id,id LIMIT 257"
        ))?;
        let sources = statement
            .query_map(rusqlite::params_from_iter(values), source_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if sources.len() > rvx_core::MAX_SNAPSHOT_SOURCE_IDS {
            return Err(EngineError::InvalidInput(
                "table selection exceeds 256 Sources; narrow run_ids/source_ids".into(),
            ));
        }
        if ids.iter().any(|id| !sources.iter().any(|s| &s.id == id)) {
            return Err(EngineError::InvalidInput(
                "unknown source_ids or Source does not belong to selected run_ids".into(),
            ));
        }
        Ok(sources)
    }

    pub fn list_sources(&self, run_id: Option<&str>) -> Result<Vec<Source>> {
        let connection = self.connection.lock();
        let sql = if run_id.is_some() {
            "SELECT id, run_id, attempt_id, role, endpoint, node_id, rank, state,
                    source_session_id, last_success_at_ns, last_error,
                    scrape_interval_ms, timeout_ms,
                    (SELECT descriptor_json FROM source_descriptors
                     WHERE source_id=sources.id)
             FROM sources WHERE run_id = ?1 ORDER BY role, rank, endpoint"
        } else {
            "SELECT id, run_id, attempt_id, role, endpoint, node_id, rank, state,
                    source_session_id, last_success_at_ns, last_error,
                    scrape_interval_ms, timeout_ms,
                    (SELECT descriptor_json FROM source_descriptors
                     WHERE source_id=sources.id)
             FROM sources ORDER BY run_id, role, rank, endpoint"
        };
        let mut statement = connection.prepare(sql)?;
        let rows = match run_id {
            Some(id) => statement.query_map([id], source_from_row)?,
            None => statement.query_map([], source_from_row)?,
        };
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn source_by_id(&self, source_id: &str) -> Result<Source> {
        self.connection
            .lock()
            .query_row(
                "SELECT id, run_id, attempt_id, role, endpoint, node_id, rank, state,
                    source_session_id, last_success_at_ns, last_error,
                    scrape_interval_ms, timeout_ms,
                    (SELECT descriptor_json FROM source_descriptors
                     WHERE source_id=sources.id)
             FROM sources WHERE id=?1",
                [source_id],
                source_from_row,
            )
            .optional()?
            .ok_or_else(|| EngineError::InvalidInput(format!("unknown source: {source_id}")))
    }

    pub fn update_source_state(&self, source_id: &str, target: &SourceState) -> Result<Source> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let current = transaction
            .query_row(
                "SELECT state FROM sources WHERE id=?1",
                [source_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| EngineError::InvalidInput(format!("unknown source: {source_id}")))?;
        let current = parse_source_state(&current);
        if !valid_source_transition(&current, target) {
            return Err(EngineError::InvalidInput(format!(
                "invalid source state transition: {} -> {}",
                source_state_text(&current),
                source_state_text(target)
            )));
        }
        if current != *target {
            transaction.execute(
                "UPDATE sources SET state=?2 WHERE id=?1",
                params![source_id, source_state_text(target)],
            )?;
        }
        let source = transaction.query_row(
            "SELECT id, run_id, attempt_id, role, endpoint, node_id, rank, state,
                    source_session_id, last_success_at_ns, last_error,
                    scrape_interval_ms, timeout_ms,
                    (SELECT descriptor_json FROM source_descriptors
                     WHERE source_id=sources.id)
             FROM sources WHERE id=?1",
            [source_id],
            source_from_row,
        )?;
        transaction.commit()?;
        Ok(source)
    }

    pub fn update_source_success(
        &self,
        source_id: &str,
        descriptor: &rvx_core::SnapshotDescriptor,
        timestamp_ns: i64,
    ) -> Result<()> {
        let encoded = serde_json::to_string(descriptor)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE sources SET state='active', source_session_id=?2,
             last_success_at_ns=?3, last_error=NULL
             WHERE id=?1 AND EXISTS (
                 SELECT 1 FROM runs
                 WHERE runs.id=sources.run_id
                   AND runs.status IN ('created', 'running')
             ) AND state NOT IN ('draining', 'ended', 'lost')",
            params![source_id, descriptor.source_session_id, timestamp_ns],
        )?;
        transaction.execute(
            "INSERT INTO source_descriptors(source_id, descriptor_json, updated_at_ns)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(source_id) DO UPDATE SET
                descriptor_json=excluded.descriptor_json,
                updated_at_ns=excluded.updated_at_ns",
            params![source_id, encoded, timestamp_ns],
        )?;
        transaction.execute(
            "UPDATE runs SET status='running', updated_at_ns=?2
             WHERE status='created'
               AND id=(SELECT run_id FROM sources WHERE id=?1)",
            params![source_id, timestamp_ns],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn update_source_failure(&self, source_id: &str, error: &str) -> Result<()> {
        self.connection.lock().execute(
            "UPDATE sources SET state='stale', last_error=?2
             WHERE id=?1 AND EXISTS (
                 SELECT 1 FROM runs
                 WHERE runs.id=sources.run_id
                   AND runs.status IN ('created', 'running')
             ) AND state NOT IN ('draining', 'ended', 'lost')",
            params![source_id, error],
        )?;
        Ok(())
    }

    pub fn counts(&self) -> Result<(u64, u64, u64, u64, u64)> {
        let connection = self.connection.lock();
        let count = |table: &str| -> Result<u64> {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            Ok(connection.query_row(&sql, [], |row| row.get::<_, i64>(0))? as u64)
        };
        let active = connection.query_row(
            "SELECT COUNT(*) FROM sources WHERE state='active'",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64;
        Ok((
            count("projects")?,
            count("experiments")?,
            count("runs")?,
            count("sources")?,
            active,
        ))
    }

    fn source_by_run_endpoint(
        &self,
        connection: &Connection,
        run_id: &str,
        endpoint: &str,
    ) -> Result<Option<Source>> {
        Ok(connection
            .query_row(
                "SELECT id, run_id, attempt_id, role, endpoint, node_id, rank, state,
                        source_session_id, last_success_at_ns, last_error,
                        scrape_interval_ms, timeout_ms,
                        (SELECT descriptor_json FROM source_descriptors
                         WHERE source_id=sources.id)
                 FROM sources WHERE run_id=?1 AND endpoint=?2",
                params![run_id, endpoint],
                source_from_row,
            )
            .optional()?)
    }
}

fn source_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Source> {
    let state: String = row.get(7)?;
    Ok(Source {
        id: row.get(0)?,
        run_id: row.get(1)?,
        attempt_id: row.get(2)?,
        role: row.get(3)?,
        endpoint: row.get(4)?,
        node_id: row.get(5)?,
        rank: row.get(6)?,
        state: parse_source_state(&state),
        source_session_id: row.get(8)?,
        last_success_at_ns: row.get(9)?,
        last_error: row.get(10)?,
        scrape_interval_ms: row.get::<_, i64>(11)? as u64,
        timeout_ms: row.get::<_, i64>(12)? as u64,
        descriptor: row
            .get::<_, Option<String>>(13)?
            .map(|value| {
                serde_json::from_str(&value).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        13,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .transpose()?,
    })
}

fn run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    let status: String = row.get(3)?;
    Ok(Run {
        id: row.get(0)?,
        experiment_id: row.get(1)?,
        name: row.get(2)?,
        status: parse_run_status(&status),
        config_json: row.get(4)?,
        created_at_ns: row.get(5)?,
        updated_at_ns: row.get(6)?,
    })
}

fn valid_run_transition(current: &RunStatus, target: &RunStatus) -> bool {
    current == target
        || matches!(
            (current, target),
            (
                RunStatus::Created,
                RunStatus::Running | RunStatus::Finished | RunStatus::Failed | RunStatus::Cancelled
            ) | (
                RunStatus::Running,
                RunStatus::Finished | RunStatus::Failed | RunStatus::Cancelled
            )
        )
}

fn valid_source_transition(current: &SourceState, target: &SourceState) -> bool {
    current == target
        || matches!(
            (current, target),
            (
                SourceState::Discovered | SourceState::Active | SourceState::Stale,
                SourceState::Draining | SourceState::Ended | SourceState::Lost
            ) | (
                SourceState::Draining,
                SourceState::Ended | SourceState::Lost
            )
        )
}

fn status_text(status: &RunStatus) -> &'static str {
    match status {
        RunStatus::Created => "created",
        RunStatus::Running => "running",
        RunStatus::Finished => "finished",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
    }
}

fn parse_run_status(value: &str) -> RunStatus {
    match value {
        "running" => RunStatus::Running,
        "finished" => RunStatus::Finished,
        "failed" => RunStatus::Failed,
        "cancelled" => RunStatus::Cancelled,
        _ => RunStatus::Created,
    }
}

fn source_state_text(state: &SourceState) -> &'static str {
    match state {
        SourceState::Discovered => "discovered",
        SourceState::Active => "active",
        SourceState::Stale => "stale",
        SourceState::Draining => "draining",
        SourceState::Ended => "ended",
        SourceState::Lost => "lost",
    }
}

fn parse_source_state(value: &str) -> SourceState {
    match value {
        "active" => SourceState::Active,
        "stale" => SourceState::Stale,
        "draining" => SourceState::Draining,
        "ended" => SourceState::Ended,
        "lost" => SourceState::Lost,
        _ => SourceState::Discovered,
    }
}
