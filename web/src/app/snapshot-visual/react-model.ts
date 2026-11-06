import type {SnapshotAggregateGroup, SnapshotAggregateResponse, SnapshotAggregateSeries, SnapshotBarView, SnapshotRecordsResponse, SnapshotStatusView} from "../../domain/snapshot-views";
import type {TableCell, TableDataRow, TableFilter} from "../../domain/tables";
import {decimalDisplay} from "../decimal-display";
import {missingCell} from "../data-table-model";
import {temporalCellText} from "../time";
import {statusShade, statusShadeDomain} from "./shading";
import {activeTableFilters, type SnapshotVisualPanelSpec} from "../panels";

export function nativeFilters(spec: SnapshotVisualPanelSpec): TableFilter[] {return activeTableFilters(spec.query);}
export function visualQueryKey(spec: SnapshotVisualPanelSpec): string {
  const view = spec.view;
  return JSON.stringify([spec.path, spec.sourceIds, spec.query?.search ?? "", nativeFilters(spec),
    view.type === "bar" ? [view.type, view.categoryPath, view.valuePaths, view.aggregation, view.limit, view.order]
      : [view.type, view.idPaths, view.statusPath, view.labelPath, view.groupPath, view.valuePath, view.shadePath, view.sort]]);
}

export function cellText(cell: TableCell = missingCell, decimals?: number): string {
  const text = cell.kind === "missing" ? "missing" : cell.kind === "null" ? "null"
    : cell.kind === "number" && !cell.truncated ? decimalDisplay(cell.text, decimals)
    : cell.kind === "string" && !cell.text ? '""' : cell.text;
  return `${text}${cell.truncated ? " [preview]" : ""}`;
}
export function fieldCellText(path: string, cell: TableCell = missingCell): string {
  return temporalCellText(path, cell) ?? cellText(cell);
}
export function finiteNumber(cell: TableCell | undefined): number | null {
  if (cell?.kind !== "number" || cell.truncated || !cell.text.trim()) return null;
  const value = Number(cell.text);
  return Number.isFinite(value) ? value : null;
}
export function barMeasures(view: SnapshotBarView): {id: string; path?: string}[] {
  return view.aggregation === "count" ? [{id: "count"}] : view.valuePaths.map((path, index) => ({id: `m${index}`, path}));
}
export function segmentKey(group: string, series: Pick<SnapshotAggregateSeries, "run_id" | "source_id">, measure: string): string {
  return JSON.stringify([group, series.run_id, series.source_id, measure]);
}
export function barGeometry(groups: SnapshotAggregateGroup[], view: SnapshotBarView) {
  const measures = barMeasures(view), segments = new Map<string, {start: number; end: number; value: number | null}>();
  let magnitude = 0, minimum = 0, maximum = 0;
  for (const group of groups) for (const series of group.series) for (const measure of measures) {
    const value = finiteNumber(series.measures[measure.id]?.value);
    if (value !== null) magnitude = Math.max(magnitude, Math.abs(value));
  }
  for (const group of groups) for (const series of group.series) {
    let positive = 0, negative = 0;
    for (const measure of measures) {
      const value = finiteNumber(series.measures[measure.id]?.value), scaled = value === null || !magnitude ? 0 : value / magnitude;
      const start = view.layout !== "stacked" ? 0 : scaled < 0 ? negative : positive, end = start + scaled;
      if (view.layout === "stacked" && value !== null) {if (scaled < 0) negative = end; else positive = end;}
      minimum = Math.min(minimum, end); maximum = Math.max(maximum, end);
      segments.set(segmentKey(group.key, series, measure.id), {start, end, value});
    }
  }
  return {minimum, maximum: maximum === minimum ? maximum + 1 : maximum, segments};
}
export function tracePaint(color: string, tone: number): string {
  return tone % 8 === 0 ? color : `color-mix(in srgb, ${color} ${100 - tone % 8 * 6}%, var(--surface))`;
}
export function validateBars(data: SnapshotAggregateResponse, view: SnapshotBarView): void {
  const owners = new Set(data.groups.flatMap(group => group.series.map(series => JSON.stringify([series.run_id, series.source_id]))));
  if (owners.size * barMeasures(view).length > 64 || data.groups.length * owners.size * barMeasures(view).length > 2400)
    throw new Error(`${owners.size} Sources × ${barMeasures(view).length} fields × ${data.groups.length} categories exceeds this bar view's 64-trace / 2400-mark limit. Select fewer Runs, Sources, fields or categories.`);
}
export function statusKey(cell: TableCell): string {return JSON.stringify([cell.kind, cell.text]);}
const stateColors: Readonly<Record<string, string>> = {
  running: "#427fc4", pending: "#bd942d", mixed: "#926bb6", finished: "#39926a", succeeded: "#39926a",
  completed: "#39926a", failed: "#c75454", cancelled: "#7d8391", canceled: "#7d8391",
};
export function statusColor(cell: TableCell, colors?: Record<string, string>): string {
  const custom = colors && Object.hasOwn(colors, cell.text) ? colors[cell.text] : undefined;
  if (cell.kind !== "missing" && cell.kind !== "null" && custom && /^#[0-9a-f]{6}$/i.test(custom)) return custom;
  if (cell.kind === "missing") return "#a4aebb";
  if (cell.kind === "null") return "#9298a2";
  const raw = cell.text.toLowerCase();
  return Object.hasOwn(stateColors, raw) ? stateColors[raw]! : "#75889b";
}
export function statusTotals(response: SnapshotAggregateResponse): Map<string, string> {
  if (!Number.isSafeInteger(response.matched_rows) || response.matched_rows < 0 || response.offset !== 0
    || response.groups.length !== response.total_groups || response.total_groups > 128) throw new Error("Task status counts are incomplete.");
  const totals = new Map<string, string>();
  let all = 0n;
  for (const group of response.groups) {
    if (totals.has(group.key)) throw new Error("Task status groups are duplicated.");
    let count = 0n;
    for (const series of group.series) {
      const value = series.measures.count?.value;
      if (!value || value.kind !== "number" || value.truncated || !/^\d+$/.test(value.text)) throw new Error("Task status counts are invalid.");
      count += BigInt(value.text);
    }
    totals.set(group.key, count.toString()); all += count;
  }
  if (all !== BigInt(response.matched_rows)) throw new Error("Task status counts do not cover the full filtered dataset.");
  return totals;
}
export interface StatusTask {key: string; identity: string; record: TableDataRow; state: TableCell; label: string; group: string; groupLabel: string}
export function statusTasks(response: SnapshotRecordsResponse, view: SnapshotStatusView): StatusTask[] {
  if (response.identities.length !== response.rows.length) throw new Error("Task identities are not aligned with the record page.");
  const seen = new Set<string>();
  return response.rows.map((record, index) => {
    const identity = response.identities[index];
    if (typeof identity !== "string" || !identity) throw new Error("The record page has an invalid task identity.");
    const key = JSON.stringify([record.run_id, record.source_id, identity]);
    if (seen.has(key)) throw new Error("Task identities are not unique in the record page.");
    seen.add(key);
    const group = view.groupPath !== undefined ? record.cells[view.groupPath] ?? missingCell : undefined;
    return {key, identity, record, state: record.cells[view.statusPath] ?? missingCell,
      label: view.labelPath !== undefined ? fieldCellText(view.labelPath, record.cells[view.labelPath]) : view.idPaths.map(path => cellText(record.cells[path])).join(" · "),
      group: JSON.stringify([record.run_id, record.source_id, group ? statusKey(group) : ""]), groupLabel: group ? fieldCellText(view.groupPath!, group) : ""};
  }).sort((a, b) => a.group < b.group ? -1 : a.group > b.group ? 1 : 0);
}
export function gridGeometry(width: number, height: number, view: SnapshotStatusView, expanded: boolean, count = Infinity) {
  const gap = view.gap ?? 5, available = Math.max(1, width), budget = expanded ? 1800 : 800;
  let pitch = (view.cellSize ?? (view.density === "compact" ? 15 : 23)) + gap;
  const columns = () => Math.max(1, Math.min(view.columns ?? Infinity, Math.floor((available + gap) / pitch)));
  while (Math.min(count, columns() * (Math.ceil(height / pitch) + 5)) > budget - 1) pitch++;
  return {pitch, columns: columns(), size: Math.min(available, pitch - gap)};
}
/** Stage and validate the entire pinned frame before React can publish any new records. */
export function validateStatusFrame(records: SnapshotRecordsResponse, counts: SnapshotAggregateResponse, view: SnapshotStatusView): void {
  if (counts.total_groups > 128) throw new Error("More than 128 task states. Choose a categorical status field.");
  const pins = new Set(records.snapshots.map(snapshot => snapshot.snapshot_id));
  if (counts.matched_rows !== records.total || counts.groups.some(group => group.series.some(series => !pins.has(series.snapshot_id))))
    throw new Error("Task counts do not match the pinned record observation. Retry this snapshot.");
  const tasks = statusTasks(records, view);
  statusTotals(counts);
  if (view.shadePath !== undefined) {
    const domain = statusShadeDomain(counts, view.shadeScale ?? "log");
    for (const task of tasks) statusShade(task.record.cells[view.shadePath], domain);
  }
}
