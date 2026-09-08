use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use rvx_core::*;
use serde_json::Value;

use crate::{EngineError, Result};

pub(crate) mod tables;

const MAX_QUERY_SCAN_ROWS: usize = 100_000;
const MAX_QUERY_SCAN_BYTES: usize = 256 * 1024 * 1024;
const MAX_QUERY_OUTPUT_POINTS: usize = 100_000;
const PAGE_ENVELOPE_RESERVE: usize = 16 * 1024;
const COLUMNS: &str = "id, run_id, source_id, ingested_at_ns, snapshot_json";

/// Owns full-state persistence and atomic snapshot-derived projections.
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
        crate::chart_index::initialize(&mut connection)?;
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
            let snapshot_id = tx.last_insert_rowid();
            crate::chart_index::insert(&tx, snapshot_id, &source.run_id, &source.id, snapshot)?;
            tx.execute(
                "INSERT INTO snapshot_heads(run_id,source_id,snapshot_id) VALUES (?1,?2,?3)
                 ON CONFLICT(run_id,source_id) DO UPDATE SET snapshot_id=excluded.snapshot_id",
                params![source.run_id, source.id, snapshot_id],
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

    /// Return an unprojected observation for inspection; nonpositive and unknown storage IDs are errors.
    pub fn get(&self, id: i64) -> Result<StoredSnapshot> {
        if id <= 0 {
            return invalid("snapshot ID must be positive");
        }
        let connection = self.connection.lock();
        let mut statement =
            connection.prepare(&format!("SELECT {COLUMNS} FROM snapshots WHERE id=?"))?;
        let mut rows = statement.query([id])?;
        let row = rows
            .next()?
            .ok_or_else(|| EngineError::InvalidInput(format!("unknown snapshot ID {id}")))?;
        from_row(row)
    }

    /// Enforce bounded Run selection before assembling metadata from the derived chart index.
    pub fn catalog(
        &self,
        request: &ChartCatalogRequest,
        sources: &[Source],
    ) -> Result<ChartCatalogResponse> {
        check_ids(&request.run_ids, MAX_SNAPSHOT_QUERY_RUNS)?;
        if request.run_ids.is_empty() {
            return invalid("catalog requires 1..64 run_ids");
        }
        crate::chart_index::catalog(&self.connection.lock(), request, sources)
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

    /// Load the complete bounded index projection shared by charts and exact statistics.
    fn projection(
        &self,
        request: &SnapshotQueryRequest,
        check: impl Fn() -> Result<()>,
    ) -> Result<Projection> {
        check()?;
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
        let connection = self.connection.lock();
        check()?;
        let mut filter = Filter::new();
        filter.ids("s.run_id", &request.run_ids);
        filter.ids("s.source_id", &request.source_ids);
        // Wall-time and elapsed bounds use observation metadata; logical ranges apply below.
        if request.axis == "wall_time" {
            if let Some(from) = request.from {
                filter.push("s.observed_at_ns >= ?", from.into());
            }
            if let Some(to) = request.to {
                filter.push("s.observed_at_ns <= ?", to.into());
            }
        }
        if request.axis == "elapsed" && (request.from.is_some() || request.to.is_some()) {
            let mut ranges = Vec::new();
            for run in request
                .run_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
            {
                let baseline: Option<i64> = connection
                    .query_row(
                        "SELECT first_observed_at_ns FROM chart_runs WHERE run_id=?",
                        [run],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(baseline) = baseline else {
                    continue;
                };
                let mut range = vec!["s.run_id=?".to_string()];
                filter.values.push(run.clone().into());
                for (bound, clause) in [
                    (request.from, "s.observed_at_ns>=?"),
                    (request.to, "s.observed_at_ns<=?"),
                ] {
                    if let Some(bound) = bound {
                        let absolute = baseline.checked_add(bound).ok_or_else(|| {
                            EngineError::InvalidInput(
                                "elapsed range overflows observation time i64".into(),
                            )
                        })?;
                        range.push(clause.into());
                        filter.values.push(absolute.into());
                    }
                }
                ranges.push(format!("({})", range.join(" AND ")));
            }
            filter.clauses.push(if ranges.is_empty() {
                "0".into()
            } else {
                format!("({})", ranges.join(" OR "))
            });
        }
        let mut field_filter = Filter::new();
        field_filter.ids("run_id", &request.run_ids);
        field_filter.ids("source_id", &request.source_ids);
        field_filter.ids("path", &request.paths);
        let mut field_statement = connection.prepare(&format!(
            "SELECT run_id,source_id,path,first_snapshot_id FROM chart_fields {} LIMIT 1000001",
            field_filter.sql()
        ))?;
        let mut field_rows = field_statement.query(params_from_iter(&field_filter.values))?;
        let mut known = BTreeMap::new();
        let mut discovered = HashSet::new();
        let mut field_bytes = 0;
        while let Some(row) = field_rows.next()? {
            check()?;
            let path: String = row.get(2)?;
            let run: String = row.get(0)?;
            let source: String = row.get(1)?;
            field_bytes += path.len() + run.len() + source.len() + 128;
            if field_bytes > MAX_QUERY_SCAN_BYTES {
                return invalid("snapshot field scope exceeds query byte budget");
            }
            discovered.insert(path.clone());
            known.insert((run, source, path), row.get::<_, i64>(3)?);
            if known.len() > 1_000_000 {
                return invalid("snapshot field scope exceeds query budget");
            }
        }
        for path in &request.paths {
            if !discovered.contains(path) {
                return invalid(&format!(
                    "field {path:?} is not an indexed numeric field in the selected sources/runs"
                ));
            }
        }
        drop(field_rows);
        drop(field_statement);
        let placeholders = vec!["?"; request.paths.len()].join(",");
        let sql = format!(
            "SELECT s.id,s.run_id,s.source_id,s.source_session_id,s.sequence,s.observed_at_ns,
                    r.first_observed_at_ns,a.value,c.exclusions_json,v.path,v.value
             FROM (SELECT id,run_id,source_id,source_session_id,sequence,observed_at_ns
                   FROM snapshots s INDEXED BY snapshot_projection_order {} ORDER BY run_id,source_id,observed_at_ns,id LIMIT {}) s
             JOIN chart_runs r ON r.run_id=s.run_id
             JOIN chart_observations c ON c.snapshot_id=s.id
             LEFT JOIN chart_axes a ON a.snapshot_id=s.id AND a.name=?
             LEFT JOIN chart_values v ON v.snapshot_id=s.id AND v.path IN ({placeholders})
             ORDER BY s.run_id,s.source_id,s.observed_at_ns,s.id,v.path",
             filter.sql(), MAX_QUERY_SCAN_ROWS+1);
        let mut parameters = filter.values.clone();
        parameters.push(request.axis.clone().into());
        parameters.extend(request.paths.iter().cloned().map(SqlValue::Text));
        let mut statement = connection.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(&parameters))?;
        let mut groups: BTreeMap<(String, String), Vec<Projected>> = BTreeMap::new();
        let mut scan_bytes = field_bytes;
        let mut scan_rows = 0;
        let mut last_id = None;
        let path_indices: BTreeMap<_, _> = request
            .paths
            .iter()
            .enumerate()
            .map(|(i, p)| (p.as_str(), i))
            .collect();
        while let Some(row) = rows.next()? {
            check()?;
            let id: i64 = row.get(0)?;
            let observed: i64 = row.get(5)?;
            let axis: Option<i64> = if request.axis == "wall_time" {
                Some(observed)
            } else if request.axis == "elapsed" {
                Some(observed.checked_sub(row.get(6)?).ok_or_else(|| {
                    EngineError::InvalidInput("elapsed observation time overflows i64".into())
                })?)
            } else {
                row.get(7)?
            };
            let key = (row.get::<_, String>(1)?, row.get::<_, String>(2)?);
            let new_snapshot = last_id != Some(id);
            if new_snapshot {
                last_id = Some(id);
                scan_rows += 1;
                scan_bytes += key.0.len() + key.1.len() + row.get::<_, String>(3)?.len() + 128;
                scan_bytes += row.get::<_, String>(8)?.len();
                if scan_rows > MAX_QUERY_SCAN_ROWS || scan_bytes > MAX_QUERY_SCAN_BYTES {
                    return invalid(
                        "snapshot query scan budget exceeded; narrow run/source/time filters",
                    );
                }
                if scan_rows.saturating_mul(request.paths.len()) > MAX_QUERY_OUTPUT_POINTS * 10 {
                    return invalid("snapshot projection budget exceeded; narrow query");
                }
            }
            let Some(axis) = axis else { continue };
            if request.from.is_some_and(|n| axis < n) || request.to.is_some_and(|n| axis > n) {
                continue;
            }
            let group = groups.entry(key).or_default();
            if new_snapshot {
                group.push(Projected {
                    id,
                    session: row.get(3)?,
                    sequence: row.get(4)?,
                    axis,
                    observed,
                    exclusions: serde_json::from_str(&row.get::<_, String>(8)?)?,
                    values: vec![None; request.paths.len()],
                });
            }
            if let Some(path) = row.get::<_, Option<String>>(9)? {
                scan_bytes += path.len() + 8;
                if scan_bytes > MAX_QUERY_SCAN_BYTES {
                    return invalid("snapshot query scan byte budget exceeded; narrow query");
                }
                group.last_mut().unwrap().values[path_indices[path.as_str()]] = row.get(10)?;
            }
        }
        drop(rows);
        drop(statement);
        drop(connection);
        Ok(Projection { known, groups })
    }

    /// Project numeric fields without merging observations or constructing an independent metric log.
    pub fn query(&self, request: &SnapshotQueryRequest) -> Result<SnapshotQueryResponse> {
        let Projection { known, groups } = self.projection(request, || Ok(()))?;
        let mut response = SnapshotQueryResponse {
            axis: request.axis.clone(),
            series: Vec::new(),
        };
        let mut output_points = 0;
        let mut output_bytes = PAGE_ENVELOPE_RESERVE;
        for ((run_id, source_id), mut points) in groups {
            points.sort_by_key(|p| (p.axis, p.observed, p.sequence));
            let count = points.len().min(request.max_points);
            for (path_index, path) in request.paths.iter().enumerate() {
                let first_indexed = known.get(&(run_id.clone(), source_id.clone(), path.clone()));
                if first_indexed.is_none() {
                    if points.iter().any(|p| p.excludes(path)) {
                        return invalid("selected source has an incomplete field index; select indexed source/fields");
                    }
                    continue;
                }
                if points.iter().any(|p| {
                    p.excludes(path)
                        && p.id < *first_indexed.unwrap()
                        && p.values[path_index].is_none()
                }) {
                    return invalid("field coverage is incomplete in a truncated snapshot index; narrow source/time filters");
                }
                output_points += count;
                if output_points > MAX_QUERY_OUTPUT_POINTS {
                    return invalid("snapshot query output budget exceeded; narrow query");
                }
                output_bytes += serde_json::to_vec(&(&run_id, &source_id, path))?.len() + 256;
                let mut series = SnapshotQuerySeries {
                    run_id: run_id.clone(),
                    source_id: source_id.clone(),
                    path: path.clone(),
                    snapshot_ids: Vec::with_capacity(count),
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
                    series.snapshot_ids.push(point.id);
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

struct Projection {
    known: BTreeMap<(String, String, String), i64>,
    groups: BTreeMap<(String, String), Vec<Projected>>,
}

struct Projected {
    id: i64,
    session: String,
    sequence: u64,
    axis: i64,
    observed: i64,
    exclusions: Vec<String>,
    values: Vec<Option<f64>>,
}

impl Projected {
    /// Match skipped discovery subtrees so a query cannot invent nulls for unindexed fields.
    fn excludes(&self, path: &str) -> bool {
        self.exclusions.iter().any(|prefix| {
            path == prefix
                || path
                    .strip_prefix(prefix)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
    }
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
            assert_eq!(
                store.query(&query("run", &["/n"])).unwrap().series[0].values,
                vec![Some(1.0), Some(2.0)]
            );
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
            json!({"n":3,"a/b":{"~key":7},"array":[7]}),
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
        let request = query("run", &["/n", "/a~1b/~0key"]);
        assert!(store.query(&query("run", &["/array/0"])).is_err());
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
        for series in &sampled.series {
            for (position, id) in series.snapshot_ids.iter().enumerate() {
                let raw = store.get(*id).unwrap();
                assert_eq!(raw.snapshot.sequence, series.sequences[position]);
                assert_eq!(
                    raw.snapshot.source_session_id,
                    series.source_session_ids[position]
                );
                assert_eq!(raw.snapshot.observed_at_ns, series.observed_at_ns[position]);
                assert_eq!(
                    raw.snapshot
                        .state
                        .pointer(&series.path)
                        .and_then(Value::as_f64),
                    series.values[position]
                );
            }
        }
        logical.paths = vec!["/bad~2".into()];
        assert!(store.query(&logical).is_err());
    }

    #[test]
    fn bounded_projections_never_connect_across_omitted_missing_values() {
        let points: Vec<_> = [Some(1.0), None, Some(2.0), None, Some(3.0)]
            .into_iter()
            .enumerate()
            .map(|(index, value)| Projected {
                id: index as i64 + 1,
                exclusions: Vec::new(),
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
    fn chart_index_rebuilds_in_chunks_without_changing_raw_history_or_cursors() {
        let dir = crate::test_directory().unwrap();
        let path = dir.path().join("snapshots.db");
        let producer = source("source", "run");
        let store = SnapshotStore::open(&path).unwrap();
        let snapshots = (0..130)
            .map(|sequence| {
                snapshot(
                    sequence,
                    if sequence == 0 {
                        json!({"progress":{"loss":2.0},"workers":[{"id":1,"busy":true}]})
                    } else {
                        json!({"progress":{},"workers":[]})
                    },
                )
            })
            .collect();
        store
            .ingest(
                &producer,
                &descriptor(&producer, "session"),
                &page(snapshots),
            )
            .unwrap();
        let before = store.get(1).unwrap();
        let query = query("run", &["/progress/loss"]);
        let projection = store.query(&query).unwrap();
        let request = ChartCatalogRequest {
            run_ids: vec!["run".into()],
        };
        let catalog = store
            .catalog(&request, std::slice::from_ref(&producer))
            .unwrap();
        assert_eq!(catalog.metrics.len(), 1);
        assert_eq!(catalog.metrics[0].sources[0].latest_value, None);
        assert_eq!(catalog.runs[0].snapshot_count, 130);
        assert_eq!(catalog.runs[0].first_observed_at_ns, Some(0));
        assert_eq!(catalog.runs[0].last_observed_at_ns, Some(1290));
        drop(store);
        Connection::open(&path)
            .unwrap()
            .execute("DROP TABLE chart_values", [])
            .unwrap();
        let store = SnapshotStore::open(&path).unwrap();
        assert_eq!(store.count().unwrap(), 130);
        assert_eq!(store.cursor("source", "session").unwrap(), 130);
        assert_eq!(store.get(1).unwrap(), before);
        assert_eq!(store.query(&query).unwrap(), projection);
        assert_eq!(
            store
                .catalog(&request, std::slice::from_ref(&producer))
                .unwrap(),
            catalog
        );
        drop(store);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "DELETE FROM chart_values WHERE snapshot_id>64;
             DELETE FROM chart_axes WHERE snapshot_id>64;
             DELETE FROM chart_observations WHERE snapshot_id>64;
             UPDATE chart_runs SET snapshot_count=64,last_observed_at_ns=630;
             UPDATE chart_index_meta SET last_id=64;",
            )
            .unwrap();
        drop(connection);
        let store = SnapshotStore::open(&path).unwrap();
        assert_eq!(store.query(&query).unwrap(), projection);
        assert_eq!(store.catalog(&request, &[producer]).unwrap(), catalog);
        assert!(store.get(0).is_err());
        assert!(store.get(999).is_err());
    }

    #[test]
    fn catalog_groups_units_defaults_and_primary_reporters_are_explicit() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        let mut learner = source("learner", "run");
        learner.descriptor = Some(json!({"labels":{},"rank":3,"node_id":"node-a"}));
        let mut other = source("other", "run");
        other.role = "actor".into();
        let initial = json!({
            "progress":{"loss":0.5}, "reward":0.2,
            "throughput":{"tokens_per_second":100},
            "pipeline":{"queue_depth":8}, "metrics":{"cpu/percent":30},
            "memory":{"used_bytes":1024}, "schema_version":1,
            "collector":{"latency_ns":20}, "worker_id":99, "unknown":4
        });
        store
            .ingest(
                &learner,
                &descriptor(&learner, "session"),
                &page(vec![
                    snapshot(0, initial),
                    snapshot(1, json!({"progress":{},"reward":false})),
                ]),
            )
            .unwrap();
        store
            .ingest(
                &other,
                &descriptor(&other, "session"),
                &page(vec![snapshot(0, json!({"progress":{"loss":0.7}}))]),
            )
            .unwrap();
        let request = ChartCatalogRequest {
            run_ids: vec!["run".into(), "empty".into()],
        };
        let catalog = store
            .catalog(&request, &[learner.clone(), other.clone()])
            .unwrap();
        assert_eq!(catalog.defaults.len(), 6);
        assert!(!catalog.defaults.iter().any(|p| p.contains("collector")
            || p.contains("id")
            || p.contains("schema")
            || p == "/unknown"));
        let metric = |path: &str| catalog.metrics.iter().find(|m| m.path == path).unwrap();
        assert_eq!(metric("/progress/loss").name, "Loss");
        assert_eq!(metric("/progress/loss").group, ChartGroup::Training);
        assert_eq!(metric("/progress/loss").unit, None);
        assert!(metric("/progress/loss").sources.iter().all(|s| !s.primary));
        assert_eq!(metric("/progress/loss").sources[0].rank, Some(3));
        assert_eq!(
            metric("/progress/loss").sources[0].node_id.as_deref(),
            Some("node-a")
        );
        assert_eq!(metric("/progress/loss").sources[0].latest_value, None);
        assert!(metric("/reward").sources[0].primary);
        assert_eq!(metric("/reward").sources[0].latest_value, None);
        assert_eq!(metric("/metrics/cpu~1percent").unit.as_deref(), Some("%"));
        assert_eq!(
            metric("/throughput/tokens_per_second").unit.as_deref(),
            Some("tokens/s")
        );
        assert_eq!(metric("/unknown").unit, None);
        let empty = catalog.runs.iter().find(|r| r.run_id == "empty").unwrap();
        assert_eq!(empty.snapshot_count, 0);
        assert_eq!(empty.first_observed_at_ns, None);
        learner.descriptor.as_mut().unwrap()["labels"] = json!({"rvx.primary":"true"});
        let catalog = store
            .catalog(&request, &[learner.clone(), other.clone()])
            .unwrap();
        let loss = catalog
            .metrics
            .iter()
            .find(|m| m.path == "/progress/loss")
            .unwrap();
        assert!(loss.sources[0].primary);
        assert!(!loss.sources[1].primary);
        other.descriptor = Some(json!({"labels":{"rvx.primary":"true"}}));
        let catalog = store.catalog(&request, &[learner, other]).unwrap();
        assert!(catalog
            .metrics
            .iter()
            .find(|m| m.path == "/progress/loss")
            .unwrap()
            .sources
            .iter()
            .all(|s| !s.primary));
    }

    #[test]
    fn live_resource_shapes_prefer_utilization_and_keep_device_and_queue_names() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        let mut source = source("source", "run");
        source.role = "hostmon".into();
        let names = [
            "cpu/cores",
            "cpu/load1",
            "cpu/percent",
            "disk/percent",
            "disk/root/free_bytes",
            "disk/root/total_bytes",
            "disk/root/used_bytes",
            "gpu/0/percent",
            "gpu/0/memory_percent",
            "gpu/0/memory_total_bytes",
            "gpu/0/memory_used_bytes",
            "gpu/0/power_watts",
            "gpu/0/temperature_c",
            "gpu/count",
            "gpu/percent",
            "gpu/memory_percent",
            "memory/percent",
            "memory/available_bytes",
            "memory/total_bytes",
            "memory/used_bytes",
            "network/rx_mbps",
            "network/tx_mbps",
            "network/interface_count",
            "cluster_gpu/queue/training/allocated_cpus",
            "cluster_gpu/queue/training/allocated_gpus",
            "cluster_gpu/queue/training/capacity_cpus",
            "cluster_gpu/queue/training/capacity_gpus",
            "cluster_gpu/queue/training/pending_gpus",
            "cluster_gpu/queue/evaluation/pending_gpus",
            "cluster_gpu/running_gpus",
            "cluster_gpu/pending_gpus",
            "pressure/memory/some/avg10",
            "monitor/latency_ms",
            "monitor/cpu/percent",
        ];
        let metrics: serde_json::Map<String, Value> = names
            .iter()
            .map(|name| ((*name).into(), json!(0.5)))
            .collect();
        store
            .ingest(
                &source,
                &descriptor(&source, "session"),
                &page(vec![snapshot(0, json!({"metrics":metrics}))]),
            )
            .unwrap();
        let catalog = store
            .catalog(
                &ChartCatalogRequest {
                    run_ids: vec!["run".into()],
                },
                &[source],
            )
            .unwrap();
        assert_eq!(catalog.metrics.len(), names.len());
        assert_eq!(
            catalog.defaults,
            vec![
                "/metrics/network~1rx_mbps",
                "/metrics/cluster_gpu~1pending_gpus",
                "/metrics/cpu~1percent",
                "/metrics/network~1tx_mbps",
                "/metrics/gpu~1percent",
                "/metrics/memory~1percent",
            ]
        );
        let metric = |name: &str| {
            catalog
                .metrics
                .iter()
                .find(|metric| metric.path == format!("/metrics/{}", name.replace('/', "~1")))
                .unwrap()
        };
        for (path, label) in [
            ("gpu/0/percent", "GPU 0 Percent"),
            ("gpu/percent", "GPU Percent"),
            ("gpu/0/memory_percent", "GPU 0 Memory Percent"),
            ("disk/root/used_bytes", "Disk Root Used Bytes"),
            ("network/rx_mbps", "Network RX Mbps"),
            (
                "cluster_gpu/queue/training/pending_gpus",
                "Cluster GPU Queue Training Pending GPUs",
            ),
            (
                "cluster_gpu/queue/evaluation/pending_gpus",
                "Cluster GPU Queue Evaluation Pending GPUs",
            ),
        ] {
            assert_eq!(metric(path).name, label);
        }
        assert_eq!(metric("network/rx_mbps").group, ChartGroup::Throughput);
        assert_eq!(metric("network/rx_mbps").unit.as_deref(), Some("Mbps"));
        assert_eq!(metric("gpu/0/power_watts").unit.as_deref(), Some("W"));
        assert_eq!(metric("gpu/0/temperature_c").unit.as_deref(), Some("°C"));
        assert_eq!(metric("pressure/memory/some/avg10").unit, None);
        assert_eq!(metric("cpu/load1").unit, None);
        assert_eq!(
            metric("cluster_gpu/queue/training/capacity_cpus").unit,
            None
        );
    }

    #[test]
    fn elapsed_uses_each_runs_first_observation_across_sources_and_checks_overflow() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        for (id, run, times) in [
            ("a", "run-a", [100, 200]),
            ("b", "run-a", [50, 70]),
            ("c", "run-b", [-100, -80]),
            ("d", "overflow", [i64::MIN, i64::MAX]),
        ] {
            let source = source(id, run);
            let snapshots = times
                .into_iter()
                .enumerate()
                .map(|(sequence, time)| {
                    let mut snapshot = snapshot(sequence as u64, json!({"loss":1}));
                    snapshot.observed_at_ns = time;
                    snapshot
                })
                .collect();
            store
                .ingest(&source, &descriptor(&source, "session"), &page(snapshots))
                .unwrap();
        }
        let mut request = query("run-a", &["/loss"]);
        request.run_ids.push("run-b".into());
        request.source_ids = vec!["a".into(), "c".into()];
        request.axis = "elapsed".into();
        let result = store.query(&request).unwrap();
        assert_eq!(result.series[0].axes, vec![50, 150]);
        assert_eq!(result.series[1].axes, vec![0, 20]);
        request.from = Some(20);
        request.to = Some(50);
        let result = store.query(&request).unwrap();
        assert_eq!(result.series[0].axes, vec![50]);
        assert_eq!(result.series[1].axes, vec![20]);
        let request = SnapshotQueryRequest {
            axis: "elapsed".into(),
            ..query("overflow", &["/loss"])
        };
        assert!(store
            .query(&request)
            .unwrap_err()
            .to_string()
            .contains("overflows"));
    }

    #[test]
    fn index_queries_never_decode_state_and_missing_runs_do_not_invent_traces() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        let a = source("a", "run-a");
        let b = source("b", "run-b");
        store
            .ingest(
                &a,
                &descriptor(&a, "session"),
                &page(vec![snapshot(0, json!({"loss":2}))]),
            )
            .unwrap();
        store
            .ingest(
                &b,
                &descriptor(&b, "session"),
                &page(vec![snapshot(0, json!({
                    "queue":{"ready":1},
                    "documents": (0..300).map(|i| (format!("id{i}"),json!({"value":i}))).collect::<serde_json::Map<String,Value>>()
                }))]),
            )
            .unwrap();
        // Deliberately invalidate raw JSON in this isolated fixture: a projection or
        // catalog that accidentally reads state history will now fail to deserialize.
        store
            .connection
            .lock()
            .execute("UPDATE snapshots SET snapshot_json='not json'", [])
            .unwrap();
        let request = SnapshotQueryRequest {
            run_ids: vec!["run-a".into(), "run-b".into()],
            ..query("run-a", &["/loss"])
        };
        let result = store.query(&request).unwrap();
        assert_eq!(result.series.len(), 1);
        assert_eq!(result.series[0].run_id, "run-a");
        let catalog = store
            .catalog(
                &ChartCatalogRequest {
                    run_ids: request.run_ids,
                },
                &[a, b],
            )
            .unwrap();
        assert_eq!(catalog.metrics.len(), 2);
        assert!(store.get(1).is_err());
    }

    #[test]
    fn bounded_discovery_excludes_arrays_and_documents_but_keeps_known_nulls() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        let source = source("source", "run");
        let documents: serde_json::Map<String, Value> = (0..300)
            .map(|i| (format!("id{i}"), json!({"value":i})))
            .collect();
        store
            .ingest(
                &source,
                &descriptor(&source, "session"),
                &page(vec![
                    snapshot(
                        0,
                        json!({"loss":1,"documents":documents,"workers":[{"rank":0,"load":1}]}),
                    ),
                    snapshot(1, json!({"documents":documents,"workers":[]})),
                ]),
            )
            .unwrap();
        let catalog = store
            .catalog(
                &ChartCatalogRequest {
                    run_ids: vec!["run".into()],
                },
                std::slice::from_ref(&source),
            )
            .unwrap();
        assert!(catalog.truncated);
        assert_eq!(catalog.metrics.len(), 1);
        assert!(catalog.metrics[0].sources[0].primary);
        assert_eq!(catalog.metrics[0].sources[0].latest_value, None);
        assert_eq!(
            store.query(&query("run", &["/loss"])).unwrap().series[0].values,
            vec![Some(1.0), None]
        );
        for path in ["/documents/id0/value", "/workers/0/load", "/never_numeric"] {
            assert!(store.query(&query("run", &[path])).is_err());
        }
        assert_eq!(
            store.get(1).unwrap().snapshot.state["documents"]
                .as_object()
                .unwrap()
                .len(),
            300
        );
        store
            .ingest(
                &source,
                &descriptor(&source, "session"),
                &page(vec![snapshot(2, json!({"documents":{"id0":{"value":0}}}))]),
            )
            .unwrap();
        assert!(store
            .query(&query("run", &["/documents/id0/value"]))
            .unwrap_err()
            .to_string()
            .contains("coverage"));
        let mut request = query("run", &["/documents/id0/value"]);
        request.from = Some(20);
        assert_eq!(
            store.query(&request).unwrap().series[0].values,
            vec![Some(0.0)]
        );
    }

    #[test]
    fn numeric_index_cardinality_is_bounded_over_the_source_lifetime() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        let source = source("source", "run");
        let groups: serde_json::Map<String, Value> = (0..32)
            .map(|group| {
                let values: serde_json::Map<String, Value> = (0..128)
                    .map(|field| (format!("f{field}"), json!(field)))
                    .collect();
                (format!("group{group}"), Value::Object(values))
            })
            .collect();
        store
            .ingest(
                &source,
                &descriptor(&source, "session"),
                &page(vec![
                    snapshot(0, Value::Object(groups)),
                    snapshot(1, json!({"new_numeric_field":42,"group0":{"f0":true}})),
                ]),
            )
            .unwrap();
        let count: usize = store
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM chart_fields", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, crate::chart_index::MAX_SOURCE_FIELDS);
        let count: usize = store
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM chart_values", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, crate::chart_index::MAX_SOURCE_FIELDS);
        let catalog = store
            .catalog(
                &ChartCatalogRequest {
                    run_ids: vec!["run".into()],
                },
                &[source],
            )
            .unwrap();
        assert!(catalog.truncated);
        assert!(catalog.defaults.is_empty());
        assert!(catalog
            .metrics
            .iter()
            .all(|metric| metric.sources[0].latest_value.is_none()));
        assert_eq!(
            store.query(&query("run", &["/group0/f0"])).unwrap().series[0].values,
            vec![Some(0.0), None]
        );
        assert!(store.query(&query("run", &["/new_numeric_field"])).is_err());
        assert_eq!(
            store.get(2).unwrap().snapshot.state["new_numeric_field"],
            42
        );
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
    fn observation_scan_budget_is_explicit_and_elapsed_ranges_use_the_index() {
        let dir = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&dir.path().join("snapshots.db")).unwrap();
        let source = source("source", "run");
        store
            .ingest(
                &source,
                &descriptor(&source, "session"),
                &page(vec![snapshot(0, json!({"loss":1}))]),
            )
            .unwrap();
        let connection = store.connection.lock();
        connection.execute_batch(&format!(
            "WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<{MAX_QUERY_SCAN_ROWS})
             INSERT INTO snapshots(run_id,source_id,source_session_id,sequence,observed_at_ns,ingested_at_ns,snapshot_json)
             SELECT 'run','source','session',n,n,0,
                '{{\"source_session_id\":\"session\",\"sequence\":'||n||',\"observed_at_ns\":'||n||',\"schema_version\":1,\"axes\":{{}},\"state\":{{}}}}'
             FROM sequence;
             INSERT INTO chart_observations SELECT id,0,'[]' FROM snapshots WHERE id>1;
             UPDATE chart_runs SET snapshot_count={count},last_observed_at_ns={MAX_QUERY_SCAN_ROWS};
             UPDATE chart_index_meta SET last_id={count};
             UPDATE snapshot_heads SET snapshot_id={count};
             UPDATE snapshot_cursors SET next_sequence={count};",
            count=MAX_QUERY_SCAN_ROWS+1
        )).unwrap();
        drop(connection);
        let mut request = query("run", &["/loss"]);
        assert!(store
            .query(&request)
            .unwrap_err()
            .to_string()
            .contains("scan budget"));
        request.from = Some(MAX_QUERY_SCAN_ROWS as i64 - 9);
        for axis in ["wall_time", "elapsed"] {
            request.axis = axis.into();
            let result = store.query(&request).unwrap();
            assert_eq!(result.series[0].values, vec![None; 10]);
            assert_eq!(
                result.series[0].snapshot_ids.last(),
                Some(&((MAX_QUERY_SCAN_ROWS + 1) as i64))
            );
        }
        request.axis = "step".into();
        assert!(store
            .query(&request)
            .unwrap_err()
            .to_string()
            .contains("scan budget"));
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
