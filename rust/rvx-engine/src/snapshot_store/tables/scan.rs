use super::*;

pub(super) struct FieldPath {
    kind: PathKind,
}

enum PathKind {
    Key,
    Value,
    Pointer(Vec<String>),
}

impl FieldPath {
    /// Decode RFC 6901 components once instead of reparsing the pointer for every record.
    pub(super) fn new(path: &str) -> Self {
        let kind = match path {
            "$key" => PathKind::Key,
            "$value" => PathKind::Value,
            "" => PathKind::Pointer(Vec::new()),
            _ => PathKind::Pointer(
                path[1..]
                    .split('/')
                    .map(|part| part.replace("~1", "/").replace("~0", "~"))
                    .collect(),
            ),
        };
        Self { kind }
    }

    pub(super) fn cell<'a>(&self, row: &'a Record<'_>) -> Cell<'a> {
        match &self.kind {
            PathKind::Key => Cell::Key(&row.key),
            PathKind::Value if !row.value.is_object() => Cell::Value(row.value),
            PathKind::Value => Cell::Missing,
            PathKind::Pointer(parts) => {
                let mut value = row.value;
                for part in parts {
                    let next = match value {
                        Value::Object(object) => object.get(part),
                        Value::Array(array)
                            if !part.starts_with('+')
                                && !(part.starts_with('0') && part.len() > 1) =>
                        {
                            part.parse::<usize>()
                                .ok()
                                .and_then(|index| array.get(index))
                        }
                        _ => None,
                    };
                    let Some(next) = next else {
                        return Cell::Missing;
                    };
                    value = next;
                }
                Cell::Value(value)
            }
        }
    }
}

pub(super) enum Mode {
    Rows,
    Records,
    Projection,
}

pub(super) struct Scan<'a> {
    pub rows: Vec<Record<'a>>,
    pub columns: Vec<String>,
    pub snapshots: Vec<TableSource>,
    pub budget: WorkBudget,
    pub all_objects: bool,
}

/// Load no snapshots here: callers share one immutable load, then one predicate/schema pass.
pub(super) fn records<'a>(
    snapshots: &'a [StoredSnapshot],
    request: &TableRowsRequest,
    sources: &[Source],
    mode: Mode,
    control: &TableReadControl,
) -> Result<Scan<'a>> {
    let discover = matches!(mode, Mode::Rows | Mode::Records);
    let allow_empty = !matches!(mode, Mode::Rows);
    let mut columns = BTreeSet::from(["$key".to_owned()]);
    let mut requested: BTreeSet<&str> = request
        .filters
        .iter()
        .map(|filter| filter.path.as_str())
        .collect();
    requested.extend(request.sort.iter().map(|sort| sort.path.as_str()));
    // Records retain absent presentation fields; only native table columns require discovery.
    if matches!(mode, Mode::Rows) {
        requested.extend(request.columns.iter().flatten().map(String::as_str));
    }
    let mut fields: Vec<_> = requested
        .into_iter()
        .map(|path| (path, FieldPath::new(path), path == "$key"))
        .collect();
    let filters = request
        .filters
        .iter()
        .map(|filter| Ok((CompiledFilter::new(filter)?, FieldPath::new(&filter.path))))
        .collect::<Result<Vec<_>>>()?;
    let search = request
        .search
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    let mut rows = Vec::new();
    let mut evidence = Vec::new();
    let mut budget = WorkBudget::default();
    let mut scanned = 0;
    let mut all_objects = true;
    for snapshot in snapshots {
        control.check()?;
        let value = snapshot.snapshot.state.pointer(&request.path);
        let count = collection_len(value).ok_or_else(|| EngineError::InvalidInput(format!(
            "table path {:?} is {} in Source {:?}, snapshot {}; refresh the catalog or select compatible Sources",
            request.path, value_kind(value), snapshot.source_id, snapshot.id,
        )))?;
        all_objects &= value.unwrap().is_object();
        evidence.push(table_source(snapshot, sources, count));
        for (position, (key, value)) in collection(value.unwrap()).enumerate() {
            budget.visit(control)?;
            scanned += 1;
            let row = Record {
                snapshot,
                key,
                position,
                value,
            };
            if discover && request.columns.is_none() {
                row_columns(value, &mut columns, MAX_COLUMNS, false)?;
            }
            for (_, field, found) in &mut fields {
                budget.visit(control)?;
                *found |= !matches!(field.cell(&row), Cell::Missing);
            }
            let mut matches = true;
            for (filter, field) in &filters {
                if !filter.matches(field.cell(&row), &mut budget, control)? {
                    matches = false;
                    break;
                }
            }
            if matches {
                if let Some(search) = &search {
                    matches = contains(Cell::Key(&row.key), search, &mut budget, control)?
                        || contains(Cell::Value(row.value), search, &mut budget, control)?;
                }
            }
            if matches {
                rows.push(row);
            }
        }
    }
    if scanned > 0 || !allow_empty {
        for (path, _, found) in fields {
            if !found && !columns.contains(path) {
                return invalid(&format!(
                    "unknown table column {path:?} in selected snapshots"
                ));
            }
        }
    }
    let columns = if discover {
        request
            .columns
            .clone()
            .unwrap_or_else(|| columns.into_iter().collect())
    } else {
        Vec::new()
    };
    Ok(Scan {
        rows,
        columns,
        snapshots: evidence,
        budget,
        all_objects,
    })
}

pub(super) fn render(
    rows: &[Record<'_>],
    columns: &[String],
    snapshots: Vec<TableSource>,
    offset: usize,
    limit: usize,
    page: &[usize],
    control: &TableReadControl,
) -> Result<TableRowsResponse> {
    let fields: Vec<_> = columns.iter().map(|path| FieldPath::new(path)).collect();
    let mut response = TableRowsResponse {
        columns: columns.iter().map(|path| column(path)).collect(),
        rows: Vec::new(),
        total: rows.len(),
        offset,
        limit,
        snapshots,
    };
    let mut bytes = json_size(&response)?;
    for index in page {
        control.check()?;
        let row = &rows[*index];
        let output = TableDataRow {
            run_id: row.snapshot.run_id.clone(),
            source_id: row.snapshot.source_id.clone(),
            snapshot_id: row.snapshot.id.to_string(),
            row_key: row.key.clone(),
            cells: columns
                .iter()
                .zip(&fields)
                .map(|(path, field)| (path.clone(), preview(field.cell(row))))
                .collect(),
        };
        bytes += json_size(&output)? + 1;
        if bytes > MAX_SNAPSHOT_PAGE_BYTES {
            return invalid("table response exceeds 16 MiB; reduce limit or selected columns");
        }
        response.rows.push(output);
    }
    bounded_response(&response)?;
    Ok(response)
}
