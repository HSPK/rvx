import {useEffect, useMemo, useRef, useState} from "react";
import {ChevronLeft, ChevronRight, LayoutGrid} from "lucide-react";
import {Button} from "../components/ui/button";
import type {SnapshotView} from "../domain/snapshot-views";
import type {RecordPanelProps} from "./panel-types";
import {PanelFrame} from "./panel-frame";
import {DataTable, RecordQueryToolbar} from "./data-table";
import {collectionLabel, filterSummaryRows, tablePageSize, type ViewRow} from "./data-table-model";
import {activeTableFilters, type TableQueryPreference} from "./panels";
import {readRecordFrame, recordKey, snapshotColumns, snapshotViewRows, summaryColumns, summaryViewRows, type RecordFrame} from "./record-panel-model";
import {SnapshotBars} from "./snapshot-visual/react-bar";
import {SnapshotArrangement, SnapshotStatus} from "./snapshot-visual/react-status";
import {SnapshotDetails, type DetailSelection, type VisualNames} from "./snapshot-visual/react-details";
import {statusTasks} from "./snapshot-visual/react-model";
import {IconButton} from "./react-ui";
import "./snapshot-visual/styles.css";

/** React owns every cell, mark, control and overlay; one effect owns each visible native read. */
export function RecordPanel(props: RecordPanelProps) {
  const {spec, runs, range, reads, active, refreshRevision, onChange, onAction} = props;
  const visual = spec.kind === "snapshot-table" ? spec.view : undefined;
  const query = spec.query ?? {};
  const [offsetState, setOffsetState] = useState({key: "", value: 0});
  const [committed, setCommitted] = useState<{scope: string; transport: string; frame: RecordFrame; view: SnapshotView | undefined} | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{key: string; text: string} | null>(null);
  const [retry, setRetry] = useState(0), [arrange, setArrange] = useState(false);
  const [selection, setSelection] = useState<DetailSelection | null>(null);
  const current = useRef(props); current.current = props;
  const request = useRef<AbortController | null>(null);
  const runIds = runs.map(run => run.id).sort();
  const scope = JSON.stringify([runIds, spec.kind, spec.kind === "metric-table" ? spec.paths : spec.path, spec.sourceIds,
    spec.kind === "metric-table" ? [range.axis, range.window, range.from, range.to] : null,
    visual?.type === "bar" ? [visual.type, visual.categoryPath, visual.valuePaths, visual.aggregation]
      : visual ? [visual.type, visual.idPaths, visual.statusPath, visual.labelPath, visual.groupPath, visual.valuePath] : null]);
  const criteria = JSON.stringify([scope, query.search ?? "", activeTableFilters(query),
    visual?.type === "bar" ? [visual.limit, visual.order] : visual?.type === "status-grid" ? [visual.sort, visual.shadePath] : query.sort]);
  const offset = offsetState.key === criteria ? offsetState.value : 0;
  const transport = JSON.stringify([scope, spec.kind === "metric-table" ? null : [criteria, offset,
    visual ? null : (spec.columns ?? []).filter(column => column.hidden).map(column => column.id).sort()],
    spec.kind === "metric-table" ? props.catalog.axes.includes(range.axis) : null,
    spec.kind === "metric-table" ? props.catalog.metrics.filter(metric => spec.paths.includes(metric.path)).map(metric => [metric.path, metric.sources.map(source => source.source_id)]) : null]);
  const requestKey = `${transport}:${retry}`;
  const frame = committed?.scope === scope ? committed.frame : null;
  const pending = active && runs.length > 0 && pendingKey === requestKey;
  const error = failure?.key === requestKey ? failure.text : null;
  useEffect(() => {
    setSelection(null); setArrange(false);
  }, [scope, active]);
  const load = useRef(() => {});
  load.current = () => {
    if (request.current || !active || !runIds.length || document.hidden) return;
    const controller = new AbortController();
    request.current = controller;
    setPendingKey(requestKey); setFailure(null);
    const previous = committed?.transport === transport ? committed.frame : null;
    const latestOffset = previous?.kind === "status" ? previous.records.offset : previous?.kind === "table" ? previous.response?.offset ?? offset : offset;
    void readRecordFrame(current.current, current.current.spec.kind === "metric-table" ? 0 : latestOffset, controller.signal, true).then(next => {
      if (!controller.signal.aborted) setCommitted({scope, transport, frame: next, view: visual});
    }).catch(error => {
      if (!controller.signal.aborted) setFailure({key: requestKey, text: error instanceof Error ? error.message : String(error)});
    }).finally(() => {if (request.current === controller) {request.current = null; if (!controller.signal.aborted) setPendingKey(null);}});
  };
  useEffect(() => {
    load.current();
    return () => {request.current?.abort(); request.current = null;};
  }, [active, requestKey, reads]);
  const previousRevision = useRef(refreshRevision);
  useEffect(() => {
    if (previousRevision.current === refreshRevision) return;
    previousRevision.current = refreshRevision;
    load.current();
  }, [refreshRevision]);
  const names: VisualNames = useMemo(() => ({
    runName: id => {const props = current.current, run = props.runs.find(run => run.id === id); return run ? props.labelFor(run) : id;},
    fieldName: path => {
      const definition = frame && "definition" in frame ? frame.definition : null;
      return definition?.columns.find(column => column.path === path)?.name ?? (path === "$key" ? "Key" : path === "$value" || path === "" ? "Value" : path.replace(/^\//, "").replaceAll("~1", "/").replaceAll("~0", "~"));
    }, colorFor: props.colorFor,
  }), [frame, props.colorFor, props.labelFor, runs]);
  const columns = spec.kind === "metric-table" ? summaryColumns : frame && "definition" in frame && frame.definition ? snapshotColumns(frame.definition) : [{id: "$key", label: "Key"}];
  const preferences = spec.columns ?? columns.map((column, index) => ({id: column.id, ...(index >= 11 && !column.id.startsWith("@") ? {hidden: true} : {})}));
  const summaryRows = frame?.kind === "summary" ? filterSummaryRows(summaryViewRows(frame, props), query) : [];
  const summaryOffset = Math.min(offset, Math.max(0, Math.ceil(summaryRows.length / tablePageSize) - 1) * tablePageSize);
  const tableResponse = frame?.kind === "table" ? frame.response : null;
  const rows: ViewRow[] = frame?.kind === "summary" ? summaryRows.slice(summaryOffset, summaryOffset + tablePageSize)
    : tableResponse ? snapshotViewRows(tableResponse, names.runName) : [];
  const tableOffset = frame?.kind === "summary" ? summaryOffset : tableResponse?.offset ?? 0;
  const total = frame?.kind === "summary" ? summaryRows.length : tableResponse?.total ?? 0;
  const title = spec.title || (spec.kind === "metric-table" ? "Metric statistics" : frame && "definition" in frame && frame.definition
    ? collectionLabel(frame.definition) : visual ? "Snapshot" : "Snapshot table");
  function changeQuery(next: TableQueryPreference) {setSelection(null); onChange({...spec, query: next});}
  function page(value: number) {setSelection(null); setOffsetState({key: criteria, value});}
  const snapshots = frame?.kind === "bar" ? frame.response.snapshots : frame?.kind === "status" ? frame.records.snapshots : tableResponse?.snapshots ?? [];
  const missingRuns = spec.kind === "snapshot-table" && frame && (visual || spec.sourceIds === undefined)
    ? runs.filter(run => !snapshots.some(snapshot => snapshot.run_id === run.id)).length : 0;
  const taskList = frame?.kind === "status" && visual?.type === "status-grid" ? statusTasks(frame.records, visual) : [];
  const detailRecords = frame?.kind === "status" ? taskList.map(task => ({record: task.record, snapshot: snapshots.find(snapshot => snapshot.snapshot_id === task.record.snapshot_id), title: task.label}))
    : tableResponse?.rows.map(record => ({record, snapshot: snapshots.find(snapshot => snapshot.snapshot_id === record.snapshot_id), title: `${names.runName(record.run_id)} row ${record.row_key}`})) ?? [];
  const detailIndex = selection ? detailRecords.findIndex(item => recordKey(item.record) === recordKey(selection.record)) : -1;
  const statusView = visual?.type === "status-grid" ? {...visual} : null;
  if (statusView && frame?.kind === "status" && committed?.view?.type === "status-grid" && committed.view.shadePath !== statusView.shadePath) {
    if (committed.view.shadePath === undefined) delete statusView.shadePath; else statusView.shadePath = committed.view.shadePath;
    if (committed.view.shadeScale === undefined) delete statusView.shadeScale; else statusView.shadeScale = committed.view.shadeScale;
  }
  const notRecorded = frame?.kind === "table" && !frame.definition || frame?.kind === "summary" && spec.kind === "metric-table" && frame.unavailable.length === spec.paths.length;
  const status = error ? frame ? visual ? "Update failed" : "Refresh failed" : "Request failed" : pending && !frame ? "Loading…" : notRecorded ? "Not recorded" : "";
  return <PanelFrame spec={spec} title={title} unit={visual?.type === "bar" ? visual.unit ?? null : null} refreshing={pending}
    status={status} loaded={Boolean(frame)} path={spec.kind === "snapshot-table" ? spec.path : spec.paths.join(",")} {...(visual ? {view: visual.type} : {})}
    className={visual ? "snapshot-visual-card" : "table-card"} onAction={onAction}>
    {visual && <RecordQueryToolbar columns={columns} query={query} onChange={changeQuery} visual actions={visual.type === "status-grid" && <Button variant="ghost" className="button quiet"
      disabled={!frame} aria-haspopup="dialog" aria-expanded={arrange} onClick={() => setArrange(true)}><LayoutGrid />Arrange</Button>} />}
    {!runs.length && <div className="table-feedback muted" role="status">Select runs to show {visual ? "snapshots" : "rows"}.</div>}
    {error && <div className={`${visual ? "sv-feedback" : "table-feedback"} muted`} role="status">
      <span>{frame ? "Update failed. " : ""}{error}</span><Button variant="ghost" onClick={() => setRetry(retry + 1)}>Retry</Button>
    </div>}
    {frame?.kind === "summary" && frame.unavailable.length > 0 && <p className="table-availability muted">
      {props.catalog.truncated ? "Unavailable in the partial catalog" : "Not recorded in the selected scope"}: {frame.unavailable.join(", ")}.
    </p>}
    {frame?.kind === "table" && !frame.definition && <p className="table-feedback muted">
      This collection is {frame.partial ? "unavailable in the partial catalog" : "not recorded in the selected source snapshots"}. Edit the table to choose another collection.
    </p>}
    {visual ? <><div className="sv-body" aria-busy={pending}>
      {frame?.kind === "bar" && visual.type === "bar" && <SnapshotBars data={frame.response} view={visual} names={names} />}
      {frame?.kind === "status" && visual.type === "status-grid" && statusView && <SnapshotStatus records={frame.records} counts={frame.counts} view={statusView} names={names} active={active}
        onOpen={task => setSelection({record: task.record, snapshot: snapshots.find(snapshot => snapshot.snapshot_id === task.record.snapshot_id), title: task.label})}
        onColorChange={(raw, color) => {if (spec.kind === "snapshot-table") onChange({...spec, view: {...visual, colors: {...visual.colors, [raw]: color}}});}} />}
      {!frame && !pending && !error && runs.length > 0 && <p className="sv-empty muted">Snapshot is waiting to load.</p>}
    </div><footer className="sv-footer">
      <span className="sv-summary muted" title={visual.type === "bar" ? "Global category ranking uses the maximum first measure across Sources; Run and Source values remain separate." : "Status counts cover the full filtered dataset, not just visible cells."}>
        {frame?.kind === "bar" ? `${frame.response.groups.length < frame.response.total_groups && visual.type === "bar" && visual.order !== "label" ? "Top " : ""}${frame.response.groups.length} / ${frame.response.total_groups} categories · ${frame.response.matched_rows} rows`
          : frame?.kind === "status" ? frame.records.total ? `${frame.records.offset + 1}–${frame.records.offset + frame.records.rows.length} / ${frame.records.total} tasks` : "0 tasks" : ""}
      </span><span className="sv-coverage muted">{missingRuns ? `${missingRuns} ${missingRuns === 1 ? "Run" : "Runs"} not recorded` : ""}</span>
      {visual.type === "status-grid" && <>
        <IconButton className="icon-button" label="Previous task page" disabled={pending || frame?.kind !== "status" || frame.records.offset === 0} onClick={() => {if (frame?.kind === "status") page(Math.max(0, frame.records.offset - 1000));}}><ChevronLeft /></IconButton>
        <IconButton className="icon-button" label="Next task page" disabled={pending || frame?.kind !== "status" || frame.records.offset + 1000 >= frame.records.total} onClick={() => {if (frame?.kind === "status") page(frame.records.offset + 1000);}}><ChevronRight /></IconButton>
      </>}
    </footer></> : <>
      {missingRuns > 0 && <div className="table-scope"><span className="table-scope-note muted">{missingRuns} {missingRuns === 1 ? "run not recorded" : "runs not recorded"}</span></div>}
      <DataTable key={scope} columns={columns} rows={rows} total={total} offset={tableOffset} limit={tablePageSize} busy={pending} loaded={Boolean(frame)} preferences={preferences} query={query}
        onQueryChange={changeQuery} onColumnsChange={columns => onChange({...spec, columns})} onPage={page}
        {...(tableResponse ? {onRowDetails: (row: ViewRow) => {
          const detail = detailRecords.find(item => recordKey(item.record) === row.key && item.record.snapshot_id === row.snapshotId);
          if (detail) setSelection(detail);
          else if (row.snapshotId) {
            const [run_id, source_id, row_key] = JSON.parse(row.key) as [string, string, string];
            setSelection({title: row.title, snapshot: undefined, record: {run_id, source_id, row_key, snapshot_id: row.snapshotId,
              cells: Object.fromEntries(Object.entries(row.cells).filter(([path]) => !path.startsWith("@")))}});
          }
        }} : {})} />
    </>}
    {active && arrange && visual?.type === "status-grid" && frame && "definition" in frame && frame.definition && <SnapshotArrangement view={visual} columns={frame.definition.columns} onClose={() => setArrange(false)}
      onChange={view => {if (spec.kind === "snapshot-table") onChange({...spec, view});}} />}
    {active && selection && spec.kind === "snapshot-table" && <SnapshotDetails path={spec.path} selection={selection} reads={reads} names={names} onClose={() => setSelection(null)}
      onPrevious={detailIndex > 0 ? () => setSelection(detailRecords[detailIndex - 1]!) : undefined}
      onNext={detailIndex >= 0 && detailIndex + 1 < detailRecords.length ? () => setSelection(detailRecords[detailIndex + 1]!) : undefined} />}
  </PanelFrame>;
}
