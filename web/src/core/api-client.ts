import type {
  AlertRuleConfig,
  CollectorDiagnostic,
  ExperimentQueryResponse,
  ExperimentSummaryResponse,
  ExperimentRecord,
  ExperimentRun,
  ExperimentSource,
  ExperimentStats,
  MetricCatalogResponse,
  PluginDocument,
  ProjectRecord,
  StatusResponse,
} from "../domain/types";
import type {
  SnapshotLatestRequest, SnapshotLatestResponse,
  SnapshotHistoryRequest, SnapshotHistoryPage,
  SnapshotQueryRequest, SnapshotQueryResponse,
  SnapshotDiffRequest, SnapshotDiffResponse,
} from "../domain/snapshots";
import {parseExactJson} from "./exact-json";

export class ApiClient {
  updateRunStatus(runId: string, status: ExperimentRun["status"]): Promise<ExperimentRun> {
    return this.postJson(`/api/experiments/runs/${encodeURIComponent(runId)}`, {status}, undefined, "PATCH");
  }

  updateSourceState(sourceId: string, state: ExperimentSource["state"]): Promise<ExperimentSource> {
    return this.postJson(`/api/experiments/sources/${encodeURIComponent(sourceId)}`, {state}, undefined, "PATCH");
  }

  snapshotLatest(request: SnapshotLatestRequest, signal?: AbortSignal): Promise<SnapshotLatestResponse> {
    return this.postJson("/api/snapshots/latest", request, signal);
  }

  snapshotHistory(request: SnapshotHistoryRequest, signal?: AbortSignal): Promise<SnapshotHistoryPage> {
    return this.postJson("/api/snapshots/history", request, signal);
  }

  snapshotQuery(request: SnapshotQueryRequest, signal?: AbortSignal): Promise<SnapshotQueryResponse> {
    return this.postJson("/api/snapshots/query", request, signal);
  }

  snapshotDiff(request: SnapshotDiffRequest, signal?: AbortSignal): Promise<SnapshotDiffResponse> {
    return this.postJson("/api/snapshots/diff", request, signal);
  }

  async status(signal?: AbortSignal): Promise<StatusResponse> {
    return this.getJson<StatusResponse>("/api/status", signal);
  }

  async catalog(
    seconds: number,
    signal?: AbortSignal,
  ): Promise<MetricCatalogResponse> {
    const query = new URLSearchParams({seconds: String(seconds)});
    return this.getJson<MetricCatalogResponse>(`/api/catalog?${query}`, signal);
  }

  async plugin<T>(
    name: string,
    signal?: AbortSignal,
  ): Promise<PluginDocument<T>> {
    return this.getJson<PluginDocument<T>>(
      `/api/plugins/${encodeURIComponent(name)}`,
      signal,
    );
  }

  async rules(): Promise<AlertRuleConfig[]> {
    const response = await this.getJson<{rules: AlertRuleConfig[]}>("/api/rules");
    return response.rules;
  }

  async collectors(): Promise<CollectorDiagnostic[]> {
    const response = await this.getJson<{collectors: CollectorDiagnostic[]}>(
      "/api/collectors",
    );
    return response.collectors;
  }

  async experimentStats(): Promise<ExperimentStats> {
    return this.getJson<ExperimentStats>("/api/experiments/stats");
  }

  async projects(): Promise<ProjectRecord[]> {
    const response = await this.getJson<{projects: ProjectRecord[]}>(
      "/api/experiments/projects",
    );
    return response.projects;
  }

  async experiments(projectId?: string): Promise<ExperimentRecord[]> {
    const query = projectId
      ? `?${new URLSearchParams({project_id: projectId})}`
      : "";
    const response = await this.getJson<{experiments: ExperimentRecord[]}>(
      `/api/experiments/experiments${query}`,
    );
    return response.experiments;
  }

  async experimentRuns(experimentId?: string): Promise<ExperimentRun[]> {
    const query = experimentId
      ? `?${new URLSearchParams({experiment_id: experimentId})}`
      : "";
    const response = await this.getJson<{runs: ExperimentRun[]}>(
      `/api/experiments/runs${query}`,
    );
    return response.runs;
  }

  async experimentSources(runId?: string): Promise<ExperimentSource[]> {
    const query = runId
      ? `?${new URLSearchParams({run_id: runId})}`
      : "";
    const response = await this.getJson<{sources: ExperimentSource[]}>(
      `/api/experiments/sources${query}`,
    );
    return response.sources;
  }

  async queryExperimentMetrics(request: {
    run_id: string;
    source_ids?: string[];
    metrics: string[];
    axis: string;
    from?: number;
    to?: number;
    max_points?: number;
  }, signal?: AbortSignal): Promise<ExperimentQueryResponse> {
    return this.postJson<ExperimentQueryResponse>(
      "/api/experiments/query",
      request,
      signal,
    );
  }

  async queryExperimentSummaries(request: {
    run_ids: string[];
    metrics: string[];
    axis: string;
    from?: number;
    to?: number;
  }): Promise<ExperimentSummaryResponse> {
    return this.postJson<ExperimentSummaryResponse>(
      "/api/experiments/query-summaries",
      request,
    );
  }

  private async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {Accept: "application/json"},
      ...(signal ? {signal} : {}),
    });
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async postJson<T>(
    url: string,
    body: unknown,
    signal?: AbortSignal,
    method = "POST",
  ): Promise<T> {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...(signal ? {signal} : {}),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `${url} returned HTTP ${response.status}`);
    }
    if (url === "/api/snapshots/latest" || url === "/api/snapshots/history" || url === "/api/snapshots/diff") {
      return parseExactJson<object>(await response.text()) as T;
    }
    return (await response.json()) as T;
  }
}
