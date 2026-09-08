import type {ChartCatalog, ChartMetric, ChartMetricSource, SnapshotQuerySeries} from "../domain/snapshots";
import {exactProperty} from "../core/exact-json";
import type {ExperimentRecord, ExperimentRun} from "../domain/types";

export interface ChartPresentation {
  title?: string;
  style?: "line" | "area";
  lineWidth?: number;
  points?: boolean;
  legend?: "auto" | "show" | "hide";
  yMin?: number;
  yMax?: number;
}
export interface ChartSpec {path: string; paths?: string[]; size: "normal" | "wide"; presentation?: ChartPresentation}
export interface RangeState {axis: string; window: string; from?: number; to?: number}
export const timeWindowChoices: [string, string][] = [
  ["900", "15m"], ["3600", "1h"], ["21600", "6h"], ["86400", "24h"],
  ["259200", "3d"], ["604800", "7d"], ["all", "All"], ["custom", "Custom…"],
];
export interface RunFilters {project: string; experiment: string; status: string; search: string}
export type Route = {kind: "workspace"; runIds: string[] | null} | {kind: "missing"};

/** Copy display configuration without sharing mutable options with saved sets or editor drafts. */
export function copyChart(spec: ChartSpec): ChartSpec {
  return {path: spec.path, ...(spec.paths ? {paths: [...spec.paths]} : {}), size: spec.size, ...(spec.presentation ? {presentation: {...spec.presentation}} : {})};
}

/** Validate only supported display settings; old current-format path/size records remain valid. */
export function validChartSpec(value: unknown): value is ChartSpec {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path.startsWith("/") || (value.size !== "normal" && value.size !== "wide")) return false;
  if (value.paths !== undefined && (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 64 || !value.paths.every(path => typeof path === "string" && path.startsWith("/")) || new Set(value.paths).size !== value.paths.length || !value.paths.includes(value.path))) return false;
  if (value.presentation === undefined) return true;
  const display = value.presentation;
  if (!isRecord(display) || Object.keys(display).some(key => !["title", "style", "lineWidth", "points", "legend", "yMin", "yMax"].includes(key))) return false;
  if (display.title !== undefined && (typeof display.title !== "string" || !display.title.trim() || display.title.length > 120)) return false;
  if (display.style !== undefined && display.style !== "line" && display.style !== "area") return false;
  if (display.lineWidth !== undefined && (typeof display.lineWidth !== "number" || !Number.isFinite(display.lineWidth) || display.lineWidth < .5 || display.lineWidth > 6)) return false;
  if (display.points !== undefined && typeof display.points !== "boolean") return false;
  if (display.legend !== undefined && display.legend !== "auto" && display.legend !== "show" && display.legend !== "hide") return false;
  for (const value of [display.yMin, display.yMax]) if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) return false;
  return !(typeof display.yMin === "number" && typeof display.yMax === "number" && display.yMin >= display.yMax);
}

/** Resolve a single chart or explicitly combined metric selection without changing metric identity. */
export function chartPaths(spec: ChartSpec): string[] {return spec.paths ?? [spec.path];}

/** Permit one shared value scale only when all selected metrics declare the same unit. */
export function compatibleMetrics(metrics: ChartMetric[]): boolean {
  return new Set(metrics.map(metric => metric.unit)).size <= 1;
}

/** Narrow untrusted preference objects before reading or validating their fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keep absent selection distinct from an explicit empty selection on the only analysis route. */
export function routeFrom(url: URL): Route {
  if (url.pathname !== "/rvx" && url.pathname !== "/rvx/") return {kind: "missing"};
  return {kind: "workspace", runIds: url.searchParams.has("runs") ? [...new Set((url.searchParams.get("runs") ?? "").split(",").filter(Boolean))] : null};
}

/** Share selected runs, rail scope, and axis bounds without persisting snapshot contents. */
export function workspaceUrl(runIds: string[], range?: RangeState, filters?: RunFilters): string {
  const url = new URL("/rvx", location.origin);
  url.searchParams.set("runs", runIds.join(","));
  if (range) {
    url.searchParams.set("axis", range.axis);
    url.searchParams.set("range", range.window);
    if (range.from !== undefined) url.searchParams.set("from", String(range.from));
    if (range.to !== undefined) url.searchParams.set("to", String(range.to));
  }
  if (filters) for (const [key, value] of [["project", filters.project], ["experiment", filters.experiment], ["status", filters.status], ["q", filters.search]]) if (value) url.searchParams.set(key!, value);
  return url.pathname + url.search;
}

/** Use one observation-based time model regardless of how many runs are selected. */
export function initialRange(url: URL): RangeState {
  const integer = (key: string): number | undefined => {
    const text = url.searchParams.get(key);
    return text && /^-?\d+$/.test(text) && Number.isFinite(Number(text)) ? Number(text) : undefined;
  };
  const axis = url.searchParams.get("axis") ?? "elapsed";
  const from = integer("from"), to = integer("to");
  const requested = url.searchParams.get("range") ?? (from !== undefined || to !== undefined ? "custom" : "all");
  const window = !["wall_time", "elapsed"].includes(axis) && requested !== "custom" ? "all" : requested;
  return {axis, window: timeWindowChoices.some(([value]) => value === window) ? window : "all",
    ...(from === undefined ? {} : {from}), ...(to === undefined ? {} : {to})};
}

/** Restore rail filters independently of the selected traces. */
export function filtersFrom(url: URL): RunFilters {
  return {project: url.searchParams.get("project") ?? "", experiment: url.searchParams.get("experiment") ?? "", status: url.searchParams.get("status") ?? "", search: url.searchParams.get("q") ?? ""};
}

/** Scope discovery without ever silently changing the user's selected runs. */
export function filteredRuns(runs: ExperimentRun[], experiments: ExperimentRecord[], filters: RunFilters): ExperimentRun[] {
  const byId = new Map(experiments.map(experiment => [experiment.id, experiment]));
  const query = filters.search.toLocaleLowerCase().trim();
  return runs.filter(run => (!filters.project || byId.get(run.experiment_id)?.project_id === filters.project)
    && (!filters.experiment || run.experiment_id === filters.experiment)
    && (!filters.status || run.status === filters.status)
    && (!query || `${run.name} ${run.id} ${byId.get(run.experiment_id)?.name ?? ""}`.toLocaleLowerCase().includes(query)));
}

/** Anchor recorded windows to catalog observations, leaving logical bounds in their own units. */
export function rangeBounds(range: RangeState, catalog: ChartCatalog): {from?: number; to?: number} {
  if (range.window === "custom") return {
    ...(range.from === undefined ? {} : {from: range.from}),
    ...(range.to === undefined ? {} : {to: range.to}),
  };
  if (range.window === "all" || !["wall_time", "elapsed"].includes(range.axis)) return {};
  const ends = catalog.runs.flatMap(run => run.last_observed_at_ns === null ? [] : [
    range.axis === "elapsed" ? run.last_observed_at_ns - (run.first_observed_at_ns ?? run.last_observed_at_ns) : run.last_observed_at_ns,
  ]);
  if (!ends.length) return {};
  const to = Math.max(...ends);
  return {from: Math.max(0, to - Number(range.window) * 1e9), to};
}

/** Prefer exactly one declared primary; otherwise preserve distinct reporter traces. */
export function reporters(metric: ChartMetric, runId: string): ChartMetricSource[] {
  const available = metric.sources.filter(source => source.run_id === runId);
  const primary = available.filter(source => source.primary);
  return primary.length === 1 ? primary : available;
}
/** Identify fields that need an explicit multi-reporter choice before automatic plotting. */
export function isAmbiguous(metric: ChartMetric): boolean {
  return metric.run_ids.some(runId => reporters(metric, runId).length > 1);
}
/** Use only meaningful catalog defaults that do not require reporter disambiguation. */
export function defaultCharts(catalog: ChartCatalog): ChartSpec[] {
  return catalog.defaults.filter(path => {
    const metric = catalog.metrics.find(item => item.path === path);
    return metric && !isAmbiguous(metric);
  }).slice(0, 6).map(path => ({path, size: "normal"}));
}
/** Isolate unavailable saved fields so they cannot invalidate healthy projection batches. */
export function partitionCatalogPaths(paths: string[], catalog: ChartCatalog): {metrics: ChartMetric[]; missing: string[]} {
  const indexed = new Map(catalog.metrics.map(metric => [metric.path, metric]));
  const metrics: ChartMetric[] = [], missing: string[] = [];
  for (const path of paths) {
    const metric = indexed.get(path);
    if (metric) metrics.push(metric); else missing.push(path);
  }
  return {metrics, missing};
}
/** Name elapsed time by its observation origin rather than implying a training start. */
export function axisLabel(axis: string): string {
  return axis === "wall_time" ? "Observation time" : axis === "elapsed" ? "Since first observation" : humanize(axis);
}
/** Turn protocol identifiers into readable labels without guessing metric semantics. */
export function humanize(text: string): string {
  const words = text.replace(/[_-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
/** Show an explicitly declared unit once without renaming the metric's meaning. */
export function metricName(metric: Pick<ChartMetric, "name" | "unit">): string {
  if (!metric.unit) return metric.name;
  const suffixes: Record<string, string[]> = {"%": ["percent", "pct"], bytes: ["bytes"], s: ["seconds"], "°C": ["c"]};
  for (const suffix of suffixes[metric.unit] ?? [metric.unit]) {
    if (metric.name.toLowerCase().endsWith(` ${suffix.toLowerCase()}`)) {
      const name = metric.name.slice(0, -suffix.length).trimEnd();
      if (name) return name;
    }
  }
  return metric.name;
}
export const palette = ["#4869d9", "#c15c32", "#15917d", "#9965c1", "#bc4c79", "#85712e"];
/** Derive a run's preferred hue independently of chart order and reporter identities. */
export function runColor(runId: string): string {
  let hash = 0;
  for (const character of runId) hash = Math.imul(hash, 31) + character.charCodeAt(0) | 0;
  return palette[(hash >>> 0) % palette.length]!;
}
export class RunColors {
  private colors = new Map<string, string>();
  private overrides: Record<string, string> = {};
  /** Resolve palette collisions without changing hues of runs still being compared. */
  assign(runIds: string[], overrides = this.overrides): void {
    for (const id of new Set([...Object.keys(this.overrides), ...Object.keys(overrides)])) {
      if (this.overrides[id] !== overrides[id]) this.colors.delete(id);
    }
    this.overrides = {...overrides};
    for (const id of runIds) if (overrides[id]) this.colors.set(id, overrides[id]!);
    const used = new Set(runIds.flatMap(id => this.colors.has(id) ? [this.colors.get(id)!.toLowerCase()] : []));
    for (const id of runIds) if (!this.colors.has(id)) {
      const preferred = runColor(id);
      const color = used.has(preferred) ? palette.find(candidate => !used.has(candidate)) ?? preferred : preferred;
      this.colors.set(id, color); used.add(color.toLowerCase());
    }
    // Unselected runs can reuse a color later, but currently selected runs never change hue.
    for (const id of this.colors.keys()) if (!runIds.includes(id)) this.colors.delete(id);
  }
  /** Use the comparison assignment consistently across legends, chips, and traces. */
  get(runId: string): string {return this.overrides[runId] ?? this.colors.get(runId) ?? runColor(runId);}
}
/** Recover the exact stored ID even when its arithmetic value exceeds JavaScript precision. */
export function pointId(series: SnapshotQuerySeries, index: number): string {
  return exactProperty(series.snapshot_ids, String(index));
}
/** Keep chart labels compact while distinguishing missing values from numeric zero. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value !== 0 && (Math.abs(value) < .001 || Math.abs(value) >= 1e7)) return value.toExponential(2);
  return new Intl.NumberFormat(undefined, {maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2, notation: Math.abs(value) >= 10_000 ? "compact" : "standard"}).format(value);
}
/** Present observation timestamps in local time with an explicit no-observation state. */
export function formatTime(ns: number | null | undefined): string {
  return ns == null ? "No observations" : new Date(ns / 1e6).toLocaleString(undefined, {year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"});
}
/** A compact observation clock keeps full dates available in the accompanying tooltip. */
export function observedTime(ns: number | null | undefined): string {
  return ns == null ? "—" : new Date(ns / 1e6).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
}
/** Express observation spans compactly without changing their underlying nanosecond units. */
export function duration(ns: number): string {
  const seconds = Math.max(0, ns / 1e9);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
