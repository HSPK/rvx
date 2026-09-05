use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use rvx_core::*;
use serde_json::Value;

use crate::{EngineError, Result};

const MAX_QUERY_SCAN_ROWS: usize = 100_000;
const MAX_QUERY_SCAN_BYTES: usize = 256 * 1024 * 1024;
const MAX_QUERY_OUTPUT_POINTS: usize = 100_000;
const PAGE_ENVELOPE_RESERVE: usize = 16 * 1024;
const COLUMNS: &str = "id, run_id, source_id, ingested_at_ns, snapshot_json";

/// Owns full-state persistence and snapshot-only cursors independently of legacy metrics.
pub(crate) struct SnapshotStore {
    connection: Mutex<Connection>,
}

impl SnapshotStore {
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "temp_store", "MEMORY")?;
        let transaction = connection.transaction()?;
        let has_heads: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='snapshot_heads')",
            [],
            |row| row.get(0),
        )?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                source_id TEXT NOT NULL,
                source_session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL CHECK(sequence >= 0),
                observed_at_ns INTEGER NOT NULL,
                ingested_at_ns INTEGER NOT NULL,
                snapshot_json TEXT NOT NULL,
                UNIQUE(source_id, source_session_id, sequence)
             );
             CREATE INDEX IF NOT EXISTS snapshot_run_history ON snapshots(run_id, id DESC);
             CREATE INDEX IF NOT EXISTS snapshot_source_latest ON snapshots(run_id, source_id, id DESC);
             CREATE INDEX IF NOT EXISTS snapshot_observation ON snapshots(run_id, observed_at_ns, id);
             CREATE INDEX IF NOT EXISTS snapshot_projection_order ON snapshots(run_id, source_id, observed_at_ns, id);
             CREATE TABLE IF NOT EXISTS snapshot_heads (
                run_id TEXT NOT NULL, source_id TEXT NOT NULL,
                snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
                PRIMARY KEY(run_id, source_id)
             );
             CREATE TABLE IF NOT EXISTS snapshot_cursors (
                source_id TEXT NOT NULL, source_session_id TEXT NOT NULL,
                next_sequence INTEGER NOT NULL, updated_at_ns INTEGER NOT NULL,
                PRIMARY KEY(source_id, source_session_id)
             );
             CREATE TABLE IF NOT EXISTS snapshot_gaps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id TEXT NOT NULL, source_session_id TEXT NOT NULL,
                expected_sequence INTEGER NOT NULL, oldest_sequence INTEGER NOT NULL,
                observed_at_ns INTEGER NOT NULL
             );",
        )?;
        if !has_heads {
            transaction.execute(
                "INSERT INTO snapshot_heads(run_id,source_id,snapshot_id)
                 SELECT run_id,source_id,MAX(id) FROM snapshots GROUP BY run_id,source_id",
                [],
            )?;
        }
        transaction.commit()?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn cursor(&self, source_id: &str, session: &str) -> Result<u64> {
        Ok(self.connection.lock().query_row(
            "SELECT next_sequence FROM snapshot_cursors WHERE source_id=?1 AND source_session_id=?2",
            params![source_id, session], |row| row.get(0),
        ).optional()?.unwrap_or(0))
    }

    /// Validate the entire page before committing full objects, gaps, and its cursor together.
    pub fn ingest(
        &self,
        source: &Source,
        descriptor: &SnapshotDescriptor,
        page: &SnapshotHistoryResponse,
    ) -> Result<usize> {
        validate_snapshot_descriptor(descriptor)?;
        validate_snapshot_history_response(page)?;
        if descriptor.source_session_id != page.source_session_id {
            return Err(ProtocolError::SessionMismatch.into());
        }
        if descriptor.run_id != source.run_id
            || descriptor.attempt_id != source.attempt_id
            || descriptor.role != source.role
        {
            return invalid("snapshot descriptor identity does not match registration");
        }
        check_ids(std::slice::from_ref(&source.id), 1)?;
        check_ids(std::slice::from_ref(&source.run_id), 1)?;
        let mut connection = self.connection.lock();
        let tx = connection.transaction()?;
        let committed: u64 = tx.query_row(
            "SELECT next_sequence FROM snapshot_cursors WHERE source_id=?1 AND source_session_id=?2",
            params![source.id, page.source_session_id], |row| row.get(0),
        ).optional()?.unwrap_or(0);
        let expected = committed.max(page.oldest_sequence);
        if let Some(first_new) = page.snapshots.iter().find(|s| s.sequence >= committed) {
            if first_new.sequence != expected {
                return invalid("snapshot page skips an unreported sequence");
            }
            if page.oldest_sequence > committed && page.dropped_before != Some(page.oldest_sequence)
            {
                return invalid("expired snapshot cursor requires dropped_before");
            }
        } else if page.next_sequence > committed {
            return invalid("empty or duplicate page cannot advance the snapshot cursor");
        }
        let mut accepted = 0;
        for snapshot in &page.snapshots {
            let encoded = serde_json::to_string(snapshot)?;
            let stored: Option<(String, String)> = tx.query_row(
                "SELECT run_id, snapshot_json FROM snapshots WHERE source_id=?1 AND source_session_id=?2 AND sequence=?3",
                params![source.id, page.source_session_id, snapshot.sequence], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            if let Some((run_id, previous)) = stored {
                if run_id != source.run_id
                    || serde_json::from_str::<StateSnapshot>(&previous)? != *snapshot
                {
                    return invalid("duplicate snapshot sequence contains conflicting state");
                }
                continue;
            }
            if snapshot.sequence < committed {
                return invalid("snapshot sequence regresses behind its committed cursor");
            }
            tx.execute(
                "INSERT INTO snapshots(run_id,source_id,source_session_id,sequence,observed_at_ns,ingested_at_ns,snapshot_json)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![source.run_id,source.id,page.source_session_id,snapshot.sequence,snapshot.observed_at_ns,now_ns(),encoded],
            )?;
            tx.execute(
                "INSERT INTO snapshot_heads(run_id,source_id,snapshot_id) VALUES (?1,?2,?3)
                 ON CONFLICT(run_id,source_id) DO UPDATE SET snapshot_id=excluded.snapshot_id",
                params![source.run_id, source.id, tx.last_insert_rowid()],
            )?;
            accepted += 1;
        }
        if accepted > 0 && page.oldest_sequence > committed {
            tx.execute(
                "INSERT INTO snapshot_gaps(source_id,source_session_id,expected_sequence,oldest_sequence,observed_at_ns)
                 VALUES (?1,?2,?3,?4,?5)",
                params![source.id,page.source_session_id,committed,page.oldest_sequence,now_ns()],
            )?;
        }
        tx.execute(
            "INSERT INTO snapshot_cursors(source_id,source_session_id,next_sequence,updated_at_ns) VALUES (?1,?2,?3,?4)
             ON CONFLICT(source_id,source_session_id) DO UPDATE SET
             next_sequence=MAX(snapshot_cursors.next_sequence,excluded.next_sequence),updated_at_ns=excluded.updated_at_ns",
            params![source.id,page.source_session_id,committed.max(page.next_sequence),now_ns()],
        )?;
        tx.commit()?;
        Ok(accepted)
    }

    pub fn count(&self) -> Result<u64> {
        Ok(self
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM snapshots", [], |row| row.get(0))?)
    }

    pub fn gap_count(&self) -> Result<u64> {
        Ok(self
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM snapshot_gaps", [], |row| row.get(0))?)
    }

    pub fn latest(&self, request: &SnapshotLatestRequest) -> Result<SnapshotLatestResponse> {
        validate_page(&request.run_id, &request.source_ids, request.limit)?;
        if let Some(id) = &request.after_source_id {
            check_ids(std::slice::from_ref(id), 1)?;
        }
        let mut filter = Filter::new();
        filter.ids("run_id", std::slice::from_ref(&request.run_id));
        filter.ids("source_id", &request.source_ids);
        if let Some(id) = &request.after_source_id {
            filter.push("source_id > ?", id.clone().into());
        }
        let sql = format!(
            "SELECT {COLUMNS} FROM snapshots WHERE id IN
            (SELECT snapshot_id FROM snapshot_heads {} ORDER BY source_id LIMIT {}) ORDER BY source_id",
            filter.sql(),
            request.limit + 1
        );
        let (snapshots, more) = self.page(&sql, &filter.values, request.limit)?;
        let next_source_id = more.then(|| snapshots.last().unwrap().source_id.clone());
        Ok(SnapshotLatestResponse {
            snapshots,
            next_source_id,
        })
    }

    pub fn history(&self, request: &SnapshotHistoryRequest) -> Result<SnapshotHistoryPage> {
        validate_page(&request.run_id, &request.source_ids, request.limit)?;
        validate_range(request.from, request.to)?;
        if request.before_id.is_some_and(|id| id <= 0) {
            return invalid("before_id must be positive");
        }
        let mut filter = Filter::new();
        filter.ids("run_id", std::slice::from_ref(&request.run_id));
        filter.ids("source_id", &request.source_ids);
        if let Some(id) = request.before_id {
            filter.push("id < ?", id.into());
        }
        if let Some(from) = request.from {
            filter.push("observed_at_ns >= ?", from.into());
        }
        if let Some(to) = request.to {
            filter.push("observed_at_ns <= ?", to.into());
        }
        let sql = format!(
            "SELECT {COLUMNS} FROM snapshots {} ORDER BY id DESC LIMIT {}",
            filter.sql(),
            request.limit + 1
        );
        let (snapshots, more) = self.page(&sql, &filter.values, request.limit)?;
        let next_before_id = more.then(|| snapshots.last().unwrap().id);
        Ok(SnapshotHistoryPage {
            snapshots,
            next_before_id,
        })
    }

    fn page(
        &self,
        sql: &str,
        values: &[SqlValue],
        limit: usize,
    ) -> Result<(Vec<StoredSnapshot>, bool)> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(sql)?;
        let mut rows = statement.query(params_from_iter(values))?;
        let mut snapshots = Vec::new();
        let mut bytes = PAGE_ENVELOPE_RESERVE;
        while let Some(row) = rows.next()? {
            if snapshots.len() == limit {
                return Ok((snapshots, true));
            }
            let snapshot = from_row(row)?;
            bytes += serde_json::to_vec(&snapshot)?.len() + 1;
            if bytes > MAX_SNAPSHOT_PAGE_BYTES {
                if snapshots.is_empty() {
                    return invalid("stored snapshot exceeds response budget");
                }
                return Ok((snapshots, true));
            }
            snapshots.push(snapshot);
        }
        Ok((snapshots, false))
    }

    /// Project numeric fields without merging observations or constructing an independent metric log.
    pub fn query(&self, request: &SnapshotQueryRequest) -> Result<SnapshotQueryResponse> {
        check_ids(&request.run_ids, MAX_SNAPSHOT_QUERY_RUNS)?;
        check_ids(&request.source_ids, MAX_SNAPSHOT_SOURCE_IDS)?;
        if request.run_ids.is_empty()
            || request.paths.is_empty()
            || request.paths.len() > MAX_SNAPSHOT_QUERY_PATHS
        {
            return invalid("query requires 1..64 run_ids and 1..64 paths");
        }
        if request.max_points == 0 || request.max_points > MAX_SNAPSHOT_QUERY_POINTS {
            return invalid("max_points must be 1..10000");
        }
        check_ids(std::slice::from_ref(&request.axis), 1)?;
        for path in &request.paths {
            validate_snapshot_pointer(path)?;
        }
        if request.paths.iter().collect::<HashSet<_>>().len() != request.paths.len() {
            return invalid("duplicate query paths");
        }
        validate_range(request.from, request.to)?;
        let mut filter = Filter::new();
        filter.ids("run_id", &request.run_ids);
        filter.ids("source_id", &request.source_ids);
        // Explicit logical-axis ranges are applied below; wall_time can use the durable index.
        if request.axis == "wall_time" {
            if let Some(from) = request.from {
                filter.push("observed_at_ns >= ?", from.into());
            }
            if let Some(to) = request.to {
                filter.push("observed_at_ns <= ?", to.into());
            }
        }
        let connection = self.connection.lock();
        let sql = format!("SELECT {COLUMNS} FROM snapshots INDEXED BY snapshot_projection_order {} ORDER BY run_id,source_id,observed_at_ns,id LIMIT {}",
            filter.sql(), MAX_QUERY_SCAN_ROWS + 1);
        let mut statement = connection.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(&filter.values))?;
        let mut groups: BTreeMap<(String, String), Vec<Projected>> = BTreeMap::new();
        let mut scan_bytes = 0;
        let mut scan_rows = 0;
        while let Some(row) = rows.next()? {
            scan_rows += 1;
            let raw: String = row.get(4)?;
            scan_bytes += raw.len();
            if scan_rows > MAX_QUERY_SCAN_ROWS || scan_bytes > MAX_QUERY_SCAN_BYTES {
                return invalid(
                    "snapshot query scan budget exceeded; narrow run/source/time filters",
                );
            }
            let snapshot: StateSnapshot = serde_json::from_str(&raw)?;
            let axis = if request.axis == "wall_time" {
                Some(snapshot.observed_at_ns)
            } else {
                snapshot.axes.get(&request.axis).copied()
            };
            let Some(axis) = axis else { continue };
            if request.from.is_some_and(|n| axis < n) || request.to.is_some_and(|n| axis > n) {
                continue;
            }
            let key = (row.get(1)?, row.get(2)?);
            let group = groups.entry(key).or_default();
            // Bounded in-memory projections, never full-state history.
            if scan_rows.saturating_mul(request.paths.len()) > MAX_QUERY_OUTPUT_POINTS * 10 {
                return invalid("snapshot projection budget exceeded; narrow query");
            }
            group.push(Projected {
                session: snapshot.source_session_id,
                sequence: snapshot.sequence,
                axis,
                observed: snapshot.observed_at_ns,
                values: request
                    .paths
                    .iter()
                    .map(|path| snapshot.state.pointer(path).and_then(Value::as_f64))
                    .collect(),
            });
        }
        drop(rows);
        drop(statement);
        drop(connection);
        let mut response = SnapshotQueryResponse {
            axis: request.axis.clone(),
            series: Vec::new(),
        };
        let mut output_points = 0;
        let mut output_bytes = PAGE_ENVELOPE_RESERVE;
        for ((run_id, source_id), mut points) in groups {
            points.sort_by_key(|p| (p.axis, p.observed, p.sequence));
            let count = points.len().min(request.max_points);
            output_points += count * request.paths.len();
            if output_points > MAX_QUERY_OUTPUT_POINTS {
                return invalid("snapshot query output budget exceeded; narrow query");
            }
            for (path_index, path) in request.paths.iter().enumerate() {
                output_bytes += serde_json::to_vec(&(&run_id, &source_id, path))?.len() + 256;
                let mut series = SnapshotQuerySeries {
                    run_id: run_id.clone(),
                    source_id: source_id.clone(),
                    path: path.clone(),
                    source_session_ids: Vec::with_capacity(count),
                    sequences: Vec::with_capacity(count),
                    axes: Vec::with_capacity(count),
                    observed_at_ns: Vec::with_capacity(count),
                    values: Vec::with_capacity(count),
                };
                for position in projection_positions(&points, path_index, count) {
                    let point = &points[position];
                    output_bytes += serde_json::to_vec(&point.session)?.len() + 128;
                    if output_bytes > MAX_SNAPSHOT_PAGE_BYTES {
                        return invalid("snapshot query response exceeds 16 MiB; narrow query");
                    }
                    series.source_session_ids.push(point.session.clone());
                    series.sequences.push(point.sequence);
                    series.axes.push(point.axis);
                    series.observed_at_ns.push(point.observed);
                    series.values.push(point.values[path_index]);
                }
                response.series.push(series);
            }
        }
        if serde_json::to_vec(&response)?.len() > MAX_SNAPSHOT_PAGE_BYTES {
            return invalid("snapshot query response exceeds 16 MiB; narrow query");
        }
        Ok(response)
    }

    pub fn diff(&self, request: &SnapshotDiffRequest) -> Result<SnapshotDiffResponse> {
        if request.before_id <= 0 || request.after_id <= 0 {
            return invalid("snapshot IDs must be positive");
        }
        let connection = self.connection.lock();
        let load = |id| -> Result<StateSnapshot> {
            let raw: String = connection
                .query_row(
                    "SELECT snapshot_json FROM snapshots WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| EngineError::InvalidInput(format!("unknown snapshot ID {id}")))?;
            Ok(serde_json::from_str(&raw)?)
        };
        let before = load(request.before_id)?;
        let after = load(request.after_id)?;
        drop(connection);
        let mut response = SnapshotDiffResponse {
            before_id: request.before_id,
            after_id: request.after_id,
            changes: Vec::new(),
            truncated: false,
        };
        let mut budget = PAGE_ENVELOPE_RESERVE;
        diff_values(
            "",
            Some(&before.state),
            Some(&after.state),
            &mut response,
            &mut budget,
        )?;
        Ok(response)
    }
}

struct Projected {
    session: String,
    sequence: u64,
    axis: i64,
    observed: i64,
    values: Vec<Option<f64>>,
}

/// Keep actual missing observations when sampling would otherwise join across a known gap.
fn projection_positions(points: &[Projected], path: usize, count: usize) -> Vec<usize> {
    let mut positions: Vec<_> = (0..count)
        .map(|index| {
            if count == 1 {
                points.len() - 1
            } else {
                index * (points.len() - 1) / (count - 1)
            }
        })
        .collect();
    // Work backwards so the final observation is preserved and one gap can separate
    // several omitted segments without inventing nulls at real numeric observations.
    for right in (1..positions.len()).rev() {
        let left_index = positions[right - 1];
        let right_index = positions[right];
        if points[left_index].values[path].is_some() && points[right_index].values[path].is_some() {
            if let Some(gap) = (left_index + 1..right_index)
                .rev()
                .find(|&index| points[index].values[path].is_none())
            {
                positions[right - 1] = gap;
            }
        }
    }
    positions
}

fn diff_values(
    path: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    response: &mut SnapshotDiffResponse,
    bytes: &mut usize,
) -> Result<()> {
    if before == after || response.truncated {
        return Ok(());
    }
    if let (Some(Value::Object(a)), Some(Value::Object(b))) = (before, after) {
        for key in a
            .keys()
            .chain(b.keys())
            .collect::<std::collections::BTreeSet<_>>()
        {
            let escaped = key.replace('~', "~0").replace('/', "~1");
            diff_values(
                &format!("{path}/{escaped}"),
                a.get(key),
                b.get(key),
                response,
                bytes,
            )?;
            if response.truncated {
                break;
            }
        }
    } else if let (Some(Value::Array(a)), Some(Value::Array(b))) = (before, after) {
        for index in 0..a.len().max(b.len()) {
            diff_values(
                &format!("{path}/{index}"),
                a.get(index),
                b.get(index),
                response,
                bytes,
            )?;
            if response.truncated {
                break;
            }
        }
    } else {
        let change = SnapshotChange {
            path: path.into(),
            kind: if before.is_none() {
                SnapshotChangeKind::Added
            } else if after.is_none() {
                SnapshotChangeKind::Removed
            } else {
                SnapshotChangeKind::Changed
            },
            before: before.cloned(),
            after: after.cloned(),
        };
        let size = serde_json::to_vec(&change)?.len() + 1;
        if response.changes.len() >= MAX_SNAPSHOT_DIFF_CHANGES
            || *bytes + size > MAX_SNAPSHOT_PAGE_BYTES
        {
            response.truncated = true;
        } else {
            *bytes += size;
            response.changes.push(change);
        }
    }
    Ok(())
}

fn from_row(row: &rusqlite::Row<'_>) -> Result<StoredSnapshot> {
    Ok(StoredSnapshot {
        id: row.get(0)?,
        run_id: row.get(1)?,
        source_id: row.get(2)?,
        ingested_at_ns: row.get(3)?,
        snapshot: serde_json::from_str(&row.get::<_, String>(4)?)?,
    })
}

fn invalid<T>(message: &str) -> Result<T> {
    Err(EngineError::InvalidInput(message.into()))
}

fn check_ids(ids: &[String], maximum: usize) -> Result<()> {
    if ids.len() > maximum || ids.iter().any(|id| id.trim().is_empty() || id.len() > 4096) {
        return invalid("too many identifiers, or empty/oversized identifier");
    }
    Ok(())
}

fn validate_page(run_id: &str, sources: &[String], limit: usize) -> Result<()> {
    check_ids(&[run_id.into()], 1)?;
    check_ids(sources, MAX_SNAPSHOT_SOURCE_IDS)?;
    if limit == 0 || limit > MAX_SNAPSHOT_HISTORY_LIMIT {
        return invalid("page limit must be 1..256");
    }
    Ok(())
}

fn validate_range(from: Option<i64>, to: Option<i64>) -> Result<()> {
    if from.zip(to).is_some_and(|(a, b)| a > b) {
        return invalid("from must not exceed to");
    }
    Ok(())
}

struct Filter {
    clauses: Vec<String>,
    values: Vec<SqlValue>,
}
impl Filter {
    fn new() -> Self {
        Self {
            clauses: Vec::new(),
            values: Vec::new(),
        }
    }
    fn push(&mut self, clause: &str, value: SqlValue) {
        self.clauses.push(clause.into());
        self.values.push(value);
    }
    fn ids(&mut self, column: &str, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        self.clauses
            .push(format!("{column} IN ({})", vec!["?"; ids.len()].join(",")));
        self.values.extend(ids.iter().cloned().map(SqlValue::Text));
    }
    fn sql(&self) -> String {
        format!("WHERE {}", self.clauses.join(" AND "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source(id: &str, run: &str) -> Source {
        Source {
            id: id.into(),
            run_id: run.into(),
            attempt_id: "attempt".into(),
            role: "learner".into(),
            endpoint: "http://127.0.0.1:1".into(),
            node_id: None,
            rank: None,
            state: SourceState::Active,
            source_session_id: None,
            last_success_at_ns: None,
            last_error: None,
            scrape_interval_ms: 1000,
            timeout_ms: 500,
            descriptor: None,
        }
    }

    fn descriptor(source: &Source, session: &str) -> SnapshotDescriptor {
        SnapshotDescriptor {
            protocol_version: 1,
            source_session_id: session.into(),
            project: "p".into(),
            experiment: "e".into(),
            run_id: source.run_id.clone(),
            attempt_id: source.attempt_id.clone(),
            role: source.role.clone(),
            rank: None,
            node_id: None,
            pid: None,
            labels: BTreeMap::new(),
            schema_version: 1,
        }
    }

    fn snapshot(sequence: u64, state: Value) -> StateSnapshot {
        StateSnapshot {
            source_session_id: "session".into(),
            sequence,
            observed_at_ns: sequence as i64 * 10,
            schema_version: 1,
            axes: BTreeMap::new(),
            state,
        }
    }

    fn page(snapshots: Vec<StateSnapshot>) -> SnapshotHistoryResponse {
        SnapshotHistoryResponse {
            protocol_version: 1,
            source_session_id: "session".into(),
            oldest_sequence: 0,
            next_sequence: snapshots.last().map_or(0, |s| s.sequence + 1),
            dropped_before: None,
            snapshots,
        }
    }

    fn latest(run: &str) -> SnapshotLatestRequest {
        SnapshotLatestRequest {
            run_id: run.into(),
            source_ids: vec![],
            limit: 100,
            after_source_id: None,
        }
    }

    fn history(run: &str) -> SnapshotHistoryRequest {
        SnapshotHistoryRequest {
            run_id: run.into(),
            source_ids: vec![],
            before_id: None,
            from: None,
            to: None,
            limit: 100,
        }
    }

    fn query(run: &str, paths: &[&str]) -> SnapshotQueryRequest {
        SnapshotQueryRequest {
            run_ids: vec![run.into()],
            paths: paths.iter().map(|s| s.to_string()).collect(),
            source_ids: vec![],
            axis: "wall_time".into(),
            from: None,
            to: None,
            max_points: 1600,
        }
    }

    #[test]
    fn full_state_survives_reopen_and_deletions_never_merge() {
        let dir = crate::test_directory().unwrap();
        let source = source("source", "run");
        let descriptor = descriptor(&source, "session");
        let first = snapshot(
            0,
            json!({"phase":"training","queue":{"ready":8,"inflight":["batch-1"]},
            "workers":[{"rank":0,"busy":true}],"nullable":null,"deleted":42}),
        );
        let second = snapshot(1, json!({"phase":"idle","queue":{},"workers":[]}));
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        assert_eq!(
            store
                .ingest(
                    &source,
                    &descriptor,
                    &page(vec![first.clone(), second.clone()])
                )
                .unwrap(),
            2
        );
        assert_eq!(store.cursor("source", "session").unwrap(), 2);
        assert_eq!(
            store.latest(&latest("run")).unwrap().snapshots[0].snapshot,
            second
        );
        drop(store);
        let reopened = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        assert_eq!(reopened.count().unwrap(), 2);
        let stored = reopened.history(&history("run")).unwrap().snapshots;
        assert_eq!(stored[0].snapshot, second);
        assert_eq!(stored[1].snapshot, first);
        assert!(stored[0].snapshot.state.get("deleted").is_none());
        assert_eq!(reopened.cursor("source", "session").unwrap(), 2);
        assert!(!dir.path().join("metrics.wal").exists());
        let connection = Connection::open(dir.path().join("snapshots.db")).unwrap();
        let mode: String = connection
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let sync: i64 = reopened
            .connection
            .lock()
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 2);
    }

    #[test]
    fn duplicate_conflicts_gaps_sessions_and_invalid_batches_are_atomic() {
        let dir = crate::test_directory().unwrap();
        let path = dir.path().join("snapshots.db");
        let store = SnapshotStore::open(&path).unwrap();
        let source = source("source", "run");
        let descriptor = descriptor(&source, "session");
        let initial = page(vec![
            snapshot(0, json!({"n":1})),
            snapshot(1, json!({"n":2})),
        ]);
        assert_eq!(store.ingest(&source, &descriptor, &initial).unwrap(), 2);
        assert_eq!(store.ingest(&source, &descriptor, &initial).unwrap(), 0);
        let mut conflict = initial.clone();
        conflict.snapshots[0].state = json!({"n":999});
        assert!(store.ingest(&source, &descriptor, &conflict).is_err());
        let mut conflicts = Vec::new();
        let mut conflict = initial.clone();
        conflict.snapshots[0].axes.insert("step".into(), 99);
        conflicts.push(conflict);
        let mut conflict = initial.clone();
        conflict.snapshots[0].observed_at_ns = 99;
        conflicts.push(conflict);
        let mut conflict = initial.clone();
        conflict.snapshots[0].schema_version = 2;
        conflicts.push(conflict);
        for conflict in conflicts {
            assert!(store.ingest(&source, &descriptor, &conflict).is_err());
            assert_eq!(store.count().unwrap(), 2);
            assert_eq!(store.cursor("source", "session").unwrap(), 2);
        }
        assert_eq!(store.ingest(&source, &descriptor, &initial).unwrap(), 0);
        let next = page(vec![snapshot(2, json!({})), snapshot(3, json!({}))]);
        let mut invalid_pages = Vec::new();
        let mut bad = next.clone();
        bad.snapshots[1].source_session_id = "different".into();
        invalid_pages.push(bad);
        let mut bad = next.clone();
        bad.snapshots[1].schema_version = 2;
        invalid_pages.push(bad);
        let mut bad = next.clone();
        bad.snapshots[1].sequence = 1;
        invalid_pages.push(bad);
        let mut bad = next.clone();
        bad.protocol_version = 2;
        invalid_pages.push(bad);
        let mut bad = next.clone();
        bad.next_sequence = 9;
        invalid_pages.push(bad);
        let mut bad = next.clone();
        bad.snapshots[1].state = json!([]);
        invalid_pages.push(bad);
        let mut bad = next.clone();
        bad.source_session_id = "different".into();
        invalid_pages.push(bad);
        for bad in invalid_pages {
            assert!(store.ingest(&source, &descriptor, &bad).is_err());
            assert_eq!(store.count().unwrap(), 2);
            assert_eq!(store.cursor("source", "session").unwrap(), 2);
            assert_eq!(store.gap_count().unwrap(), 0);
        }
        let mut gap = page(vec![snapshot(5, json!({"gap":true}))]);
        gap.oldest_sequence = 5;
        assert!(store.ingest(&source, &descriptor, &gap).is_err());
        gap.dropped_before = Some(5);
        assert_eq!(store.ingest(&source, &descriptor, &gap).unwrap(), 1);
        assert_eq!(store.gap_count().unwrap(), 1);
        assert_eq!(store.cursor("source", "session").unwrap(), 6);
        let mut session = page(vec![snapshot(0, json!({"restart":true}))]);
        session.source_session_id = "session-2".into();
        session.snapshots[0].source_session_id = "session-2".into();
        assert!(store.ingest(&source, &descriptor, &session).is_err());
        let mut new_descriptor = descriptor.clone();
        new_descriptor.source_session_id = "session-2".into();
        store.ingest(&source, &new_descriptor, &session).unwrap();
        assert_eq!(store.cursor("source", "session-2").unwrap(), 1);
        assert_eq!(store.cursor("source", "session").unwrap(), 6);
        drop(store);
        let store = SnapshotStore::open(&path).unwrap();
        assert_eq!(store.count().unwrap(), 4);
        assert_eq!(store.gap_count().unwrap(), 1);
        assert_eq!(
            store.latest(&latest("run")).unwrap().snapshots[0]
                .snapshot
                .source_session_id,
            "session-2"
        );
    }

    #[test]
    fn rejects_skips_empty_cursor_advancement_and_descriptor_identity_mismatch() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        let source = source("source", "run");
        let mut descriptor = descriptor(&source, "session");
        assert!(store
            .ingest(&source, &descriptor, &page(vec![snapshot(1, json!({}))]))
            .is_err());
        let mut empty = page(vec![]);
        empty.next_sequence = 100;
        assert!(store.ingest(&source, &descriptor, &empty).is_err());
        descriptor.run_id = "other".into();
        assert!(store
            .ingest(&source, &descriptor, &page(vec![snapshot(0, json!({}))]))
            .is_err());
        assert_eq!(store.count().unwrap(), 0);
        assert_eq!(store.cursor("source", "session").unwrap(), 0);
        descriptor.run_id = source.run_id.clone();
        let mut expired = page(vec![snapshot(5, json!({}))]);
        expired.oldest_sequence = 5;
        assert!(store.ingest(&source, &descriptor, &expired).is_err());
        assert_eq!(store.count().unwrap(), 0);
        expired.dropped_before = Some(5);
        assert_eq!(store.ingest(&source, &descriptor, &expired).unwrap(), 1);
        assert_eq!(store.gap_count().unwrap(), 1);
    }

    #[test]
    fn source_order_and_stored_id_pagination_remain_stable_with_new_insertions() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        for id in ["c", "a", "b"] {
            let source = source(id, "run");
            store
                .ingest(
                    &source,
                    &descriptor(&source, "session"),
                    &page(vec![snapshot(0, json!({"id":id}))]),
                )
                .unwrap();
        }
        let mut latest_request = latest("run");
        latest_request.limit = 1;
        let mut ids = Vec::new();
        loop {
            let result = store.latest(&latest_request).unwrap();
            ids.extend(result.snapshots.iter().map(|s| s.source_id.clone()));
            latest_request.after_source_id = result.next_source_id;
            if latest_request.after_source_id.is_none() {
                break;
            }
        }
        assert_eq!(ids, vec!["a", "b", "c"]);
        let mut request = history("run");
        request.limit = 2;
        let first = store.history(&request).unwrap();
        assert_eq!(
            first.snapshots.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![3, 2]
        );
        let source = source("a", "run");
        store
            .ingest(
                &source,
                &descriptor(&source, "session"),
                &page(vec![snapshot(1, json!({}))]),
            )
            .unwrap();
        request.before_id = first.next_before_id;
        let second = store.history(&request).unwrap();
        assert_eq!(
            second.snapshots.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(second.next_before_id, None);
        request = history("run");
        request.source_ids = vec!["a".into()];
        request.from = Some(5);
        assert_eq!(store.history(&request).unwrap().snapshots.len(), 1);
    }

    #[test]
    fn numeric_projection_preserves_missing_null_and_false_with_pointer_escaping() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        let source = source("source", "run");
        let states = [
            json!({"n":3,"a/b":{"~key":[7]}}),
            json!({}),
            json!({"n":null}),
            json!({"n":false}),
            json!({"n":"8"}),
            json!({"n":8}),
        ];
        let mut snapshots: Vec<_> = states
            .into_iter()
            .enumerate()
            .map(|(i, v)| snapshot(i as u64, v))
            .collect();
        snapshots[0].axes.insert("step".into(), 100);
        snapshots[5].axes.insert("step".into(), 200);
        store
            .ingest(&source, &descriptor(&source, "session"), &page(snapshots))
            .unwrap();
        let request = query("run", &["/n", "/a~1b/~0key/0"]);
        let result = store.query(&request).unwrap();
        assert_eq!(result.axis, "wall_time");
        assert_eq!(
            result.series[0].values,
            vec![Some(3.0), None, None, None, None, Some(8.0)]
        );
        assert_eq!(
            result.series[1].values,
            vec![Some(7.0), None, None, None, None, None]
        );
        assert_eq!(result.series[0].axes, vec![0, 10, 20, 30, 40, 50]);
        let mut logical = request.clone();
        logical.axis = "step".into();
        let result = store.query(&logical).unwrap();
        assert_eq!(result.series[0].axes, vec![100, 200]);
        let mut downsample = request;
        downsample.max_points = 2;
        let sampled = store.query(&downsample).unwrap();
        assert_eq!(sampled.series[0].sequences, vec![4, 5]);
        assert_eq!(sampled.series[0].values, vec![None, Some(8.0)]);
        assert_eq!(sampled.series[1].sequences, vec![0, 5]);
        logical.paths = vec!["/bad~2".into()];
        assert!(store.query(&logical).is_err());
    }

    #[test]
    fn bounded_projections_never_connect_across_omitted_missing_values() {
        let points: Vec<_> = [Some(1.0), None, Some(2.0), None, Some(3.0)]
            .into_iter()
            .enumerate()
            .map(|(index, value)| Projected {
                session: "session".into(),
                sequence: index as u64,
                axis: index as i64,
                observed: index as i64,
                values: vec![value, Some(index as f64)],
            })
            .collect();
        assert_eq!(projection_positions(&points, 0, 1), vec![4]);
        assert_eq!(projection_positions(&points, 0, 2), vec![3, 4]);
        assert_eq!(projection_positions(&points, 0, 3), vec![0, 3, 4]);
        assert_eq!(projection_positions(&points, 1, 3), vec![0, 2, 4]);
        for count in 1..=points.len() {
            let selected = projection_positions(&points, 0, count);
            assert_eq!(selected.len(), count);
            assert_eq!(selected.last(), Some(&(points.len() - 1)));
            for pair in selected.windows(2) {
                assert!(pair[0] < pair[1]);
                if points[pair[0]].values[0].is_some() && points[pair[1]].values[0].is_some() {
                    assert!(points[pair[0]..=pair[1]]
                        .iter()
                        .all(|point| point.values[0].is_some()));
                }
            }
        }
    }

    #[test]
    fn cross_run_diff_distinguishes_null_missing_and_escapes_paths() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        for (id, run, state) in [
            (
                "a",
                "run-a",
                json!({"removed":null,"changed":null,"a/b":{"~key":1},"array":[1,2]}),
            ),
            (
                "b",
                "run-b",
                json!({"added":null,"changed":false,"a/b":{"~key":2},"array":[1]}),
            ),
        ] {
            let source = source(id, run);
            store
                .ingest(
                    &source,
                    &descriptor(&source, "session"),
                    &page(vec![snapshot(0, state)]),
                )
                .unwrap();
        }
        let response = store
            .diff(&SnapshotDiffRequest {
                before_id: 1,
                after_id: 2,
            })
            .unwrap();
        assert!(!response.truncated);
        let encoded = serde_json::to_value(response).unwrap();
        let changes = encoded["changes"].as_array().unwrap();
        assert!(changes.contains(&json!({"path":"/removed","kind":"removed","before":null})));
        assert!(changes.contains(&json!({"path":"/added","kind":"added","after":null})));
        assert!(changes
            .contains(&json!({"path":"/changed","kind":"changed","before":null,"after":false})));
        assert!(
            changes.contains(&json!({"path":"/a~1b/~0key","kind":"changed","before":1,"after":2}))
        );
        assert!(changes.contains(&json!({"path":"/array/1","kind":"removed","before":2})));
        assert!(store
            .diff(&SnapshotDiffRequest {
                before_id: 1,
                after_id: 99
            })
            .is_err());
        let result = store
            .query(&SnapshotQueryRequest {
                run_ids: vec!["run-a".into(), "run-b".into()],
                ..query("run-a", &["/a~1b/~0key"])
            })
            .unwrap();
        assert_eq!(result.series.len(), 2);
    }

    #[test]
    fn diff_reports_truncation_and_pages_never_truncate_state_fields() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        let source = source("source", "run");
        let descriptor = descriptor(&source, "session");
        let many: serde_json::Map<String, Value> = (0..MAX_SNAPSHOT_DIFF_CHANGES + 1)
            .map(|i| (format!("f{i}"), json!(i)))
            .collect();
        store
            .ingest(
                &source,
                &descriptor,
                &page(vec![
                    snapshot(0, json!({})),
                    snapshot(1, Value::Object(many)),
                ]),
            )
            .unwrap();
        let diff = store
            .diff(&SnapshotDiffRequest {
                before_id: 1,
                after_id: 2,
            })
            .unwrap();
        assert_eq!(diff.changes.len(), MAX_SNAPSHOT_DIFF_CHANGES);
        assert!(diff.truncated);
        let text = "x".repeat(3 * 1024 * 1024);
        for sequence in 2..8 {
            store
                .ingest(
                    &source,
                    &descriptor,
                    &page(vec![snapshot(sequence, json!({"text":text}))]),
                )
                .unwrap();
        }
        let result = store.history(&history("run")).unwrap();
        assert_eq!(result.snapshots.len(), 5);
        assert!(result.next_before_id.is_some());
        assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_SNAPSHOT_PAGE_BYTES);
        for item in &result.snapshots {
            assert_eq!(
                item.snapshot.state["text"].as_str().unwrap().len(),
                text.len()
            );
        }
        let request = SnapshotHistoryRequest {
            before_id: result.next_before_id,
            ..history("run")
        };
        assert_eq!(store.history(&request).unwrap().snapshots.len(), 3);
        for id in ["a", "b", "c", "d", "e", "f"] {
            let source = self::source(id, "run");
            let descriptor = self::descriptor(&source, "session");
            store
                .ingest(
                    &source,
                    &descriptor,
                    &page(vec![snapshot(0, json!({"text":text}))]),
                )
                .unwrap();
        }
        let first = store.latest(&latest("run")).unwrap();
        assert_eq!(first.snapshots.len(), 5);
        assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_SNAPSHOT_PAGE_BYTES);
        let second = store
            .latest(&SnapshotLatestRequest {
                after_source_id: first.next_source_id,
                ..latest("run")
            })
            .unwrap();
        assert_eq!(second.snapshots.len(), 2);
        assert!(second.next_source_id.is_none());
        for item in first.snapshots.iter().chain(&second.snapshots) {
            assert_eq!(
                item.snapshot.state["text"].as_str().unwrap().len(),
                text.len()
            );
        }
    }

    #[test]
    fn query_and_page_limits_are_explicit_errors_not_silent_truncation() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        let mut request = query("run", &["/n"]);
        request.run_ids = (0..65).map(|i| format!("r{i}")).collect();
        assert!(store.query(&request).is_err());
        request = query("run", &["/n"]);
        request.paths = (0..65).map(|i| format!("/f{i}")).collect();
        assert!(store.query(&request).is_err());
        request = query("run", &["/n"]);
        request.max_points = MAX_SNAPSHOT_QUERY_POINTS + 1;
        assert!(store.query(&request).is_err());
        request = query("run", &["/n"]);
        request.source_ids = (0..257).map(|i| format!("s{i}")).collect();
        assert!(store.query(&request).is_err());
        assert!(store
            .latest(&SnapshotLatestRequest {
                limit: 257,
                ..latest("run")
            })
            .is_err());
        assert!(store
            .history(&SnapshotHistoryRequest {
                limit: 0,
                ..history("run")
            })
            .is_err());
        assert!(store
            .history(&SnapshotHistoryRequest {
                from: Some(2),
                to: Some(1),
                ..history("run")
            })
            .is_err());
    }
}
