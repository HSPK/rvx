import {ApiClient} from "../core/api-client";
import type {WorkspaceData} from "./domain";

const EMPTY_DATA: WorkspaceData = {
  stats: {
    snapshots: 0,
    projects: 0,
    experiments: 0,
    runs: 0,
    sources: 0,
    active_sources: 0,
    hot_points: 0,
    parquet_files: 0,
    wal_bytes: 0,
    ingested_points: 0,
    compacted_values: 0,
    duplicate_points: 0,
    cursor_gaps: 0,
    scrape_failures: 0,
  },
  projects: [],
  experiments: [],
  runs: [],
  sources: [],
};

export class CatalogStore {
  readonly api = new ApiClient();
  private data: WorkspaceData = EMPTY_DATA;
  private pending: Promise<WorkspaceData> | null = null;
  private readonly listeners = new Set<() => void>();
  error: Error | null = null;

  snapshot(): WorkspaceData {
    return this.data;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<WorkspaceData> {
    if (this.pending) return this.pending;
    this.pending = Promise.all([
      this.api.experimentStats(),
      this.api.projects(),
      this.api.experiments(),
      this.api.experimentRuns(),
      this.api.experimentSources(),
    ])
      .then(([stats, projects, experiments, runs, sources]) => {
        this.data = {stats, projects, experiments, runs, sources};
        this.error = null;
        this.notify();
        return this.data;
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.notify();
        throw this.error;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
