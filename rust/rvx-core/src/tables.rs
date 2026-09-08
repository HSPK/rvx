//! Snapshot-derived statistics and structured table wire contracts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TableSummaryRequest {
    pub run_ids: Vec<String>,
    pub paths: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default = "default_table_axis")]
    pub axis: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TableSummaryRow {
    pub run_id: String,
    pub source_id: String,
    pub path: String,
    pub observations: usize,
    pub count: usize,
    pub missing: usize,
    pub current: Option<f64>,
    pub minimum: Option<f64>,
    pub average: Option<f64>,
    pub p95: Option<f64>,
    pub maximum: Option<f64>,
    pub snapshot_id: Option<String>,
    pub observed_at_ns: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TableSummaryResponse {
    pub axis: String,
    pub rows: Vec<TableSummaryRow>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TableCatalogRequest {
    pub run_ids: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TableColumn {
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<TableCellKind>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TableSource {
    pub run_id: String,
    pub source_id: String,
    pub label: String,
    pub role: String,
    pub rank: Option<i64>,
    pub node_id: Option<String>,
    pub snapshot_id: String,
    pub observed_at_ns: i64,
    pub row_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TableDefinition {
    pub path: String,
    pub name: String,
    pub columns: Vec<TableColumn>,
    pub sources: Vec<TableSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_kinds: Option<Vec<TableCollectionKind>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TableCatalogResponse {
    pub tables: Vec<TableDefinition>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum TableCellKind {
    Missing,
    Null,
    Number,
    String,
    Boolean,
    Object,
    Array,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum TableCollectionKind {
    Array,
    Object,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TableCell {
    pub kind: TableCellKind,
    pub text: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableFilterOp {
    Contains,
    Eq,
    Gt,
    Lt,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TableFilter {
    pub path: String,
    pub op: TableFilterOp,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableSortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TableSort {
    pub path: String,
    pub direction: TableSortDirection,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TableRowsRequest {
    pub run_ids: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub path: String,
    pub columns: Option<Vec<String>>,
    pub snapshot_ids: Option<Vec<String>>,
    pub search: Option<String>,
    #[serde(default)]
    pub filters: Vec<TableFilter>,
    pub sort: Option<TableSort>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "super::default_snapshot_page_limit")]
    pub limit: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TableDataRow {
    pub run_id: String,
    pub source_id: String,
    pub snapshot_id: String,
    pub row_key: String,
    pub cells: BTreeMap<String, TableCell>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TableRowsResponse {
    pub columns: Vec<TableColumn>,
    pub rows: Vec<TableDataRow>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub snapshots: Vec<TableSource>,
}

fn default_table_axis() -> String {
    "elapsed".into()
}
