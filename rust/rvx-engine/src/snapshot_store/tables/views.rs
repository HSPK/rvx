use std::collections::{HashMap, HashSet, VecDeque};

use rvx_core::{
    SnapshotAggregateGroup, SnapshotAggregateRequest, SnapshotAggregateResponse,
    SnapshotAggregateSeries, SnapshotAggregateValue, SnapshotAggregation, SnapshotMeasure,
    SnapshotRecordsRequest, SnapshotRecordsResponse, MAX_SNAPSHOT_GROUPS,
    MAX_SNAPSHOT_RECORDS_PAGE,
};

use super::{
    scan::{self, FieldPath},
    *,
};

#[cfg(test)]
mod tests;

impl SnapshotStore {
    /// Validate identities and apply exact field order over all filtered records before paging.
    /// Omitted sorting interleaves Sources; explicit-sort ties retain Source and identity order.
    pub(crate) fn snapshot_records(
        &self,
        request: &SnapshotRecordsRequest,
        sources: &[Source],
        control: &TableReadControl,
    ) -> Result<SnapshotRecordsResponse> {
        request
            .validate_identity_paths()
            .map_err(EngineError::InvalidInput)?;
        let table = request.table_request();
        validate_rows_limit(&table, MAX_SNAPSHOT_RECORDS_PAGE)?;
        let snapshots =
            self.table_snapshots(sources, request.snapshot_ids.as_deref(), true, control)?;
        let mut scanned = scan::records(&snapshots, &table, sources, scan::Mode::Records, control)?;
        if !scanned.all_objects && request.identity_paths.iter().any(|path| path == "$key") {
            return invalid("$key identities require object collections, never array positions");
        }
        let fields: Vec<_> = request
            .identity_paths
            .iter()
            .map(|path| FieldPath::new(path))
            .collect();
        let scopes: HashMap<_, _> = snapshots
            .iter()
            .enumerate()
            .map(|(scope, snapshot)| (snapshot.id, scope))
            .collect();
        let mut identities = Vec::with_capacity(scanned.rows.len());
        let mut seen = HashSet::new();
        let mut identity_text_bytes = 0usize;
        for row in &scanned.rows {
            let mut components = Vec::new();
            for field in &fields {
                scanned.budget.visit(control)?;
                components.push(scalar(field.cell(row), true)?);
            }
            let local = serde_json::to_string(&components)?;
            let scope = scopes[&row.snapshot.id];
            if !seen.insert((scope, local.clone())) {
                return invalid("duplicate record identity in the full filtered collection");
            }
            let full = serde_json::to_string(&(
                &row.snapshot.run_id,
                &row.snapshot.source_id,
                &components,
            ))?;
            scanned
                .budget
                .text(full.len().saturating_add(local.len()))?;
            // Comparisons use decoded string parts and i128s, not the serialized identity envelope.
            identity_text_bytes = identity_text_bytes.saturating_add(
                components
                    .iter()
                    .filter(|(kind, _)| *kind == "string")
                    .map(|(_, value)| value.as_ref().map_or(0, String::len))
                    .sum::<usize>(),
            );
            let parts = components
                .into_iter()
                .map(|(kind, value)| {
                    let value = value.expect("validated identities are present");
                    if kind == "number" {
                        IdentityPart::Number(
                            value.parse().expect("validated 64-bit integer identity"),
                        )
                    } else {
                        IdentityPart::String(value)
                    }
                })
                .collect();
            identities.push(Identity { scope, parts, full });
        }
        let levels = levels(scanned.rows.len());
        scanned
            .budget
            .text(identity_text_bytes.saturating_mul(2 * levels + 2))?;
        let sort = request.sort.as_ref().map(|sort| FieldPath::new(&sort.path));
        let mut keys = Vec::new();
        if let Some(field) = &sort {
            for row in &scanned.rows {
                control.check()?;
                let cell = field.cell(row);
                scanned
                    .budget
                    .text(cell_bytes(cell).saturating_mul(2 * levels + 2))?;
                keys.push(SortKey::new(cell));
            }
        }
        let indices = if request.sort.is_none() {
            interleaved_identity_page(
                &identities,
                snapshots.len(),
                request.offset,
                request.limit,
                control,
            )?
        } else {
            let mut indices: Vec<_> = (0..scanned.rows.len()).collect();
            let compare = |a: &usize, b: &usize| {
                let sort = request.sort.as_ref().unwrap();
                let order = keys[*a].compare(&keys[*b]);
                let order = if sort.direction == TableSortDirection::Desc {
                    order.reverse()
                } else {
                    order
                };
                order.then_with(|| {
                    (identities[*a].scope, &identities[*a].parts)
                        .cmp(&(identities[*b].scope, &identities[*b].parts))
                })
            };
            let page = select_page(
                &mut indices,
                request.offset,
                request.limit,
                compare,
                control,
            )?;
            indices[page].to_vec()
        };
        let response = SnapshotRecordsResponse {
            table: scan::render(
                &scanned.rows,
                &scanned.columns,
                scanned.snapshots,
                request.offset,
                request.limit,
                &indices,
                control,
            )?,
            identities: indices
                .iter()
                .map(|index| identities[*index].full.clone())
                .collect(),
        };
        bounded_response(&response)?;
        Ok(response)
    }

    /// Aggregate the full filtered dataset, retain each Source, then page global category keys.
    pub(crate) fn snapshot_aggregate(
        &self,
        request: &SnapshotAggregateRequest,
        sources: &[Source],
        control: &TableReadControl,
    ) -> Result<SnapshotAggregateResponse> {
        request.validate().map_err(EngineError::InvalidInput)?;
        let table = TableRowsRequest {
            run_ids: request.run_ids.clone(),
            source_ids: request.source_ids.clone(),
            path: request.path.clone(),
            columns: None,
            snapshot_ids: request.snapshot_ids.clone(),
            search: request.search.clone(),
            filters: request.filters.clone(),
            sort: None,
            offset: request.offset,
            limit: request.limit,
        };
        validate_rows(&table)?;
        let snapshots =
            self.table_snapshots(sources, request.snapshot_ids.as_deref(), true, control)?;
        let mut scanned =
            scan::records(&snapshots, &table, sources, scan::Mode::Projection, control)?;
        let dimensions: Vec<_> = request
            .group_by
            .iter()
            .map(|path| FieldPath::new(path))
            .collect();
        let measures: Vec<_> = request
            .measures
            .iter()
            .map(|measure| measure.path.as_ref().map(|path| FieldPath::new(path)))
            .collect();
        let mut groups: HashMap<String, Group<'_>> = HashMap::new();
        for row in &scanned.rows {
            let mut components = Vec::with_capacity(dimensions.len());
            let mut cells = Vec::with_capacity(dimensions.len());
            for dimension in &dimensions {
                scanned.budget.visit(control)?;
                let cell = dimension.cell(row);
                components.push(scalar(cell, false)?);
                cells.push(cell);
            }
            let key = serde_json::to_string(&components)?;
            scanned.budget.text(key.len())?;
            if !groups.contains_key(&key) && groups.len() >= MAX_SNAPSHOT_GROUPS {
                return invalid("aggregate exceeds 50000 groups; narrow Sources/filters");
            }
            let group = groups.entry(key).or_insert_with(|| Group {
                cells: cells.into_iter().map(preview).collect(),
                series: BTreeMap::new(),
            });
            let series = group
                .series
                .entry((&row.snapshot.run_id, &row.snapshot.source_id))
                .or_insert_with(|| Series {
                    snapshot: row.snapshot,
                    measures: request
                        .measures
                        .iter()
                        .map(|_| Accumulator::default())
                        .collect(),
                });
            for ((state, measure), path) in series
                .measures
                .iter_mut()
                .zip(&request.measures)
                .zip(&measures)
            {
                scanned.budget.visit(control)?;
                state.add(
                    measure,
                    path.as_ref().map(|path| path.cell(row)),
                    &mut scanned.budget,
                )?;
            }
        }
        let mut output = Vec::with_capacity(groups.len());
        let mut key_bytes = 0usize;
        for (key, group) in groups {
            control.check()?;
            key_bytes = key_bytes.saturating_add(key.len());
            let mut series = Vec::new();
            for ((run, source), state) in group.series {
                let mut values = BTreeMap::new();
                for (measure, accumulator) in request.measures.iter().zip(state.measures) {
                    scanned.budget.visit(control)?;
                    values.insert(measure.id.clone(), accumulator.finish(measure)?);
                }
                series.push(SnapshotAggregateSeries {
                    run_id: run.clone(),
                    source_id: source.clone(),
                    snapshot_id: state.snapshot.id.to_string(),
                    measures: values,
                });
            }
            output.push(SnapshotAggregateGroup {
                key,
                cells: group.cells,
                series,
            });
        }
        scanned
            .budget
            .text(key_bytes.saturating_mul(2 * levels(output.len()) + 2))?;
        let ranks = rank_categories(&output, request, &mut scanned.budget, control)?;
        let rank_keys: Vec<_> = ranks
            .iter()
            .map(|number| number.as_ref().map(NumericKey::new))
            .collect();
        let mut indices: Vec<_> = (0..output.len()).collect();
        let compare = |a: &usize, b: &usize| {
            let order = request.order.as_ref().map_or(Ordering::Equal, |spec| {
                let order = match (&rank_keys[*a], &rank_keys[*b]) {
                    (Some(a), Some(b)) => a.compare(b),
                    (None, None) => Ordering::Equal,
                    // Missing ranks stay last, rather than appearing as numeric zero.
                    (None, Some(_)) => return Ordering::Greater,
                    (Some(_), None) => return Ordering::Less,
                };
                if spec.direction == TableSortDirection::Desc {
                    order.reverse()
                } else {
                    order
                }
            });
            order.then_with(|| output[*a].key.cmp(&output[*b].key))
        };
        let page = select_page(
            &mut indices,
            request.offset,
            request.limit,
            compare,
            control,
        )?;
        let total_groups = output.len();
        let mut output: Vec<_> = output.into_iter().map(Some).collect();
        let groups = indices[page]
            .iter()
            .map(|index| output[*index].take().unwrap())
            .collect();
        let response = SnapshotAggregateResponse {
            groups,
            total_groups,
            matched_rows: scanned.rows.len(),
            offset: request.offset,
            limit: request.limit,
            snapshots: scanned.snapshots,
        };
        bounded_response(&response)?;
        Ok(response)
    }
}

struct Identity {
    scope: usize,
    parts: Vec<IdentityPart>,
    full: String,
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum IdentityPart {
    Number(i128),
    String(String),
}

/// Locate rounds by Source counts, then sort only each Source's contributing window.
/// This avoids sorting or materializing the entire prefix before a deep global page.
fn interleaved_identity_page(
    identities: &[Identity],
    scopes: usize,
    offset: usize,
    limit: usize,
    control: &TableReadControl,
) -> Result<Vec<usize>> {
    control.check()?;
    if offset >= identities.len() {
        return Ok(Vec::new());
    }
    let end = offset.saturating_add(limit).min(identities.len());
    let mut buckets = vec![Vec::new(); scopes];
    for (index, identity) in identities.iter().enumerate() {
        control.check()?;
        buckets[identity.scope].push(index);
    }
    let counts: Vec<_> = buckets.iter().map(Vec::len).collect();
    let first_round = identity_round(&counts, offset);
    let last_round = identity_round(&counts, end - 1);
    let mut queue = VecDeque::new();
    for bucket in &mut buckets {
        let page = select_page(
            bucket,
            first_round,
            last_round - first_round + 1,
            |a, b| identities[*a].parts.cmp(&identities[*b].parts),
            control,
        )?;
        if !page.is_empty() {
            queue.push_back(bucket[page].to_vec().into_iter());
        }
    }
    let mut position: usize = counts.iter().map(|count| (*count).min(first_round)).sum();
    let mut result = Vec::with_capacity(end - offset);
    while let Some(mut source) = queue.pop_front() {
        control.check()?;
        let index = source.next().expect("nonempty Source window");
        if position >= offset {
            result.push(index);
        }
        position += 1;
        if position == end {
            break;
        }
        if source.len() > 0 {
            queue.push_back(source);
        }
    }
    Ok(result)
}

fn identity_round(counts: &[usize], position: usize) -> usize {
    let (mut low, mut high) = (0, counts.iter().copied().max().unwrap_or_default());
    while low < high {
        let middle = low + (high - low + 1) / 2;
        let prefix: usize = counts.iter().map(|count| (*count).min(middle)).sum();
        if prefix <= position {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    low
}

/// Tags distinguish missing/null and prevent stringified numeric IDs from colliding with numbers.
fn scalar(cell: Cell<'_>, identity: bool) -> Result<(&'static str, Option<String>)> {
    Ok(match cell {
        Cell::Key(value) => ("string", Some(value.to_owned())),
        Cell::Value(Value::String(value)) => ("string", Some(value.clone())),
        Cell::Value(Value::Bool(value)) if !identity => ("boolean", Some(value.to_string())),
        Cell::Value(Value::Number(number)) if identity => {
            let integer = number
                .as_i64()
                .map(i128::from)
                .or_else(|| number.as_u64().map(i128::from))
                .ok_or_else(|| {
                    EngineError::InvalidInput("record identity values must not be floats".into())
                })?;
            ("number", Some(integer.to_string()))
        }
        Cell::Value(Value::Number(number)) => ("number", Some(canonical_number(number))),
        Cell::Missing if !identity => ("missing", None),
        Cell::Value(Value::Null) if !identity => ("null", None),
        _ if identity => {
            return invalid(
                "record identity values require present, non-null strings or exact 64-bit integers",
            )
        }
        _ => return invalid("group_by values must be scalar, missing, or null"),
    })
}

fn canonical_number(number: &Number) -> String {
    let key = NumericKey::new(number);
    if key.digits.is_empty() {
        return "0".into();
    }
    let digits: String = key
        .digits
        .chars()
        .filter(|character| *character != '.')
        .collect();
    let magnitude = match key.magnitude {
        DecimalExponent::Small(value) => value.to_string(),
        DecimalExponent::Large { negative, digits } => {
            format!("{}{digits}", if negative { "-" } else { "" })
        }
    };
    format!(
        "{}0.{}e{magnitude}",
        if key.negative { "-" } else { "" },
        digits.trim_end_matches('0')
    )
}

struct Group<'a> {
    cells: Vec<TableCell>,
    series: BTreeMap<(&'a String, &'a String), Series<'a>>,
}
struct Series<'a> {
    snapshot: &'a StoredSnapshot,
    measures: Vec<Accumulator<'a>>,
}

#[derive(Default)]
struct Accumulator<'a> {
    count: usize,
    missing: usize,
    non_numeric: usize,
    integer_sum: i128,
    float_sum: Option<StableSum>,
    bound: Option<(&'a Number, NumericKey<'a>)>,
    minimum_magnitude: Option<(&'a Number, NumericKey<'a>)>,
}

impl<'a> Accumulator<'a> {
    fn add(
        &mut self,
        measure: &SnapshotMeasure,
        cell: Option<Cell<'a>>,
        budget: &mut WorkBudget,
    ) -> Result<()> {
        if measure.op == SnapshotAggregation::Count {
            if matches!(cell, Some(Cell::Missing | Cell::Value(Value::Null))) {
                self.missing += 1;
            } else {
                self.count += 1;
            }
            return Ok(());
        }
        let number = match cell {
            Some(Cell::Value(Value::Number(number))) => number,
            Some(Cell::Missing | Cell::Value(Value::Null)) | None => {
                self.missing += 1;
                return Ok(());
            }
            _ => {
                self.non_numeric += 1;
                return Ok(());
            }
        };
        budget.text(number.as_str().len().saturating_mul(2))?;
        self.count += 1;
        if measure.op == SnapshotAggregation::Min {
            budget.text(number.as_str().len().saturating_mul(2))?;
            let mut magnitude = NumericKey::new(number);
            magnitude.negative = false;
            magnitude.integer = magnitude.integer.map(i128::abs);
            if !magnitude.digits.is_empty()
                && self
                    .minimum_magnitude
                    .as_ref()
                    .map_or(true, |(_, current)| {
                        magnitude.compare(current) == Ordering::Less
                    })
            {
                self.minimum_magnitude = Some((number, magnitude));
            }
        }
        match measure.op {
            SnapshotAggregation::Count => unreachable!(),
            SnapshotAggregation::Sum => {
                let integer = number
                    .as_i64()
                    .map(i128::from)
                    .or_else(|| number.as_u64().map(i128::from));
                if let Some(sum) = &mut self.float_sum {
                    sum.add(
                        number
                            .as_f64()
                            .filter(|value| value.is_finite())
                            .ok_or_else(|| {
                                EngineError::InvalidInput(
                                    "aggregate sum requires finite inputs".into(),
                                )
                            })?,
                    );
                } else if let Some(integer) = integer {
                    self.integer_sum = self.integer_sum.checked_add(integer).ok_or_else(|| {
                        EngineError::InvalidInput("aggregate integer sum overflow".into())
                    })?;
                } else {
                    let mut sum = StableSum::default();
                    sum.add(self.integer_sum as f64);
                    sum.add(
                        number
                            .as_f64()
                            .filter(|value| value.is_finite())
                            .ok_or_else(|| {
                                EngineError::InvalidInput(
                                    "aggregate sum requires finite inputs".into(),
                                )
                            })?,
                    );
                    self.float_sum = Some(sum);
                }
            }
            SnapshotAggregation::Min | SnapshotAggregation::Max => {
                let key = NumericKey::new(number);
                let replace = self.bound.as_ref().map_or(true, |(_, current)| {
                    let order = key.compare(current);
                    if measure.op == SnapshotAggregation::Min {
                        order == Ordering::Less
                    } else {
                        order == Ordering::Greater
                    }
                });
                if replace {
                    self.bound = Some((number, key));
                }
            }
        }
        Ok(())
    }

    fn finish(self, measure: &SnapshotMeasure) -> Result<SnapshotAggregateValue> {
        let approximate = self.float_sum.is_some();
        let minimum_magnitude = (measure.op == SnapshotAggregation::Min).then(|| {
            self.minimum_magnitude.map_or_else(
                || preview(Cell::Missing),
                |(number, _)| numeric_cell(number.as_str().trim_start_matches('-').to_owned()),
            )
        });
        let value = if measure.op == SnapshotAggregation::Count {
            numeric_cell(self.count.to_string())
        } else if self.count == 0 {
            preview(Cell::Missing)
        } else {
            numeric_cell(match measure.op {
                SnapshotAggregation::Sum => match self.float_sum {
                    Some(sum) => {
                        let value = sum.total();
                        Number::from_f64(value)
                            .ok_or_else(|| {
                                EngineError::InvalidInput(
                                    "aggregate sum overflow or nonfinite result".into(),
                                )
                            })?
                            .to_string()
                    }
                    None => self.integer_sum.to_string(),
                },
                SnapshotAggregation::Min | SnapshotAggregation::Max => {
                    self.bound.unwrap().0.as_str().to_owned()
                }
                SnapshotAggregation::Count => unreachable!(),
            })
        };
        Ok(SnapshotAggregateValue {
            value,
            minimum_magnitude,
            count: self.count,
            missing: self.missing,
            non_numeric: self.non_numeric,
            approximate,
        })
    }
}

/// Scaled Neumaier compensation avoids avoidable intermediate overflow without claiming exact floats.
#[derive(Default)]
struct StableSum {
    scale: f64,
    sum: f64,
    correction: f64,
}
impl StableSum {
    fn add(&mut self, value: f64) {
        if value == 0.0 {
            return;
        }
        if value.abs() > self.scale {
            let factor = self.scale / value.abs();
            self.sum *= factor;
            self.correction *= factor;
            self.scale = value.abs();
        }
        let term = value / self.scale;
        let next = self.sum + term;
        self.correction += if self.sum.abs() >= term.abs() {
            (self.sum - next) + term
        } else {
            (term - next) + self.sum
        };
        self.sum = next;
    }
    fn total(self) -> f64 {
        (self.sum + self.correction) * self.scale
    }
}

fn numeric_cell(text: String) -> TableCell {
    TableCell {
        kind: TableCellKind::Number,
        text,
        truncated: false,
    }
}
fn levels(count: usize) -> usize {
    if count == 0 {
        0
    } else {
        count.ilog2() as usize + 1
    }
}
fn cell_bytes(cell: Cell<'_>) -> usize {
    match cell {
        Cell::Key(value) => value.len(),
        Cell::Value(Value::String(value)) => value.len(),
        Cell::Value(Value::Number(value)) => value.as_str().len(),
        _ => 0,
    }
}

fn rank_categories(
    groups: &[SnapshotAggregateGroup],
    request: &SnapshotAggregateRequest,
    budget: &mut WorkBudget,
    control: &TableReadControl,
) -> Result<Vec<Option<Number>>> {
    if request.order.is_none() {
        return Ok(Vec::new());
    }
    let mut ranks = Vec::with_capacity(groups.len());
    for group in groups {
        control.check()?;
        let mut maximum: Option<Number> = None;
        if let Some(order) = &request.order {
            for series in &group.series {
                budget.visit(control)?;
                let value = &series.measures[&order.measure].value;
                if value.kind == TableCellKind::Number {
                    budget.text(
                        value
                            .text
                            .len()
                            .saturating_mul(2 * levels(groups.len()) + 2),
                    )?;
                    let number: Number = serde_json::from_str(&value.text)?;
                    if maximum.as_ref().map_or(true, |current| {
                        NumericKey::new(&number).compare(&NumericKey::new(current))
                            == Ordering::Greater
                    }) {
                        maximum = Some(number);
                    }
                }
            }
        }
        ranks.push(maximum);
    }
    Ok(ranks)
}
