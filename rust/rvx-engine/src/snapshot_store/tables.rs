//! Bounded, snapshot-owned table reads. Never reconstruct state from chart samples.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Number, Value};

use super::*;

const MAX_TABLE_NODES: usize = 1_000_000;
const MAX_TABLE_SCAN_BYTES: usize = 64 * 1024 * 1024;
const MAX_TABLES: usize = 256;
const MAX_COLUMNS: usize = 128;
const MAX_CATALOG_NODES: usize = 50_000;
const MAX_WRAPPER_MEMBERS: usize = 32;
const MAX_CELL_BYTES: usize = 1024;
const MAX_TEXT_WORK: usize = 64 * 1024 * 1024;

mod scan;
#[cfg(test)]
mod tests;
mod views;

/// Per-request cooperative cancellation; it never interrupts another owner's SQLite operation.
#[derive(Clone)]
pub struct TableReadControl {
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

impl Default for TableReadControl {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + Duration::from_secs(30),
        }
    }
}

impl TableReadControl {
    /// Stop this read at its next bounded work checkpoint, without affecting ingestion or other reads.
    pub fn cancel(&self) {
        self.cancelled.store(true, AtomicOrdering::Relaxed);
    }

    pub(crate) fn check(&self) -> Result<()> {
        if self.cancelled.load(AtomicOrdering::Relaxed) {
            return invalid("table read cancelled");
        }
        if Instant::now() >= self.deadline {
            return invalid("table read exceeded 30 seconds; narrow run/source/field selection");
        }
        Ok(())
    }
}

/// Reject ambiguous or unbounded selection before querying registration metadata.
pub(crate) fn validate_selection(runs: &[String], sources: &[String]) -> Result<()> {
    unique_ids(runs, MAX_SNAPSHOT_QUERY_RUNS)?;
    unique_ids(sources, MAX_SNAPSHOT_SOURCE_IDS)?;
    if runs.is_empty() {
        return invalid("tables require 1..64 run_ids");
    }
    Ok(())
}

fn unique_ids(ids: &[String], maximum: usize) -> Result<()> {
    check_ids(ids, maximum)?;
    if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return invalid("duplicate identifiers are not allowed");
    }
    Ok(())
}

impl SnapshotStore {
    /// Summarize every covered finite index value, retaining missing observations and Source identity.
    pub(crate) fn table_summary(
        &self,
        request: &TableSummaryRequest,
        sources: &[Source],
        control: &TableReadControl,
    ) -> Result<TableSummaryResponse> {
        let query = SnapshotQueryRequest {
            run_ids: request.run_ids.clone(),
            source_ids: request.source_ids.clone(),
            paths: request.paths.clone(),
            axis: request.axis.clone(),
            from: request.from,
            to: request.to,
            max_points: 1,
        };
        let Projection { known, groups } = self.projection(&query, || control.check())?;
        let mut response = TableSummaryResponse {
            axis: request.axis.clone(),
            rows: Vec::new(),
        };
        for source in sources {
            let points = groups
                .get(&(source.run_id.clone(), source.id.clone()))
                .map(Vec::as_slice)
                .unwrap_or_default();
            for (index, path) in request.paths.iter().enumerate() {
                control.check()?;
                let first = known.get(&(source.run_id.clone(), source.id.clone(), path.clone()));
                if points.iter().any(|point| {
                    point.excludes(path)
                        && first.map_or(true, |first| point.id < *first)
                        && point.values[index].is_none()
                }) {
                    return invalid("summary field index coverage is incomplete; narrow source/time/field selection");
                }
                let mut values: Vec<_> = points.iter().filter_map(|p| p.values[index]).collect();
                values.sort_unstable_by(f64::total_cmp);
                let count = values.len();
                let latest = points.last();
                response.rows.push(TableSummaryRow {
                    run_id: source.run_id.clone(),
                    source_id: source.id.clone(),
                    path: path.clone(),
                    observations: points.len(),
                    count,
                    missing: points.len() - count,
                    current: latest.and_then(|p| p.values[index]),
                    minimum: values.first().copied(),
                    average: mean(&values),
                    p95: (count > 0).then(|| values[(95 * count).div_ceil(100) - 1]),
                    maximum: values.last().copied(),
                    snapshot_id: latest.map(|p| p.id.to_string()),
                    observed_at_ns: latest.map(|p| p.observed),
                });
            }
        }
        bounded_response(&response)?;
        Ok(response)
    }

    /// Discover bounded collection paths in complete current snapshots, stopping inside record rows.
    pub(crate) fn table_catalog(
        &self,
        sources: &[Source],
        control: &TableReadControl,
    ) -> Result<TableCatalogResponse> {
        let snapshots = self.table_snapshots(sources, None, false, control)?;
        let mut discovery = Discovery::default();
        for snapshot in &snapshots {
            control.check()?;
            discovery.visit("", &snapshot.snapshot.state, control)?;
        }
        let mut response = TableCatalogResponse {
            tables: Vec::new(),
            truncated: discovery.truncated,
        };
        let mut bytes = PAGE_ENVELOPE_RESERVE;
        for mut table in discovery.tables.into_values() {
            control.check()?;
            table.sources.clear();
            let mut table_bytes = serde_json::to_vec(&table)?.len();
            for snapshot in &snapshots {
                control.check()?;
                if let Some(count) = collection_len(snapshot.snapshot.state.pointer(&table.path)) {
                    let source = table_source(snapshot, sources, count);
                    table_bytes += serde_json::to_vec(&source)?.len() + 1;
                    if bytes + table_bytes > MAX_SNAPSHOT_PAGE_BYTES {
                        break;
                    }
                    table.sources.push(source);
                }
            }
            if bytes + table_bytes > MAX_SNAPSHOT_PAGE_BYTES {
                response.truncated = true;
                break;
            }
            bytes += table_bytes + 1;
            response.tables.push(table);
        }
        bounded_response(&response)?;
        Ok(response)
    }

    /// Evaluate full selected collections before paging; immutable snapshot IDs pin subsequent reads.
    pub(crate) fn table_rows(
        &self,
        request: &TableRowsRequest,
        sources: &[Source],
        control: &TableReadControl,
    ) -> Result<TableRowsResponse> {
        validate_rows(request)?;
        let snapshots =
            self.table_snapshots(sources, request.snapshot_ids.as_deref(), true, control)?;
        let mut scanned = scan::records(&snapshots, request, sources, scan::Mode::Rows, control)?;
        let page = Self::table_page_order(&scanned.rows, request, &mut scanned.budget, control)?;
        scan::render(
            &scanned.rows,
            &scanned.columns,
            scanned.snapshots,
            request.offset,
            request.limit,
            &page,
            control,
        )
    }

    /// Return page identities without changing the records that own keys and snapshot provenance.
    fn table_page_order(
        rows: &[Record<'_>],
        request: &TableRowsRequest,
        budget: &mut WorkBudget,
        control: &TableReadControl,
    ) -> Result<Vec<usize>> {
        control.check()?;
        let start = request.offset.min(rows.len());
        let end = start.saturating_add(request.limit).min(rows.len());
        let Some(sort) = &request.sort else {
            // Snapshot loading orders Sources, collection iteration orders positions, and filters retain both.
            return Ok((start..end).collect());
        };
        let levels = if rows.is_empty() {
            0
        } else {
            rows.len().ilog2() as usize + 1
        };
        let mut keyed = Vec::with_capacity(rows.len());
        for (index, row) in rows.iter().enumerate() {
            control.check()?;
            let cell = row.cell(&sort.path);
            let bytes = match cell {
                Cell::Key(s) => s.len(),
                Cell::Value(Value::String(s)) => s.len(),
                Cell::Value(Value::Number(n)) => n.as_str().len(),
                _ => 0,
            };
            budget.text(bytes.saturating_mul(2 * levels + 2))?;
            keyed.push((index, SortKey::new(cell)));
        }
        if start == end {
            return Ok(Vec::new());
        }
        let compare = |a: &(usize, SortKey<'_>), b: &(usize, SortKey<'_>)| {
            let order = a.1.compare(&b.1);
            let order = if sort.direction == TableSortDirection::Desc {
                order.reverse()
            } else {
                order
            };
            let (a, b) = (&rows[a.0], &rows[b.0]);
            order.then_with(|| {
                (&a.snapshot.run_id, &a.snapshot.source_id, a.position).cmp(&(
                    &b.snapshot.run_id,
                    &b.snapshot.source_id,
                    b.position,
                ))
            })
        };
        let page = select_page(&mut keyed, request.offset, request.limit, compare, control)?;
        Ok(keyed[page].iter().map(|(index, _)| *index).collect())
    }

    fn table_snapshots(
        &self,
        sources: &[Source],
        pinned: Option<&[String]>,
        require_all: bool,
        control: &TableReadControl,
    ) -> Result<Vec<StoredSnapshot>> {
        control.check()?;
        let mut ids = Vec::new();
        if let Some(pinned) = pinned {
            unique_ids(pinned, MAX_SNAPSHOT_SOURCE_IDS)?;
            if pinned.is_empty() {
                return invalid("snapshot_ids must be nonempty when supplied");
            }
            for id in pinned {
                let number = id
                    .parse::<i64>()
                    .ok()
                    .filter(|n| *n > 0 && n.to_string() == *id)
                    .ok_or_else(|| {
                        EngineError::InvalidInput(
                            "snapshot_ids must be canonical positive decimal strings".into(),
                        )
                    })?;
                ids.push(number);
            }
        }
        // Reuse the single SnapshotStore owner, not a second Engine or independent SQLite reader.
        let connection = self.connection.lock();
        control.check()?;
        if pinned.is_none() {
            let mut heads = connection.prepare_cached(
                "SELECT snapshot_id FROM snapshot_heads WHERE run_id=? AND source_id=?",
            )?;
            for source in sources {
                control.check()?;
                let id: Option<i64> = heads
                    .query_row(params![source.run_id, source.id], |r| r.get(0))
                    .optional()?;
                if let Some(id) = id {
                    ids.push(id);
                } else if require_all {
                    return invalid(&format!("Source {:?} has no completed snapshot", source.id));
                }
            }
        }
        let mut metadata = connection.prepare_cached(
            "SELECT run_id,source_id,length(CAST(snapshot_json AS BLOB)) FROM snapshots WHERE id=?",
        )?;
        let mut load =
            connection.prepare_cached(&format!("SELECT {COLUMNS} FROM snapshots WHERE id=?"))?;
        let mut result = Vec::new();
        let mut bytes = 0;
        let mut nodes = WorkBudget::default();
        let mut seen = BTreeSet::new();
        for id in ids {
            control.check()?;
            let info: Option<(String, String, usize)> = metadata
                .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?;
            let (run, source, length) =
                info.ok_or_else(|| EngineError::InvalidInput(format!("unknown snapshot ID {id}")))?;
            if !sources.iter().any(|s| s.id == source && s.run_id == run) {
                return invalid(&format!(
                    "snapshot {id} does not belong to selected run_ids/source_ids"
                ));
            }
            if !seen.insert(source) {
                return invalid(
                    "snapshot_ids must contain exactly one snapshot per selected Source",
                );
            }
            bytes += length;
            if bytes > MAX_TABLE_SCAN_BYTES {
                return invalid("table snapshot scan exceeds 64 MiB; narrow run_ids/source_ids");
            }
            let mut loaded = load.query([id])?;
            let snapshot = from_row(loaded.next()?.unwrap())?;
            nodes.tree(&snapshot.snapshot.state, control)?;
            result.push(snapshot);
        }
        if require_all && (result.is_empty() || seen.len() != sources.len()) {
            return invalid("table rows require one completed snapshot for every selected Source; select source_ids explicitly");
        }
        result.sort_by(|a, b| (&a.run_id, &a.source_id).cmp(&(&b.run_id, &b.source_id)));
        Ok(result)
    }
}

fn mean(values: &[f64]) -> Option<f64> {
    let scale = values.iter().fold(0.0_f64, |a, b| a.max(b.abs()));
    if values.is_empty() {
        return None;
    }
    if scale == 0.0 {
        return Some(0.0);
    }
    let (mut sum, mut correction) = (0.0, 0.0);
    for value in values {
        let term = value / scale - correction;
        let next = sum + term;
        correction = (next - sum) - term;
        sum = next;
    }
    Some((sum / values.len() as f64).clamp(-1.0, 1.0) * scale)
}

fn bounded_response(value: &impl Serialize) -> Result<()> {
    json_size(value).map(|_| ())
}

/// Isolate a global page in linear work, sorting only the returned window with deterministic ties.
fn select_page<T>(
    entries: &mut [T],
    offset: usize,
    limit: usize,
    compare: impl Fn(&T, &T) -> Ordering + Copy,
    control: &TableReadControl,
) -> Result<std::ops::Range<usize>> {
    control.check()?;
    let start = offset.min(entries.len());
    let end = start.saturating_add(limit).min(entries.len());
    if start == end {
        return Ok(start..end);
    }
    if end < entries.len() {
        entries.select_nth_unstable_by(end, compare);
        control.check()?;
    }
    if start > 0 {
        entries[..end].select_nth_unstable_by(start, compare);
        control.check()?;
    }
    entries[start..end].sort_unstable_by(compare);
    control.check()?;
    Ok(start..end)
}

/// Enforce serialized response bounds without first allocating an oversized output buffer.
fn json_size(value: &impl Serialize) -> Result<usize> {
    struct Counter {
        bytes: usize,
        exceeded: bool,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes = self.bytes.saturating_add(bytes.len());
            if self.bytes > MAX_SNAPSHOT_PAGE_BYTES {
                self.exceeded = true;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "response size limit",
                ));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        bytes: 0,
        exceeded: false,
    };
    let result = serde_json::to_writer(&mut counter, value);
    if counter.exceeded {
        return invalid("table response exceeds 16 MiB; narrow selection");
    }
    result?;
    Ok(counter.bytes)
}

fn validate_rows(request: &TableRowsRequest) -> Result<()> {
    validate_rows_limit(request, MAX_SNAPSHOT_HISTORY_LIMIT)
}

fn validate_rows_limit(request: &TableRowsRequest, maximum: usize) -> Result<()> {
    validate_snapshot_pointer(&request.path)?;
    if request.limit == 0 || request.limit > maximum {
        return invalid(&format!("table limit must be 1..{maximum}"));
    }
    if request.offset > MAX_TABLE_NODES {
        return invalid("table offset must be at most 1000000");
    }
    if let Some(columns) = &request.columns {
        if columns.is_empty() || columns.len() > MAX_COLUMNS {
            return invalid("columns must contain 1..128 column pointers");
        }
        if columns.iter().collect::<BTreeSet<_>>().len() != columns.len() {
            return invalid("duplicate columns are not allowed");
        }
        for path in columns {
            validate_column(path)?;
        }
    }
    if request.filters.len() > 32 {
        return invalid("at most 32 table filters are supported");
    }
    for filter in &request.filters {
        validate_column(&filter.path)?;
        if filter.value.len() > 4096 {
            return invalid("table filter value exceeds 4096 bytes");
        }
    }
    if let Some(sort) = &request.sort {
        validate_column(&sort.path)?;
    }
    if request.search.as_ref().is_some_and(|s| s.len() > 4096) {
        return invalid("table search exceeds 4096 bytes");
    }
    Ok(())
}

fn validate_column(path: &str) -> Result<()> {
    if path == "$key" || path == "$value" {
        return Ok(());
    }
    validate_snapshot_pointer(path)?;
    Ok(())
}

#[derive(Default)]
struct WorkBudget {
    nodes: usize,
    text_bytes: usize,
}

impl WorkBudget {
    fn visit(&mut self, control: &TableReadControl) -> Result<()> {
        control.check()?;
        self.nodes += 1;
        if self.nodes > MAX_TABLE_NODES {
            return invalid(
                "table scan exceeds 1000000 visited nodes; narrow Sources/columns/filters",
            );
        }
        Ok(())
    }

    fn text(&mut self, bytes: usize) -> Result<()> {
        self.text_bytes += bytes;
        if self.text_bytes > MAX_TEXT_WORK {
            return invalid("table search/filter/sort exceeds 64 MiB of text work; narrow Sources/filters or sort by a shorter column");
        }
        Ok(())
    }

    fn tree(&mut self, value: &Value, control: &TableReadControl) -> Result<()> {
        self.visit(control)?;
        match value {
            Value::Array(values) => {
                for value in values {
                    self.tree(value, control)?;
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    self.tree(value, control)?;
                }
            }
            _ => (),
        }
        Ok(())
    }
}

fn escape(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn column(path: &str) -> TableColumn {
    TableColumn {
        path: path.into(),
        name: match path {
            "$key" => "Key".into(),
            "$value" => "Value".into(),
            "" => "Row".into(),
            _ => path
                .trim_start_matches('/')
                .replace("~1", "/")
                .replace("~0", "~"),
        },
        kinds: None,
    }
}

fn table_source(snapshot: &StoredSnapshot, sources: &[Source], count: usize) -> TableSource {
    let source = sources.iter().find(|s| s.id == snapshot.source_id).unwrap();
    let descriptor = source.descriptor.as_ref();
    let rank = descriptor
        .and_then(|d| d.get("rank"))
        .and_then(Value::as_i64)
        .or(source.rank);
    let node_id = descriptor
        .and_then(|d| d.get("node_id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| source.node_id.clone());
    let label = descriptor
        .and_then(|d| d.pointer("/labels/name"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let mut label = source.role.clone();
            if let Some(rank) = rank {
                label.push_str(&format!(" · rank {rank}"));
            }
            if let Some(node) = &node_id {
                label.push_str(&format!(" · {node}"));
            }
            label
        });
    TableSource {
        run_id: snapshot.run_id.clone(),
        source_id: source.id.clone(),
        label,
        role: source.role.clone(),
        rank,
        node_id,
        snapshot_id: snapshot.id.to_string(),
        observed_at_ns: snapshot.snapshot.observed_at_ns,
        row_count: count,
    }
}

fn collection_len(value: Option<&Value>) -> Option<usize> {
    match value {
        Some(Value::Array(a)) => Some(a.len()),
        Some(Value::Object(o)) => Some(o.len()),
        _ => None,
    }
}

fn collection(value: &Value) -> Box<dyn Iterator<Item = (String, &Value)> + '_> {
    match value {
        Value::Array(values) => {
            Box::new(values.iter().enumerate().map(|(i, v)| (i.to_string(), v)))
        }
        Value::Object(values) => Box::new(values.iter().map(|(k, v)| (k.clone(), v))),
        _ => Box::new(std::iter::empty()),
    }
}

fn row_columns(
    value: &Value,
    columns: &mut BTreeSet<String>,
    cap: usize,
    truncate: bool,
) -> Result<bool> {
    let mut truncated = false;
    let candidates: Box<dyn Iterator<Item = String> + '_> = match value {
        Value::Object(object) => Box::new(object.keys().map(|key| format!("/{}", escape(key)))),
        _ => Box::new(std::iter::once("$value".into())),
    };
    for path in candidates {
        if path.len() > 4096 || (!columns.contains(&path) && columns.len() >= cap) {
            if !truncate {
                return invalid("table schema exceeds 128 columns or 4096-byte pointers; select a narrower collection");
            }
            truncated = true;
            continue;
        }
        columns.insert(path);
    }
    Ok(truncated)
}

#[derive(Default)]
struct Discovery {
    tables: BTreeMap<String, TableDefinition>,
    hints: BTreeMap<String, CatalogHints>,
    nodes: usize,
    truncated: bool,
}

#[derive(Default)]
struct CatalogHints {
    rows: usize,
    fields: BTreeMap<String, (usize, BTreeSet<TableCellKind>)>,
}

impl Discovery {
    fn visit(&mut self, path: &str, value: &Value, control: &TableReadControl) -> Result<()> {
        control.check()?;
        self.nodes += 1;
        if self.nodes > MAX_CATALOG_NODES || path.len() > 4096 {
            self.truncated = true;
            return Ok(());
        }
        let Some(_) = collection_len(Some(value)) else {
            return Ok(());
        };
        if !self.tables.contains_key(path) && self.tables.len() >= MAX_TABLES {
            self.truncated = true;
            return Ok(());
        }
        let table = self
            .tables
            .entry(path.into())
            .or_insert_with(|| TableDefinition {
                path: path.into(),
                name: if path.is_empty() {
                    "Root".into()
                } else {
                    column(path).name
                },
                columns: Vec::new(),
                sources: Vec::new(),
                collection_kinds: Some(Vec::new()),
            });
        let kind = if value.is_array() {
            TableCollectionKind::Array
        } else {
            TableCollectionKind::Object
        };
        let collection_kinds = table.collection_kinds.as_mut().unwrap();
        if !collection_kinds.contains(&kind) {
            collection_kinds.push(kind);
            collection_kinds.sort();
        }
        let hints = self.hints.entry(path.into()).or_default();
        hints
            .fields
            .entry("$key".into())
            .or_insert((0, BTreeSet::from([TableCellKind::String])));
        for (_, row) in collection(value) {
            control.check()?;
            self.nodes += 1;
            if self.nodes > MAX_CATALOG_NODES {
                self.truncated = true;
                break;
            }
            let fields: Box<dyn Iterator<Item = (String, &Value)> + '_> = match row {
                Value::Object(object) => Box::new(
                    object
                        .iter()
                        .map(|(key, value)| (format!("/{}", escape(key)), value)),
                ),
                _ => Box::new(std::iter::once(("$value".to_owned(), row))),
            };
            let mut complete = true;
            for (field, value) in fields {
                self.nodes += 1;
                if self.nodes > MAX_CATALOG_NODES {
                    self.truncated = true;
                    complete = false;
                    break;
                }
                if field.len() > 4096
                    || (!hints.fields.contains_key(&field) && hints.fields.len() >= MAX_COLUMNS)
                {
                    self.truncated = true;
                    continue;
                }
                let (present, kinds) = hints.fields.entry(field).or_default();
                *present += 1;
                kinds.insert(cell_kind(Cell::Value(value)));
            }
            if complete {
                hints.rows += 1;
                hints.fields.get_mut("$key").unwrap().0 += 1;
            } else {
                break;
            }
        }
        table.columns = hints
            .fields
            .iter()
            .map(|(path, (present, observed))| {
                let mut kinds = observed.clone();
                if *present < hints.rows {
                    kinds.insert(TableCellKind::Missing);
                }
                let mut column = column(path);
                column.kinds = Some(kinds.into_iter().collect());
                column
            })
            .collect();
        if self.nodes >= MAX_CATALOG_NODES {
            self.truncated = true;
            return Ok(());
        }
        if let Value::Object(object) = value {
            // Homogeneous record maps are rows, not thousands of separate table definitions.
            let records = if path.is_empty() {
                false
            } else {
                match is_record_map(object, &mut self.nodes, control)? {
                    Some(records) => records,
                    None => {
                        self.truncated = true;
                        return Ok(());
                    }
                }
            };
            if !records {
                for (key, child) in object {
                    if self.nodes >= MAX_CATALOG_NODES {
                        self.truncated = true;
                        break;
                    }
                    self.visit(&format!("{path}/{}", escape(key)), child, control)?;
                }
            }
        }
        Ok(())
    }
}

fn is_record_map(
    object: &serde_json::Map<String, Value>,
    nodes: &mut usize,
    control: &TableReadControl,
) -> Result<Option<bool>> {
    if object.is_empty() {
        return Ok(Some(false));
    }
    // Small namespace maps can contain scalar metadata alongside structured documents.
    // Keep descending those wrappers, but never expand thousands of record identities.
    if object.len() <= MAX_WRAPPER_MEMBERS {
        for value in object.values() {
            if !catalog_visit(nodes, control)? {
                return Ok(None);
            }
            if let Value::Object(row) = value {
                for field in row.values() {
                    if !catalog_visit(nodes, control)? {
                        return Ok(None);
                    }
                    if let Value::Object(document) = field {
                        for value in document.values() {
                            if !catalog_visit(nodes, control)? {
                                return Ok(None);
                            }
                            if value.is_object() || value.is_array() {
                                return Ok(Some(false));
                            }
                        }
                    }
                }
            }
        }
    }
    let mut common: Option<BTreeSet<&str>> = None;
    for value in object.values() {
        if !catalog_visit(nodes, control)? {
            return Ok(None);
        }
        let Value::Object(row) = value else {
            return Ok(Some(false));
        };
        let mut keys = BTreeSet::new();
        for (key, value) in row {
            if !catalog_visit(nodes, control)? {
                return Ok(None);
            }
            if !value.is_object() && !value.is_array() {
                keys.insert(key.as_str());
            }
        }
        common = Some(match common {
            None => keys,
            Some(previous) => previous.intersection(&keys).copied().collect(),
        });
        if common.as_ref().is_some_and(BTreeSet::is_empty) {
            return Ok(Some(false));
        }
    }
    Ok(Some(true))
}

fn catalog_visit(nodes: &mut usize, control: &TableReadControl) -> Result<bool> {
    control.check()?;
    *nodes += 1;
    Ok(*nodes <= MAX_CATALOG_NODES)
}
struct Record<'a> {
    snapshot: &'a StoredSnapshot,
    key: String,
    // Preserve array order (2 before 10) and the object's stable key order for ties.
    position: usize,
    value: &'a Value,
}

#[derive(Clone, Copy)]
enum Cell<'a> {
    Missing,
    Key(&'a str),
    Value(&'a Value),
}

impl Record<'_> {
    fn cell<'a>(&'a self, path: &str) -> Cell<'a> {
        match path {
            "$key" => Cell::Key(&self.key),
            "$value" if !self.value.is_object() => Cell::Value(self.value),
            "$value" => Cell::Missing,
            _ => self.value.pointer(path).map_or(Cell::Missing, Cell::Value),
        }
    }
}

fn value_kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "missing",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn cell_kind(value: Cell<'_>) -> TableCellKind {
    match value {
        Cell::Missing => TableCellKind::Missing,
        Cell::Key(_) | Cell::Value(Value::String(_)) => TableCellKind::String,
        Cell::Value(Value::Null) => TableCellKind::Null,
        Cell::Value(Value::Bool(_)) => TableCellKind::Boolean,
        Cell::Value(Value::Number(_)) => TableCellKind::Number,
        Cell::Value(Value::Array(_)) => TableCellKind::Array,
        Cell::Value(Value::Object(_)) => TableCellKind::Object,
    }
}
fn preview(cell: Cell<'_>) -> TableCell {
    let string = match cell {
        Cell::Key(s) => Some(s),
        Cell::Value(Value::String(s)) => Some(s.as_str()),
        _ => None,
    };
    if let Some(text) = string {
        let mut end = text.len().min(MAX_CELL_BYTES);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        return TableCell {
            kind: TableCellKind::String,
            text: text[..end].to_string(),
            truncated: end != text.len(),
        };
    }
    let (kind, text, container) = match cell {
        Cell::Missing => (TableCellKind::Missing, String::new(), false),
        Cell::Key(_) | Cell::Value(Value::String(_)) => unreachable!(),
        Cell::Value(Value::Null) => (TableCellKind::Null, "null".into(), false),
        Cell::Value(Value::Bool(b)) => (TableCellKind::Boolean, b.to_string(), false),
        Cell::Value(Value::Number(n)) => (TableCellKind::Number, n.to_string(), false),
        Cell::Value(Value::Array(a)) => {
            (TableCellKind::Array, format!("[{} items]", a.len()), true)
        }
        Cell::Value(Value::Object(o)) => (
            TableCellKind::Object,
            format!("{{{} fields}}", o.len()),
            true,
        ),
    };
    let truncated = container || text.len() > MAX_CELL_BYTES;
    let mut end = text.len().min(MAX_CELL_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    TableCell {
        kind,
        text: text[..end].to_string(),
        truncated,
    }
}

enum SortKey<'a> {
    Missing,
    Null,
    Boolean(bool),
    Number(NumericKey<'a>),
    String(&'a str),
    Array(usize),
    Object(usize),
}

impl<'a> SortKey<'a> {
    /// Resolve each selected cell once, without flattening missing, null, or empty values.
    fn new(cell: Cell<'a>) -> Self {
        match cell {
            Cell::Missing => Self::Missing,
            Cell::Value(Value::Null) => Self::Null,
            Cell::Value(Value::Bool(value)) => Self::Boolean(*value),
            Cell::Value(Value::Number(value)) => Self::Number(NumericKey::new(value)),
            Cell::Key(value) => Self::String(value),
            Cell::Value(Value::String(value)) => Self::String(value),
            Cell::Value(Value::Array(value)) => Self::Array(value.len()),
            Cell::Value(Value::Object(value)) => Self::Object(value.len()),
        }
    }

    fn rank(&self) -> u8 {
        match self {
            Self::Missing => 0,
            Self::Null => 1,
            Self::Boolean(_) => 2,
            Self::Number(_) => 3,
            Self::String(_) => 4,
            Self::Array(_) => 5,
            Self::Object(_) => 6,
        }
    }

    fn compare(&self, other: &Self) -> Ordering {
        self.rank()
            .cmp(&other.rank())
            .then_with(|| match (self, other) {
                (Self::Boolean(a), Self::Boolean(b)) => a.cmp(b),
                (Self::Number(a), Self::Number(b)) => a.compare(b),
                (Self::String(a), Self::String(b)) => a.cmp(b),
                (Self::Array(a), Self::Array(b)) | (Self::Object(a), Self::Object(b)) => a.cmp(b),
                _ => Ordering::Equal,
            })
    }
}

struct NumericKey<'a> {
    integer: Option<i128>,
    negative: bool,
    magnitude: DecimalExponent,
    digits: &'a str,
}

impl<'a> NumericKey<'a> {
    /// Cache exact JSON decimal order, retaining an integer fast path without f64 rounding.
    fn new(number: &'a Number) -> Self {
        let integer = number
            .as_i64()
            .map(i128::from)
            .or_else(|| number.as_u64().map(i128::from));
        Self::from_token(number.as_str(), integer)
    }

    fn from_token(token: &'a str, integer: Option<i128>) -> Self {
        let negative = token.starts_with('-');
        let unsigned = token.strip_prefix('-').unwrap_or(token);
        let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
        let point = mantissa.find('.').unwrap_or(mantissa.len());
        let Some(first) = mantissa
            .bytes()
            .position(|byte| byte != b'0' && byte != b'.')
        else {
            return Self {
                integer: Some(0),
                negative: false,
                magnitude: DecimalExponent::Small(0),
                digits: "",
            };
        };
        let leading = first - usize::from(first > point);
        Self {
            integer,
            negative,
            magnitude: DecimalExponent::shifted(exponent, point as i64 - leading as i64),
            digits: &mantissa[first..],
        }
    }

    fn compare(&self, other: &Self) -> Ordering {
        if let (Some(a), Some(b)) = (self.integer, other.integer) {
            return a.cmp(&b);
        }
        if self.digits.is_empty() {
            return if other.digits.is_empty() {
                Ordering::Equal
            } else if other.negative {
                Ordering::Greater
            } else {
                Ordering::Less
            };
        }
        if other.digits.is_empty() {
            return if self.negative {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        if self.negative != other.negative {
            return if self.negative {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        let order = self.magnitude.compare(&other.magnitude).then_with(|| {
            let mut a = self.digits.bytes().filter(|byte| *byte != b'.');
            let mut b = other.digits.bytes().filter(|byte| *byte != b'.');
            loop {
                let (a, b) = (a.next(), b.next());
                if a.is_none() && b.is_none() {
                    break Ordering::Equal;
                }
                let order = a.unwrap_or(b'0').cmp(&b.unwrap_or(b'0'));
                if order != Ordering::Equal {
                    break order;
                }
            }
        });
        if self.negative {
            order.reverse()
        } else {
            order
        }
    }
}

enum DecimalExponent {
    Small(i64),
    Large { negative: bool, digits: String },
}

impl DecimalExponent {
    /// Normalize unusually large exponents too, including finite tokens that underflow binary floats.
    fn shifted(token: &str, offset: i64) -> Self {
        if let Some(value) = token
            .parse::<i64>()
            .ok()
            .and_then(|value| value.checked_add(offset))
        {
            return Self::Small(value);
        }
        let negative = token.starts_with('-');
        let mut digits = token
            .trim_start_matches(['-', '+'])
            .trim_start_matches('0')
            .as_bytes()
            .to_vec();
        let adjustment = if negative { -offset } else { offset };
        let mut carry = adjustment.unsigned_abs();
        for digit in digits.iter_mut().rev() {
            if carry == 0 {
                break;
            }
            let part = (carry % 10) as u8;
            carry /= 10;
            if adjustment >= 0 {
                let sum = *digit - b'0' + part;
                *digit = b'0' + sum % 10;
                carry += u64::from(sum >= 10);
            } else if *digit - b'0' < part {
                *digit = *digit + 10 - part;
                carry += 1;
            } else {
                *digit -= part;
            }
        }
        let suffix =
            std::str::from_utf8(&digits).expect("decimal exponent contains only ASCII digits");
        let digits = if carry > 0 {
            format!("{carry}{suffix}")
        } else {
            suffix.trim_start_matches('0').to_owned()
        };
        let signed = if negative {
            format!("-{digits}")
        } else {
            digits.clone()
        };
        match signed.parse::<i64>() {
            Ok(value) => Self::Small(value),
            Err(_) => Self::Large { negative, digits },
        }
    }

    fn compare(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Small(a), Self::Small(b)) => a.cmp(b),
            (Self::Large { negative, .. }, Self::Small(_)) => {
                if *negative {
                    Ordering::Less
                } else {
                    Ordering::Greater
                }
            }
            (Self::Small(_), Self::Large { negative, .. }) => {
                if *negative {
                    Ordering::Greater
                } else {
                    Ordering::Less
                }
            }
            (
                Self::Large {
                    negative: a_negative,
                    digits: a,
                },
                Self::Large {
                    negative: b_negative,
                    digits: b,
                },
            ) => {
                if a_negative != b_negative {
                    return if *a_negative {
                        Ordering::Less
                    } else {
                        Ordering::Greater
                    };
                }
                let order = a.len().cmp(&b.len()).then_with(|| a.cmp(b));
                if *a_negative {
                    order.reverse()
                } else {
                    order
                }
            }
        }
    }
}

#[cfg(test)]
fn compare_numbers(a: &Number, b: &Number) -> Ordering {
    NumericKey::new(a).compare(&NumericKey::new(b))
}

struct CompiledFilter<'a> {
    filter: &'a TableFilter,
    number: Option<NumericKey<'a>>,
    contains: String,
}

impl<'a> CompiledFilter<'a> {
    /// Validate numeric operands before sorting/comparing arbitrary-precision JSON tokens.
    fn new(filter: &'a TableFilter) -> Result<Self> {
        let number = serde_json::from_str::<Number>(&filter.value).ok();
        if filter.op != TableFilterOp::Contains
            && number
                .as_ref()
                .is_some_and(|value| !value.as_f64().is_some_and(f64::is_finite))
        {
            return invalid("numeric filters require a finite JSON number");
        }
        if matches!(filter.op, TableFilterOp::Gt | TableFilterOp::Lt) && number.is_none() {
            return invalid("gt/lt filters require a finite JSON number");
        }
        Ok(Self {
            filter,
            number: number.map(|number| {
                let integer = number
                    .as_i64()
                    .map(i128::from)
                    .or_else(|| number.as_u64().map(i128::from));
                NumericKey::from_token(filter.value.trim(), integer)
            }),
            contains: filter.value.to_lowercase(),
        })
    }

    fn matches(
        &self,
        cell: Cell<'_>,
        budget: &mut WorkBudget,
        control: &TableReadControl,
    ) -> Result<bool> {
        budget.visit(control)?;
        Ok(match self.filter.op {
            TableFilterOp::Contains => contains(cell, &self.contains, budget, control)?,
            TableFilterOp::Gt | TableFilterOp::Lt => match cell {
                Cell::Value(Value::Number(number)) => {
                    budget.text(
                        number
                            .as_str()
                            .len()
                            .saturating_add(self.filter.value.len()),
                    )?;
                    NumericKey::new(number).compare(self.number.as_ref().unwrap())
                        == if self.filter.op == TableFilterOp::Gt {
                            Ordering::Greater
                        } else {
                            Ordering::Less
                        }
                }
                _ => false,
            },
            TableFilterOp::Eq => match cell {
                Cell::Missing => false,
                Cell::Value(Value::Null) => self.filter.value == "null",
                Cell::Value(Value::Bool(b)) => self.filter.value == b.to_string(),
                Cell::Value(Value::Number(number)) => match &self.number {
                    Some(other) => {
                        budget.text(
                            number
                                .as_str()
                                .len()
                                .saturating_add(self.filter.value.len()),
                        )?;
                        NumericKey::new(number).compare(other) == Ordering::Equal
                    }
                    None => false,
                },
                Cell::Key(s) => {
                    budget.text(s.len())?;
                    s == self.filter.value
                }
                Cell::Value(Value::String(s)) => {
                    budget.text(s.len())?;
                    s == &self.filter.value
                }
                Cell::Value(_) => return invalid(
                    "eq on an array/object is unsupported; select a scalar column or use contains",
                ),
            },
        })
    }
}

fn contains(
    cell: Cell<'_>,
    needle: &str,
    budget: &mut WorkBudget,
    control: &TableReadControl,
) -> Result<bool> {
    budget.visit(control)?;
    match cell {
        Cell::Missing => Ok(false),
        Cell::Key(s) => {
            budget.text(s.len())?;
            Ok(s.to_lowercase().contains(needle))
        }
        Cell::Value(Value::String(s)) => {
            budget.text(s.len())?;
            Ok(s.to_lowercase().contains(needle))
        }
        Cell::Value(Value::Array(values)) => {
            for value in values {
                if contains(Cell::Value(value), needle, budget, control)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Cell::Value(Value::Object(values)) => {
            for (key, value) in values {
                if contains(Cell::Key(key), needle, budget, control)?
                    || contains(Cell::Value(value), needle, budget, control)?
                {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Cell::Value(value) => {
            let text = value.to_string();
            budget.text(text.len())?;
            Ok(text.contains(needle))
        }
    }
}
