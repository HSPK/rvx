use crate::{EngineError, Result};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use rvx_core::*;
use serde_json::Value;

const VERSION: i64 = 2;

pub(crate) fn initialize(connection: &mut Connection) -> Result<()> {
    let tables: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
         ('artifact_index_meta','artifact_lineage','artifact_aliases','artifact_exclusions')",
        [],
        |r| r.get(0),
    )?;
    let version = if tables == 4 {
        connection
            .query_row("SELECT version FROM artifact_index_meta", [], |r| {
                r.get::<_, i64>(0)
            })
            .optional()?
    } else {
        None
    };
    if version != Some(VERSION) {
        let tx = connection.transaction()?;
        tx.execute_batch(
            "DROP TABLE IF EXISTS artifact_aliases;
             DROP TABLE IF EXISTS artifact_exclusions;
             DROP TABLE IF EXISTS artifact_lineage;
             DROP TABLE IF EXISTS artifact_index_meta;
             CREATE TABLE artifact_index_meta(version INTEGER NOT NULL,last_id INTEGER NOT NULL);
             INSERT INTO artifact_index_meta VALUES (2,0);
             CREATE TABLE artifact_lineage(
                snapshot_id INTEGER NOT NULL,artifact_index INTEGER NOT NULL,
                run_id TEXT NOT NULL,source_id TEXT NOT NULL,observed_at_ns INTEGER NOT NULL,
                step INTEGER,action TEXT NOT NULL,name TEXT NOT NULL,digest TEXT NOT NULL,
                record_json TEXT NOT NULL,PRIMARY KEY(snapshot_id,artifact_index));
             CREATE INDEX artifact_lineage_run ON artifact_lineage(run_id,snapshot_id DESC,artifact_index DESC);
             CREATE INDEX artifact_lineage_name ON artifact_lineage(run_id,name,snapshot_id DESC,artifact_index DESC);
             CREATE INDEX artifact_lineage_digest ON artifact_lineage(run_id,digest,snapshot_id DESC,artifact_index DESC);
             CREATE TABLE artifact_aliases(
                snapshot_id INTEGER NOT NULL,artifact_index INTEGER NOT NULL,
                run_id TEXT NOT NULL,source_id TEXT NOT NULL,name TEXT NOT NULL,alias TEXT NOT NULL,
                PRIMARY KEY(snapshot_id,artifact_index,alias));
             CREATE INDEX artifact_alias_lookup ON artifact_aliases(run_id,name,alias,snapshot_id DESC,artifact_index DESC);
             CREATE TABLE artifact_exclusions(
                snapshot_id INTEGER NOT NULL,artifact_index INTEGER NOT NULL,
                run_id TEXT NOT NULL,source_id TEXT NOT NULL,reason TEXT NOT NULL,
                PRIMARY KEY(snapshot_id,artifact_index));
             CREATE INDEX artifact_exclusion_scope ON artifact_exclusions(run_id,source_id);"
        )?;
        tx.commit()?;
    }
    loop {
        let last: i64 =
            connection.query_row("SELECT last_id FROM artifact_index_meta", [], |r| r.get(0))?;
        let tx = connection.transaction()?;
        let mut statement = tx.prepare(
            "SELECT id,run_id,source_id,snapshot_json FROM snapshots WHERE id>? ORDER BY id LIMIT 64")?;
        let mut rows = statement.query([last])?;
        let mut count = 0;
        let mut bytes = 0;
        while let Some(row) = rows.next()? {
            let raw: String = row.get(3)?;
            if count > 0 && bytes + raw.len() > MAX_SNAPSHOT_PAGE_BYTES {
                break;
            }
            let snapshot: StateSnapshot = serde_json::from_str(&raw)?;
            insert(
                &tx,
                row.get(0)?,
                &row.get::<_, String>(1)?,
                &row.get::<_, String>(2)?,
                &snapshot,
            )?;
            count += 1;
            bytes += raw.len();
        }
        drop(rows);
        drop(statement);
        tx.commit()?;
        if count == 0 {
            break;
        }
    }
    Ok(())
}

pub(crate) fn insert(
    tx: &Connection,
    id: i64,
    run: &str,
    source: &str,
    snapshot: &StateSnapshot,
) -> Result<()> {
    if let Some(step) = snapshot
        .state
        .pointer("/tracker/step")
        .and_then(Value::as_i64)
    {
        match snapshot.state.get("artifacts") {
            None => {}
            Some(Value::Array(records)) => {
                for (index, value) in records.iter().enumerate() {
                    let index = i64::try_from(index)
                        .map_err(|_| EngineError::InvalidInput("artifact index overflow".into()))?;
                    let record = serde_json::from_value::<ArtifactRecord>(value.clone())
                        .map_err(|e| e.to_string())
                        .and_then(|record| {
                            record.validate().map(|_| record).map_err(|e| e.to_string())
                        });
                    match record {
                        Ok(record) => {
                            tx.execute(
                                "INSERT INTO artifact_lineage VALUES (?,?,?,?,?,?,?,?,?,?)",
                                params![
                                    id,
                                    index,
                                    run,
                                    source,
                                    snapshot.observed_at_ns,
                                    step,
                                    action_text(&record.action),
                                    record.name,
                                    record.digest,
                                    serde_json::to_string(&record)?
                                ],
                            )?;
                            if record.action == ArtifactAction::Log {
                                for alias in &record.aliases {
                                    tx.execute(
                                        "INSERT INTO artifact_aliases VALUES (?,?,?,?,?,?)",
                                        params![id, index, run, source, record.name, alias],
                                    )?;
                                }
                            }
                        }
                        Err(reason) => exclude(tx, id, index, run, source, &reason)?,
                    }
                }
            }
            Some(_) => exclude(tx, id, -1, run, source, "artifacts must be an array")?,
        }
    }
    tx.execute("UPDATE artifact_index_meta SET last_id=?", [id])?;
    Ok(())
}

fn exclude(
    tx: &Connection,
    id: i64,
    index: i64,
    run: &str,
    source: &str,
    reason: &str,
) -> Result<()> {
    tx.execute(
        "INSERT INTO artifact_exclusions VALUES (?,?,?,?,?)",
        params![
            id,
            index,
            run,
            source,
            reason.chars().take(512).collect::<String>()
        ],
    )?;
    Ok(())
}

pub(crate) fn lineage(
    connection: &Connection,
    request: &ArtifactLineageRequest,
) -> Result<ArtifactLineagePage> {
    validate_selection(&request.run_ids, &request.source_ids)?;
    if request.limit == 0
        || request.limit > MAX_ARTIFACT_PAGE_LIMIT
        || request.before.as_ref().is_some_and(|c| c.snapshot_id <= 0)
    {
        return invalid("invalid artifact page limit or cursor");
    }
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    ids_clause("l.run_id", &request.run_ids, &mut clauses, &mut values);
    ids_clause(
        "l.source_id",
        &request.source_ids,
        &mut clauses,
        &mut values,
    );
    for (column, value) in [("l.name", &request.name), ("l.digest", &request.digest)] {
        if let Some(value) = value {
            if !valid_text(value) {
                return invalid("invalid artifact filter");
            }
            clauses.push(format!("{column}=?"));
            values.push(value.clone().into());
        }
    }
    if let Some(action) = &request.action {
        clauses.push("l.action=?".into());
        values.push(action_text(action).to_string().into());
    }
    if let Some(cursor) = &request.before {
        clauses.push("(l.snapshot_id,l.artifact_index)<(?,?)".into());
        values.extend([
            cursor.snapshot_id.into(),
            i64::from(cursor.artifact_index).into(),
        ]);
    }
    let sql = format!(
        "SELECT l.snapshot_id,l.artifact_index,l.run_id,l.source_id,l.observed_at_ns,l.step,
                length(CAST(l.record_json AS BLOB)),l.record_json
         FROM artifact_lineage l WHERE {} ORDER BY l.snapshot_id DESC,l.artifact_index DESC LIMIT ?",
        clauses.join(" AND "));
    values.push((request.limit as i64 + 1).into());
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(values))?;
    let mut artifacts = Vec::new();
    let mut bytes = 16 * 1024;
    let mut more = false;
    while let Some(row) = rows.next()? {
        if artifacts.len() == request.limit {
            more = true;
            break;
        }
        let raw_length: i64 = row.get(6)?;
        if raw_length < 0 || raw_length as usize + bytes + 16 * 1024 > MAX_SNAPSHOT_PAGE_BYTES {
            if artifacts.is_empty() {
                return invalid("artifact record exceeds response budget");
            }
            more = true;
            break;
        }
        let artifact = lineage_row(row)?;
        bytes += serde_json::to_vec(&artifact)?.len() + 1;
        if bytes > MAX_SNAPSHOT_PAGE_BYTES {
            if artifacts.is_empty() {
                return invalid("artifact record exceeds response budget");
            }
            more = true;
            break;
        }
        artifacts.push(artifact);
    }
    let next_before = if more {
        artifacts.last().map(|r| ArtifactCursor {
            snapshot_id: r.snapshot_id,
            artifact_index: r.artifact_index,
        })
    } else {
        None
    };
    Ok(ArtifactLineagePage {
        artifacts,
        next_before,
        coverage: coverage(connection, &request.run_ids, &request.source_ids)?,
    })
}

pub(crate) fn resolve(
    connection: &Connection,
    request: &ArtifactResolveRequest,
) -> Result<ArtifactResolveResponse> {
    validate_selection(&request.run_ids, &request.source_ids)?;
    if !valid_text(&request.name) || !valid_text(&request.alias) {
        return invalid("invalid artifact name/alias");
    }
    let coverage = coverage(connection, &request.run_ids, &request.source_ids)?;
    if !coverage.complete {
        return invalid("artifact index coverage is incomplete in this scope; inspect lineage coverage before resolving");
    }
    let mut clauses = vec!["l.action='log'".into(), "l.name=?".into()];
    let mut values = vec![SqlValue::from(request.name.clone())];
    ids_clause("l.run_id", &request.run_ids, &mut clauses, &mut values);
    ids_clause(
        "l.source_id",
        &request.source_ids,
        &mut clauses,
        &mut values,
    );
    let join = if request.alias == "latest" {
        ""
    } else {
        clauses.push("a.alias=?".into());
        values.push(request.alias.clone().into());
        "JOIN artifact_aliases a ON a.snapshot_id=l.snapshot_id AND a.artifact_index=l.artifact_index AND a.run_id=l.run_id AND a.name=l.name"
    };
    let sql = format!(
        "SELECT l.snapshot_id,l.artifact_index,l.run_id,l.source_id,l.observed_at_ns,l.step,
                length(CAST(l.record_json AS BLOB)),l.record_json
         FROM artifact_lineage l {join} WHERE {} ORDER BY l.snapshot_id DESC,l.artifact_index DESC LIMIT 1",
        clauses.join(" AND "));
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(values))?;
    let row = rows
        .next()?
        .ok_or_else(|| EngineError::InvalidInput("unknown artifact name/alias".into()))?;
    let artifact = lineage_row(row)?;
    Ok(ArtifactResolveResponse { artifact, coverage })
}

fn coverage(
    connection: &Connection,
    runs: &[String],
    sources: &[String],
) -> Result<ArtifactCoverage> {
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    ids_clause("run_id", runs, &mut clauses, &mut values);
    ids_clause("source_id", sources, &mut clauses, &mut values);
    let excluded_records = connection.query_row(
        &format!(
            "SELECT COUNT(*) FROM artifact_exclusions WHERE {}",
            clauses.join(" AND ")
        ),
        params_from_iter(values),
        |r| r.get::<_, u64>(0),
    )?;
    Ok(ArtifactCoverage {
        complete: excluded_records == 0,
        excluded_records,
    })
}

fn lineage_row(row: &rusqlite::Row<'_>) -> Result<ArtifactLineageRecord> {
    let index: i64 = row.get(1)?;
    Ok(ArtifactLineageRecord {
        snapshot_id: row.get(0)?,
        artifact_index: u32::try_from(index)
            .map_err(|_| EngineError::InvalidInput("invalid artifact index".into()))?,
        run_id: row.get(2)?,
        source_id: row.get(3)?,
        observed_at_ns: row.get(4)?,
        step: row.get(5)?,
        record: serde_json::from_str(&row.get::<_, String>(7)?)?,
    })
}
fn validate_selection(runs: &[String], sources: &[String]) -> Result<()> {
    if runs.is_empty()
        || runs.len() > MAX_ARTIFACT_QUERY_RUNS
        || sources.len() > MAX_ARTIFACT_QUERY_SOURCES
        || runs.iter().chain(sources).any(|v| !valid_text(v))
    {
        return invalid("artifact query requires 1..64 runs and at most 256 sources");
    }
    Ok(())
}
fn ids_clause(column: &str, ids: &[String], clauses: &mut Vec<String>, values: &mut Vec<SqlValue>) {
    if ids.is_empty() {
        return;
    }
    clauses.push(format!("{column} IN ({})", vec!["?"; ids.len()].join(",")));
    values.extend(ids.iter().cloned().map(Into::into));
}
fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.contains('\0')
}
fn action_text(action: &ArtifactAction) -> &'static str {
    match action {
        ArtifactAction::Log => "log",
        ArtifactAction::Use => "use",
    }
}
fn invalid<T>(message: &str) -> Result<T> {
    Err(EngineError::InvalidInput(message.into()))
}
