export type JsonValue =
  | null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};

export interface SnapshotDescriptor {
  protocol_version: number;
  source_session_id: string;
  project: string;
  experiment: string;
  run_id: string;
  attempt_id: string;
  role: string;
  rank?: number | null;
  node_id?: string | null;
  pid?: number | null;
  labels: Record<string, string>;
  schema_version: number;
}

export interface StoredSnapshot {
  id: number;
  run_id: string;
  source_id: string;
  source_session_id: string;
  sequence: number;
  observed_at_ns: number;
  ingested_at_ns: number;
  schema_version: number;
  axes: Record<string, number>;
  state: {[key: string]: JsonValue};
}

export interface SnapshotLatestRequest {
  run_id: string;
  source_ids?: string[];
  limit?: number;
  after_source_id?: string | null;
}
export interface SnapshotLatestResponse {
  snapshots: StoredSnapshot[];
  next_source_id: string | null;
}
export interface SnapshotHistoryRequest {
  run_id: string;
  source_ids?: string[];
  before_id?: number | null;
  from?: number;
  to?: number;
  limit?: number;
}
export interface SnapshotHistoryPage {
  snapshots: StoredSnapshot[];
  next_before_id: number | null;
}
export interface SnapshotQueryRequest {
  run_ids: string[];
  paths: string[];
  source_ids?: string[];
  axis?: string;
  from?: number;
  to?: number;
  max_points?: number;
}
export interface SnapshotQuerySeries {
  run_id: string;
  source_id: string;
  path: string;
  snapshot_ids: number[];
  source_session_ids: string[];
  sequences: number[];
  axes: number[];
  observed_at_ns: number[];
  values: Array<number | null>;
}
export interface SnapshotQueryResponse {
  axis: string;
  series: SnapshotQuerySeries[];
}
export interface SnapshotDiffRequest {
  before_id: number;
  after_id: number;
}
export interface SnapshotChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: JsonValue;
  after?: JsonValue;
}
export interface SnapshotDiffResponse extends SnapshotDiffRequest {
  changes: SnapshotChange[];
  truncated: boolean;
}

export interface ChartRunInfo {
  run_id: string;
  snapshot_count: number;
  first_observed_at_ns: number | null;
  last_observed_at_ns: number | null;
}
export interface ChartMetricSource {
  run_id: string;
  source_id: string;
  label: string;
  role: string;
  rank: number | null;
  node_id: string | null;
  primary: boolean;
  latest_value: number | null;
  observed_at_ns: number;
}
export interface ChartMetric {
  path: string;
  name: string;
  group: string;
  unit: string | null;
  run_ids: string[];
  sources: ChartMetricSource[];
}
export interface ChartCatalog {
  runs: ChartRunInfo[];
  metrics: ChartMetric[];
  defaults: string[];
  axes: string[];
  truncated: boolean;
}
