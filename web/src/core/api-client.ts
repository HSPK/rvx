import type {ExperimentRecord, ExperimentRun, ExperimentSource, ExperimentStats, ProjectRecord} from "../domain/types";
import type {ChartCatalog, SnapshotQueryRequest, SnapshotQueryResponse} from "../domain/snapshots";
import {recordReadWeight} from "./read-weight";
import {parseExactJson, parseExactProjection, stringifyExact} from "./exact-json";
import type {SummaryRequest, SummaryResponse, TableCatalogRequest, TableCatalogResponse, TableRowsRequest, TableRowsResponse} from "../domain/tables";
import {assertAuthenticated, requireAuthentication} from "../auth/session";
import type {SnapshotAggregateRequest, SnapshotAggregateResponse, SnapshotRecordsRequest, SnapshotRecordsResponse} from "../domain/snapshot-views";

/** Keep failed HTTP status and readable server details without exposing transport wrappers. */
export function httpErrorMessage(status: number, body: string, contentType: string | null): string {
  if (status === 401) return "Sign in to continue.";
  let detail = body.trim();
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (detail && (mediaType === "application/json" || mediaType?.endsWith("+json"))) {
    if (detail.length > 16 * 1024) detail = "The server returned oversized error details.";
    else {
      try {
        const value: unknown = JSON.parse(detail);
        detail = typeof value === "string" ? value
          : value !== null && typeof value === "object" && "error" in value && typeof value.error === "string"
            ? value.error : "The server returned no readable error details.";
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        detail = "The server returned malformed error details.";
      }
    }
  } else if (detail.startsWith("<")) detail = "";
  detail = detail.trim();
  if (detail.length > 400) detail = `${detail.slice(0, 400)}…`;
  return `Request failed (${status})${detail ? `: ${detail}` : "."}`;
}

export class ApiClient {
  async projects(signal?: AbortSignal): Promise<ProjectRecord[]> {
    return (await this.request<{projects: ProjectRecord[]}>("/api/experiments/projects", undefined, signal)).projects;
  }
  async experiments(signal?: AbortSignal): Promise<ExperimentRecord[]> {
    return (await this.request<{experiments: ExperimentRecord[]}>("/api/experiments/experiments", undefined, signal)).experiments;
  }
  async runs(signal?: AbortSignal): Promise<ExperimentRun[]> {
    return (await this.request<{runs: ExperimentRun[]}>("/api/experiments/runs", undefined, signal)).runs;
  }
  async sources(runId: string, signal?: AbortSignal): Promise<ExperimentSource[]> {
    return (await this.request<{sources: ExperimentSource[]}>(`/api/experiments/sources?${new URLSearchParams({run_id: runId})}`, undefined, signal)).sources;
  }
  stats(signal?: AbortSignal): Promise<ExperimentStats> {
    return this.request("/api/experiments/stats", undefined, signal);
  }
  catalog(runIds: string[], signal?: AbortSignal): Promise<ChartCatalog> {
    return this.request("/api/charts/catalog", {run_ids: runIds}, signal);
  }
  query(body: SnapshotQueryRequest, signal?: AbortSignal): Promise<SnapshotQueryResponse> {
    return this.request("/api/snapshots/query", body, signal, true);
  }
  /** Read true per-reporter statistics over all indexed observations, never visual samples. */
  tableSummary(body: SummaryRequest, signal?: AbortSignal): Promise<SummaryResponse> {
    return this.request("/api/tables/summary", body, signal, true);
  }
  /** Discover generic snapshot collections without downloading raw states. */
  tableCatalog(body: TableCatalogRequest, signal?: AbortSignal): Promise<TableCatalogResponse> {
    return this.request("/api/tables/catalog", body, signal);
  }
  /** Delegate exact-cell filtering, numeric sorting and pinned pagination to the server. */
  tableRows(body: TableRowsRequest, signal?: AbortSignal): Promise<TableRowsResponse> {
    return this.request("/api/tables/rows", body, signal);
  }
  /** Read bounded current records with stable identities rather than loading raw snapshots into the UI. */
  snapshotRecords(body: SnapshotRecordsRequest, signal?: AbortSignal): Promise<SnapshotRecordsResponse> {
    return this.request("/api/snapshots/records", body, signal);
  }
  /** Aggregate the full filtered collection while retaining separate Run/Source series. */
  snapshotAggregate(body: SnapshotAggregateRequest, signal?: AbortSignal): Promise<SnapshotAggregateResponse> {
    return this.request("/api/snapshots/aggregate", body, signal);
  }
  private async request<T>(url: string, body?: unknown, signal?: AbortSignal, exact = false): Promise<T> {
    assertAuthenticated();
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {Accept: "application/json", ...(body === undefined ? {} : {"Content-Type": "application/json"})},
      ...(body === undefined ? {} : {body: stringifyExact(body)}),
      ...(signal ? {signal} : {}),
    });
    if (!response.ok) {
      if (response.status === 401) throw requireAuthentication();
      throw new Error(httpErrorMessage(response.status, await response.text(), response.headers.get("content-type")));
    }
    const text = await response.text();
    const value: unknown = url === "/api/snapshots/query"
      ? await parseExactProjection(text, signal)
      : exact ? parseExactJson<object>(text) : JSON.parse(text);
    recordReadWeight(value, text.length);
    return value as T;
  }
}
