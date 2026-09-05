import type {SnapshotDescriptor} from "./snapshots";

export interface ExperimentStats {
  snapshots: number;
  projects: number;
  experiments: number;
  runs: number;
  sources: number;
  active_sources: number;
  hot_points: number;
  parquet_files: number;
  wal_bytes: number;
  ingested_points: number;
  compacted_values: number;
  duplicate_points: number;
  cursor_gaps: number;
  scrape_failures: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  created_at_ns: number;
}

export interface ExperimentRecord {
  id: string;
  project_id: string;
  name: string;
  created_at_ns: number;
}

export interface ExperimentRun {
  id: string;
  experiment_id: string;
  name: string;
  status: "created" | "running" | "finished" | "failed" | "cancelled";
  config_json: string;
  created_at_ns: number;
  updated_at_ns: number;
}

export interface ExperimentSource {
  id: string;
  run_id: string;
  attempt_id: string;
  role: string;
  endpoint: string;
  node_id: string | null;
  rank: number | null;
  state: "discovered" | "active" | "stale" | "draining" | "ended" | "lost";
  source_session_id: string | null;
  last_success_at_ns: number | null;
  last_error: string | null;
  scrape_interval_ms: number;
  timeout_ms: number;
  descriptor: SnapshotDescriptor | LegacyDescriptor | null;
}

/** Historical descriptors remain readable; snapshots never require a metric registry. */
export interface LegacyDescriptor {
    protocol_version: number;
    source_session_id: string;
    project: string;
    experiment: string;
    run_id: string;
    attempt_id: string;
    role: string;
    rank: number | null;
    node_id: string | null;
    pid: number | null;
    labels: Record<string, string>;
    metrics: Array<{
      name: string;
      kind: string;
      unit: string;
      default_axis: string;
      source_scope: string;
      reducer: string;
    }>;
  schema_version?: never;
}

export interface ExperimentQuerySeries {
  metric: string;
  source_id: string;
  source_session_ids: string[];
  sequences: number[];
  axes: number[];
  event_time_ns: number[];
  values: number[];
}

export interface ExperimentQueryResponse {
  run_id: string;
  axis: string;
  series: ExperimentQuerySeries[];
}

export interface ExperimentSummaryResponse {
  summaries: Array<{
    run_id: string;
    values: Record<string, number>;
  }>;
}

export interface StatusResponse {
  host: string;
  version: string;
  updated_at: number;
  metrics: Record<string, number>;
  fields: Record<string, string | number | boolean | null>;
  websocket_clients: number;
  websocket_inactivity_timeout_seconds: number;
}

export interface MetricMetadata {
  label: string;
  unit: string;
  color: string;
}

export interface MetricCatalogEntry {
  name: string;
  metadata: MetricMetadata;
  current: number;
  minimum: number;
  maximum: number;
  average: number;
  p95: number;
  samples: number;
}

export interface MetricCatalogResponse {
  seconds: number;
  metrics: MetricCatalogEntry[];
}

export interface ClusterGPUUsageRow {
  queue: string;
  submitter: string;
  creator_id: string;
  running_pods: number;
  running_gpus: number;
  running_gpu_nodes: number;
  pending_pods: number;
  pending_gpus: number;
}

export interface ClusterGPUWorkloadRow extends ClusterGPUUsageRow {
  name: string;
  status: "Running" | "Pending" | "Mixed";
  running_nodes: string[];
}

export interface ClusterGPUCapacityRow {
  queue: string;
  capacity_gpus: number;
  allocated_gpus: number;
  pending_gpus: number;
  unallocated_gpus: number;
  no_job_gpus: number;
  no_job_node_equivalents: number;
  capacity_cpus: number;
  allocated_cpus: number;
  free_cpus: number;
  gpu_allocation: string;
  utilization_percent: number;
  cpu_allocation: string;
}

export interface ClusterGPUReport {
  gpus_per_node: number;
  usage: ClusterGPUUsageRow[];
  workloads: ClusterGPUWorkloadRow[];
  capacity: ClusterGPUCapacityRow[];
  total_capacity: ClusterGPUCapacityRow;
}

export interface PluginDocument<T> {
  name: string;
  updated_at: number;
  schema_version: number | null;
  refresh_seconds: number;
  refresh_after_seconds: number;
  document: T;
}

export interface AlertRuleConfig {
  alert: string;
  expr: string;
  level: string;
  title: string;
  message: string;
  enabled: boolean;
  [key: string]: unknown;
}

export interface CollectorDiagnostic {
  name: string;
  enabled: boolean;
  required: boolean;
  refresh_seconds: number;
  deadline_seconds: number;
  max_stale_seconds: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error: string | null;
  state: "up" | "stale" | "down";
  duration: number | null;
  failures: number;
  options: Record<string, unknown>;
}
