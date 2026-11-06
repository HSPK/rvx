import {exactProperty} from "../core/exact-json";
import type {SnapshotAggregateResponse, SnapshotRecordsResponse} from "../domain/snapshot-views";
import type {SummaryRow, TableCell, TableDataRow, TableDefinition, TableRowsResponse} from "../domain/tables";
import type {RecordPanelProps} from "./panel-types";
import {activeTableFilters} from "./panels";
import {formatTime, humanize, metricName, observedTime, rangeBounds} from "./model";
import {type ViewColumn, type ViewRow} from "./data-table-model";
import {barMeasures, validateBars, validateStatusFrame} from "./snapshot-visual/react-model";

export const statisticColumns = [
  ["current", "Current"], ["minimum", "Min"], ["average", "Average"], ["p95", "P95"], ["maximum", "Max"],
  ["count", "Count"], ["missing", "Missing"], ["observations", "Observations"],
] as const;
export const summaryColumns: ViewColumn[] = [
  {id: "@metric", label: "Metric", width: 180}, {id: "@run", label: "Run", width: 170}, {id: "@source", label: "Reporter", width: 150}, {id: "@unit", label: "Unit", width: 80},
  ...statisticColumns.map(([id, label]) => ({id, label, numeric: true, width: id === "count" || id === "missing" || id === "observations" ? 90 : 130})),
  {id: "@observed", label: "Observed", width: 175},
];
const cell = (text: string, kind: TableCell["kind"] = "string"): TableCell => ({kind, text, truncated: false});
export function snapshotColumns(definition: TableDefinition): ViewColumn[] {
  return [{id: "$key", label: "Key", width: 100}, ...definition.columns.filter(column => column.path !== "$key").map(column => ({
    id: column.path, label: column.name, ...(column.kinds?.includes("number") ? {numeric: true} : {}),
  })), {id: "@run", label: "Run", width: 170, sortable: false, filterable: false},
  {id: "@source", label: "Reporter", width: 150, sortable: false, filterable: false},
  {id: "@observed", label: "Observed", width: 175, sortable: false, filterable: false}];
}
export type RecordFrame =
  | {kind: "summary"; rows: SummaryRow[]; registeredSources: Map<string, {label: string}>; unavailable: string[]}
  | {kind: "table"; definition: TableDefinition | null; response: TableRowsResponse | null; partial: boolean}
  | {kind: "bar"; definition: TableDefinition; response: SnapshotAggregateResponse; partial: boolean}
  | {kind: "status"; definition: TableDefinition; records: SnapshotRecordsResponse; counts: SnapshotAggregateResponse; partial: boolean};

/** Every browse starts at latest; only an out-of-range retry and the status counts are pinned. */
export async function readRecordFrame(props: RecordPanelProps, offset: number, signal: AbortSignal, fresh: boolean): Promise<RecordFrame> {
  const {spec, runs, range, catalog, reads} = props, runIds = runs.map(run => run.id);
  if (spec.sourceIds && !spec.sourceIds.length) throw new Error(spec.kind === "snapshot-table" && spec.view
    ? "Select at least one Source in the snapshot editor." : "Select at least one reporter in the panel editor.");
  if (spec.kind === "metric-table") {
    if (!catalog.axes.includes(range.axis)) throw new Error("This alignment is not recorded. Choose another time alignment.");
    const indexed = new Set(catalog.metrics.filter(metric => !spec.sourceIds || metric.sources.some(source => spec.sourceIds!.includes(source.source_id))).map(metric => metric.path));
    const paths = spec.paths.filter(path => indexed.has(path)), unavailable = spec.paths.filter(path => !indexed.has(path));
    if (!paths.length) return {kind: "summary", rows: [], registeredSources: new Map(), unavailable};
    const sourceIds = spec.sourceIds ?? [...new Set(catalog.metrics.filter(metric => paths.includes(metric.path)).flatMap(metric => metric.sources.map(source => source.source_id)))];
    const response = await reads.summary({run_ids: runIds, paths, axis: range.axis, ...rangeBounds(range, catalog), source_ids: sourceIds}, signal, fresh);
    const known = new Set(catalog.metrics.flatMap(metric => metric.sources.map(source => source.source_id)));
    const registeredSources = new Map<string, {label: string}>();
    for (const id of [...new Set(response.rows.filter(row => !known.has(row.source_id)).map(row => row.run_id))]) {
      for (const source of await reads.sources(id, signal)) registeredSources.set(source.id, {
        label: `${humanize(source.role)}${source.rank === null ? source.node_id ? ` · ${source.node_id}` : "" : ` ${source.rank}`}`,
      });
    }
    return {kind: "summary", rows: response.rows, registeredSources, unavailable};
  }
  const discovery = await reads.tables({run_ids: runIds, ...(spec.sourceIds ? {source_ids: spec.sourceIds} : {})}, signal, fresh);
  const definition = discovery.tables.find(table => table.path === spec.path) ?? null;
  if (!definition) {
    if (spec.view) throw new Error(`This collection is ${discovery.truncated ? "unavailable in the partial catalog" : "not recorded in the selected Sources"}. Edit the snapshot to choose another collection.`);
    return {kind: "table", definition: null, response: null, partial: discovery.truncated};
  }
  const sourceIds = [...new Set(definition.sources.filter(source => runIds.includes(source.run_id)
    && (!spec.sourceIds || spec.sourceIds.includes(source.source_id))).map(source => source.source_id))].sort();
  if (!sourceIds.length) throw new Error("No selected Source snapshots record this collection.");
  const common = {run_ids: runIds, source_ids: sourceIds, path: spec.path, search: spec.query?.search ?? "", filters: activeTableFilters(spec.query)};
  const view = spec.view;
  if (view?.type === "bar") {
    const measures = barMeasures(view).map(measure => ({...measure, op: view.aggregation}));
    const response = await reads.aggregate({...common, group_by: [view.categoryPath], measures, offset: 0, limit: view.limit,
      ...(view.order === "label" ? {} : {order: {measure: measures[0]!.id, direction: view.order === "value-asc" ? "asc" as const : "desc" as const}})}, signal, fresh);
    validateBars(response, view);
    return {kind: "bar", definition, response, partial: discovery.truncated};
  }
  if (view?.type === "status-grid") {
    const columns = [...new Set([...view.idPaths, view.statusPath, ...[view.labelPath, view.groupPath, view.valuePath, view.shadePath].filter((path): path is string => path !== undefined)])];
    const query = {...common, columns, identity_paths: [...view.idPaths], offset, limit: 1000, ...(view.sort ? {sort: {...view.sort}} : {})};
    let records = await reads.records(query, signal, fresh);
    const lastPage = Math.max(0, Math.ceil(records.total / 1000) - 1) * 1000;
    if (offset > lastPage) records = await reads.records({...query, offset: lastPage,
      snapshot_ids: [...new Set(records.snapshots.map(snapshot => snapshot.snapshot_id))]}, signal, true);
    const measures = [{id: "count", op: "count" as const}, ...(view.shadePath !== undefined
      ? [{id: "shade_min", op: "min" as const, path: view.shadePath}, {id: "shade_max", op: "max" as const, path: view.shadePath}] : [])];
    const counts = await reads.aggregate({...common, snapshot_ids: [...new Set(records.snapshots.map(snapshot => snapshot.snapshot_id))],
      group_by: [view.statusPath], measures, offset: 0, limit: 128}, signal, fresh);
    validateStatusFrame(records, counts, view);
    return {kind: "status", definition, records, counts, partial: discovery.truncated};
  }
  const columns = snapshotColumns(definition), preferences = spec.columns ?? columns.map((column, index) => ({id: column.id, hidden: index >= 11 && !column.id.startsWith("@")}));
  const selected = definition.columns.filter(column => column.path === "$key" || !preferences.find(pref => pref.id === column.path)?.hidden).map(column => column.path);
  const sort = spec.query?.sort;
  const query = {...common, columns: [...new Set([...selected, ...common.filters.map(filter => filter.path), ...(sort ? [sort.path] : [])])],
    ...(sort ? {sort} : {}), offset, limit: 75};
  let response = await reads.rows(query, signal, fresh);
  const lastPage = Math.max(0, Math.ceil(response.total / 75) - 1) * 75;
  if (offset > lastPage) response = await reads.rows({...query, offset: lastPage, snapshot_ids: response.snapshots.map(snapshot => snapshot.snapshot_id)}, signal, true);
  return {kind: "table", definition, response, partial: discovery.truncated};
}

export function summaryViewRows(frame: Extract<RecordFrame, {kind: "summary"}>, props: RecordPanelProps): ViewRow[] {
  return frame.rows.map(summary => {
    const metric = props.catalog.metrics.find(metric => metric.path === summary.path), run = props.runs.find(run => run.id === summary.run_id);
    const source = metric?.sources.find(source => source.source_id === summary.source_id)
      ?? props.catalog.metrics.flatMap(metric => metric.sources).find(source => source.source_id === summary.source_id) ?? frame.registeredSources.get(summary.source_id);
    const runName = run ? props.labelFor(run) : summary.run_id, name = metric ? metricName(metric) : summary.path;
    const cells: Record<string, TableCell> = {"@metric": cell(name), "@run": cell(runName), "@source": cell(source?.label ?? "Reporter"),
      "@unit": cell(metric?.unit ?? "—"), "@observed": cell(observedTime(summary.observed_at_ns))};
    for (const [id] of statisticColumns) cells[id] = summary[id] === null ? cell("null", "null") : cell(exactProperty(summary, id), "number");
    return {key: JSON.stringify([summary.run_id, summary.source_id, summary.path]), cells, snapshotId: summary.snapshot_id,
      title: `${runName} ${name}`, cellTitles: {"@observed": formatTime(summary.observed_at_ns)}};
  });
}
export function snapshotViewRows(response: TableRowsResponse, runName: (id: string) => string): ViewRow[] {
  return response.rows.map(record => {
    const snapshot = response.snapshots.find(snapshot => snapshot.snapshot_id === record.snapshot_id);
    return {key: recordKey(record), snapshotId: record.snapshot_id, title: `${runName(record.run_id)} row ${record.row_key}`,
      cellTitles: {"@observed": formatTime(snapshot?.observed_at_ns)}, cells: {...record.cells, "$key": record.cells.$key ?? cell(record.row_key),
        "@run": cell(runName(record.run_id)), "@source": cell(snapshot?.label ?? "Reporter"), "@observed": cell(observedTime(snapshot?.observed_at_ns))}};
  });
}
export function recordKey(record: TableDataRow): string {return JSON.stringify([record.run_id, record.source_id, record.row_key]);}
