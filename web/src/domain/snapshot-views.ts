import type {CellKind, TableCell, TableFilter, TableRowsRequest, TableRowsResponse, TableSource} from "./tables";

export type SnapshotAggregation = "count" | "sum" | "min" | "max";
export interface SnapshotBarView {
  type: "bar";
  categoryPath: string;
  valuePaths: string[];
  aggregation: SnapshotAggregation;
  orientation: "horizontal" | "vertical";
  layout: "grouped" | "stacked";
  order: "value-desc" | "value-asc" | "label";
  limit: number;
  decimals?: number;
  unit?: string;
}
export interface SnapshotStatusView {
  type: "status-grid";
  idPaths: string[];
  statusPath: string;
  labelPath?: string;
  groupPath?: string;
  valuePath?: string;
  shadePath?: string;
  shadeScale?: "linear" | "log";
  density: "comfortable" | "compact";
  sort?: TableRowsRequest["sort"];
  columns?: number;
  cellSize?: number;
  gap?: number;
  colors?: Record<string, string>;
}
export type SnapshotView = SnapshotBarView | SnapshotStatusView;

/** Compact record pages retain the existing exact-cell wire format and add validated stable identities. */
export interface SnapshotRecordsRequest extends TableRowsRequest {identity_paths: string[]}
export interface SnapshotRecordsResponse extends TableRowsResponse {identities: string[]}

export interface SnapshotMeasure {id: string; op: SnapshotAggregation; path?: string}
export interface SnapshotAggregateRequest {
  run_ids: string[];
  source_ids?: string[];
  path: string;
  snapshot_ids?: string[];
  search?: string;
  filters?: TableFilter[];
  group_by: string[];
  measures: SnapshotMeasure[];
  order?: {measure: string; direction: "asc" | "desc"};
  offset?: number;
  limit?: number;
}
export interface SnapshotAggregateValue {
  value: TableCell;
  minimum_magnitude?: TableCell;
  count: number;
  missing: number;
  non_numeric: number;
  approximate: boolean;
}
export interface SnapshotAggregateSeries {
  run_id: string;
  source_id: string;
  snapshot_id: string;
  measures: Record<string, SnapshotAggregateValue>;
}
export interface SnapshotAggregateGroup {
  key: string;
  cells: TableCell[];
  series: SnapshotAggregateSeries[];
}
export interface SnapshotAggregateResponse {
  groups: SnapshotAggregateGroup[];
  total_groups: number;
  matched_rows: number;
  offset: number;
  limit: number;
  snapshots: TableSource[];
}

export interface SnapshotFieldHint {kinds?: CellKind[]}
