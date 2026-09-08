import type {SnapshotDescriptor} from "./snapshots";

export interface ExperimentStats {
  projects: number;
  experiments: number;
  runs: number;
  sources: number;
  active_sources: number;
  snapshots: number;
  cursor_gaps: number;
  scrape_failures: number;
}

export interface ProjectRecord {id: string; name: string; created_at_ns: number}
export interface ExperimentRecord {id: string; project_id: string; name: string; created_at_ns: number}
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
  descriptor: SnapshotDescriptor | null;
}
