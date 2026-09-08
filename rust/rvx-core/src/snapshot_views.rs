//! Collection-backed view configuration and exact-cell projection contracts.
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    validate_snapshot_pointer, TableCell, TableFilter, TableRowsRequest, TableRowsResponse,
    TableSort, TableSortDirection, TableSource,
};

pub const MAX_SNAPSHOT_GROUPS: usize = 50_000;
pub const MAX_SNAPSHOT_RECORDS_PAGE: usize = 2048;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotAggregation {
    Count,
    Sum,
    Min,
    Max,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SnapshotView {
    #[serde(rename_all = "camelCase")]
    Bar {
        category_path: String,
        value_paths: Vec<String>,
        aggregation: SnapshotAggregation,
        orientation: BarOrientation,
        layout: BarLayout,
        order: BarOrder,
        limit: u8,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        decimals: Option<u8>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        unit: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    StatusGrid {
        id_paths: Vec<String>,
        status_path: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        label_path: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        group_path: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        value_path: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        shade_path: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        shade_scale: Option<ShadeScale>,
        density: StatusDensity,
        /// Omission preserves Source-fair identity order; explicit fields sort before paging.
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        sort: Option<TableSort>,
        /// Responsive column upper bound; omission lets the client choose automatically.
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        columns: Option<u8>,
        /// CSS pixels; omission retains the selected density's legacy cell size.
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        cell_size: Option<u8>,
        /// CSS pixels; omission retains the legacy five-pixel gap.
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        gap: Option<u8>,
        #[serde(
            default,
            deserialize_with = "status_colors",
            skip_serializing_if = "Option::is_none"
        )]
        colors: Option<BTreeMap<String, String>>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BarOrientation {
    Horizontal,
    Vertical,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BarLayout {
    Grouped,
    Stacked,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BarOrder {
    ValueDesc,
    ValueAsc,
    Label,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StatusDensity {
    Comfortable,
    Compact,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShadeScale {
    Linear,
    Log,
}

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

fn status_colors<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<BTreeMap<String, String>>, D::Error> {
    struct Colors;
    impl<'de> serde::de::Visitor<'de> for Colors {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("at most 128 distinct state colors")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            use serde::de::Error;
            let mut colors = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if colors.len() >= 128 || colors.insert(key, value).is_some() {
                    return Err(M::Error::custom("duplicate or excessive status colors"));
                }
            }
            Ok(colors)
        }
    }
    deserializer.deserialize_map(Colors).map(Some)
}

/// Accept genuine JSON pointers and the existing record-key/value selectors, never guessed field names.
pub fn validate_snapshot_field(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("snapshot field paths must not contain null characters".into());
    }
    if path == "$key" || path == "$value" {
        return Ok(());
    }
    validate_snapshot_pointer(path).map_err(|error| error.to_string())
}

fn paths(values: &[String], min: usize, max: usize) -> Result<(), String> {
    if !(min..=max).contains(&values.len())
        || values.iter().collect::<HashSet<_>>().len() != values.len()
    {
        return Err(format!("field paths require {min}..{max} unique entries"));
    }
    for value in values {
        validate_snapshot_field(value)?;
    }
    Ok(())
}

impl SnapshotView {
    /// Validate presentation only; collection types and identity uniqueness are checked against actual records.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Bar {
                category_path,
                value_paths,
                aggregation,
                limit,
                decimals,
                unit,
                ..
            } => {
                validate_snapshot_field(category_path)?;
                paths(
                    value_paths,
                    usize::from(*aggregation != SnapshotAggregation::Count),
                    if *aggregation == SnapshotAggregation::Count {
                        0
                    } else {
                        8
                    },
                )?;
                if !(1..=50).contains(limit) || decimals.is_some_and(|value| value > 20) {
                    return Err("bar limit must be 1..50 and decimals must be 0..20".into());
                }
                if unit
                    .as_ref()
                    .is_some_and(|value| value.chars().count() > 40 || value.contains('\0'))
                {
                    return Err("bar unit must contain at most 40 characters".into());
                }
            }
            Self::StatusGrid {
                id_paths,
                status_path,
                label_path,
                group_path,
                value_path,
                shade_path,
                sort,
                columns,
                cell_size,
                gap,
                colors,
                ..
            } => {
                paths(id_paths, 1, 4)?;
                validate_snapshot_field(status_path)?;
                for value in [label_path, group_path, value_path, shade_path]
                    .into_iter()
                    .flatten()
                {
                    validate_snapshot_field(value)?;
                }
                if let Some(sort) = sort {
                    validate_snapshot_field(&sort.path)?;
                }
                if columns.is_some_and(|value| !(1..=64).contains(&value))
                    || cell_size.is_some_and(|value| !(12..=40).contains(&value))
                    || gap.is_some_and(|value| !(2..=12).contains(&value))
                {
                    return Err(
                        "status grid columns must be 1..64, cell size 12..40, and gap 2..12".into(),
                    );
                }
                if colors.as_ref().is_some_and(|colors| {
                    colors.len() > 128
                        || colors.iter().any(|(state, color)| {
                            state.len() > 256
                                || state.contains('\0')
                                || color.len() != 7
                                || !color.starts_with('#')
                                || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
                        })
                }) {
                    return Err(
                        "status colors require at most 128 bounded state keys and #RRGGBB values"
                            .into(),
                    );
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotRecordsRequest {
    pub run_ids: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(default)]
    pub filters: Vec<TableFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<TableSort>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "records_limit")]
    pub limit: usize,
    pub identity_paths: Vec<String>,
}

impl SnapshotRecordsRequest {
    /// Share the existing table request pipeline without changing that API's smaller page limit.
    pub fn table_request(&self) -> TableRowsRequest {
        TableRowsRequest {
            run_ids: self.run_ids.clone(),
            source_ids: self.source_ids.clone(),
            path: self.path.clone(),
            columns: self.columns.clone(),
            snapshot_ids: self.snapshot_ids.clone(),
            search: self.search.clone(),
            filters: self.filters.clone(),
            sort: self.sort.clone(),
            offset: self.offset,
            limit: self.limit,
        }
    }

    /// Validate stable identity selectors independently of bounded catalog hints.
    pub fn validate_identity_paths(&self) -> Result<(), String> {
        paths(&self.identity_paths, 1, 4)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SnapshotRecordsResponse {
    #[serde(flatten)]
    pub table: TableRowsResponse,
    pub identities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotMeasure {
    pub id: String,
    pub op: SnapshotAggregation,
    /// Count without a path counts rows; count(path) counts non-null values of any kind.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotAggregateOrder {
    pub measure: String,
    pub direction: TableSortDirection,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotAggregateRequest {
    pub run_ids: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub path: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub snapshot_ids: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub search: Option<String>,
    #[serde(default)]
    pub filters: Vec<TableFilter>,
    pub group_by: Vec<String>,
    pub measures: Vec<SnapshotMeasure>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub order: Option<SnapshotAggregateOrder>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "aggregate_limit")]
    pub limit: usize,
}

impl SnapshotAggregateRequest {
    /// Bound group dimensions, named measures, and global category pages before scanning snapshots.
    pub fn validate(&self) -> Result<(), String> {
        paths(&self.group_by, 1, 2)?;
        if self.measures.is_empty()
            || self.measures.len() > 8
            || self.offset > MAX_SNAPSHOT_GROUPS
            || !(1..=256).contains(&self.limit)
        {
            return Err(
                "aggregate requires 1..8 measures, offset at most 50000, and limit 1..256".into(),
            );
        }
        let mut ids = HashSet::new();
        for measure in &self.measures {
            if !crate::valid_ui_id(&measure.id) || !ids.insert(&measure.id) {
                return Err("measure IDs must be unique and bounded".into());
            }
            match &measure.path {
                Some(path) => validate_snapshot_field(path)?,
                None if measure.op != SnapshotAggregation::Count => {
                    return Err("numeric measures require a path".into())
                }
                None => (),
            }
        }
        if self
            .order
            .as_ref()
            .is_some_and(|order| !ids.contains(&order.measure))
        {
            return Err("aggregate order references an unknown measure".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SnapshotAggregateValue {
    pub value: TableCell,
    /// Exact smallest nonzero absolute value, supplied by min measures for stable log scaling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_magnitude: Option<TableCell>,
    pub count: usize,
    pub missing: usize,
    pub non_numeric: usize,
    pub approximate: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SnapshotAggregateSeries {
    pub run_id: String,
    pub source_id: String,
    pub snapshot_id: String,
    pub measures: BTreeMap<String, SnapshotAggregateValue>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SnapshotAggregateGroup {
    pub key: String,
    pub cells: Vec<TableCell>,
    pub series: Vec<SnapshotAggregateSeries>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SnapshotAggregateResponse {
    pub groups: Vec<SnapshotAggregateGroup>,
    pub total_groups: usize,
    pub matched_rows: usize,
    pub offset: usize,
    pub limit: usize,
    pub snapshots: Vec<TableSource>,
}

fn records_limit() -> usize {
    1000
}
fn aggregate_limit() -> usize {
    50
}
