import {Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent} from "react";
import {ChartNoAxesCombined, ChevronDown, Download, FolderPlus, List, Search, Table2} from "lucide-react";
import {Tabs} from "radix-ui";
import {Button} from "@/components/ui/button";
import {Checkbox} from "@/components/ui/checkbox";
import {Dialog, DialogContent, DialogDescription, DialogTitle} from "@/components/ui/dialog";
import type {TableCatalogResponse} from "../domain/tables";
import type {SnapshotBarView, SnapshotStatusView, SnapshotView} from "../domain/snapshot-views";
import {ChartPanel} from "./chart-panel";
import {RecordPanel} from "./record-panel";
import type {ChartData, ChartHandle, PanelEditorProps} from "./panel-types";
import {chartPaths, chartWidthChoices, compatibleMetrics, isAmbiguous, panelWidthChoices, rangeBounds, reporters, type ChartPresentation} from "./model";
import {copyPanel, type PanelSpec, type TablePanelSpec} from "./panels";
import {matchingMetrics, metricEntries} from "./metric-catalog";
import {editorMetrics, editorPresentation, panelEditorError, panelEditorReady, panelsFromEditor, validEditorPanels, type PanelEditorDraft} from "./panel-editor-model";
import {BindingField, BindingSelect, SnapshotBindingEditor, SnapshotViewTabs} from "./snapshot-binding-editor";
import {copySnapshotView, snapshotEditorViews, suggestSnapshotViews} from "./snapshot-config";

const noAction = () => {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const collectionName = (path: string, name: string) => path === "" ? "State fields" : name;

function initialDraft(props: PanelEditorProps): PanelEditorDraft {
  const existing = props.existing ? copyPanel(props.existing) : undefined;
  const display: ChartPresentation = existing?.kind === "chart" ? existing.presentation ?? {} : {};
  return {
    kind: existing?.kind ?? "chart", paths: existing?.kind === "chart" ? chartPaths(existing) : existing?.kind === "metric-table" ? existing.paths : [],
    combined: existing?.kind === "chart" && chartPaths(existing).length > 1, sectionId: existing?.sectionId ?? props.targetSection,
    size: existing?.kind === "chart" && chartWidthChoices.some(([size]) => size === existing.size) ? existing.size
      : existing && existing.kind !== "chart" ? existing.size : "half",
    title: existing?.kind === "chart" ? display.title ?? "" : existing?.title ?? "",
    style: display.style ?? "line", lineWidth: String(display.lineWidth ?? 1.8), points: display.points === undefined ? "auto" : display.points ? "show" : "hide",
    legend: display.legend ?? "auto", yMin: display.yMin === undefined ? "" : String(display.yMin), yMax: display.yMax === undefined ? "" : String(display.yMax),
    smoothing: String(props.chartView?.smoothing ?? 0), logarithmic: props.chartView?.logarithmic ?? false,
    collectionPath: existing?.kind === "snapshot-table" ? existing.path : null,
    sourceIds: existing && existing.kind !== "chart" && existing.sourceIds ? existing.sourceIds : null,
    ...(existing && existing.kind !== "chart" && existing.columns ? {columns: existing.columns} : {}),
    ...(existing && existing.kind !== "chart" && existing.query ? {query: existing.query} : {}),
    ...(existing?.kind === "snapshot-table" && existing.view ? {view: existing.view} : {}),
  };
}

/** The complete editor draft lives here; previews never mutate the saved workspace. */
export function PanelEditor(props: PanelEditorProps) {
  const {catalog, runs, range, layout, reads, colorFor, labelFor, existing, onCommit, onClose} = props;
  const [draft, setDraft] = useState(() => initialDraft(props));
  const [search, setSearch] = useState("");
  const [previewPath, setPreviewPath] = useState(() => draft.paths[0] ?? catalog.metrics.find(metric => metric.sources.some(source => source.latest_value !== null))?.path ?? catalog.metrics[0]?.path ?? "");
  const [tableCatalog, setTableCatalog] = useState<TableCatalogResponse | null>(null);
  const [tableLoading, setTableLoading] = useState(false);
  const [tableError, setTableError] = useState("");
  const [commitError, setCommitError] = useState("");
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [bar, setBar] = useState<SnapshotBarView>(() => existing?.kind === "snapshot-table" && existing.view?.type === "bar"
    ? copySnapshotView(existing.view) as SnapshotBarView : suggestSnapshotViews(null).bar);
  const [status, setStatus] = useState<SnapshotStatusView>(() => existing?.kind === "snapshot-table" && existing.view?.type === "status-grid"
    ? copySnapshotView(existing.view) as SnapshotStatusView : suggestSnapshotViews(null).status);
  const [viewType, setViewType] = useState<"table" | SnapshotView["type"]>(existing?.kind === "snapshot-table" ? existing.view?.type ?? "table" : "table");
  const [appearanceOpen, setAppearanceOpen] = useState(existing?.kind === "chart");
  const chartHandle = useRef<ChartHandle>(null);
  const [canExport, setCanExport] = useState(false);
  const initializedCollection = useRef<string | null>(null);
  const initialBinding = useRef(existing?.kind === "snapshot-table" && Boolean(existing.view));
  const searchRef = useRef<HTMLInputElement>(null), resultsRef = useRef<HTMLDivElement>(null);
  const runKey = JSON.stringify(runs.map(run => run.id));
  const runIds = useMemo<string[]>(() => JSON.parse(runKey) as string[], [runKey]);
  const table = tableCatalog?.tables.find(table => table.path === draft.collectionPath) ?? null;
  const view: SnapshotView | undefined = viewType === "table" ? undefined : viewType === "bar"
    ? {...bar, valuePaths: bar.aggregation === "count" ? [] : [...bar.valuePaths]} : status;
  const currentDraft: PanelEditorDraft = {...draft, ...(view ? {view} : {})};
  if (!view) delete currentDraft.view;
  const error = panelEditorError(currentDraft, catalog, layout, existing, table) || commitError;
  const ready = panelEditorReady(currentDraft);
  const section = draft.kind === "section", chart = draft.kind === "chart", snapshot = draft.kind === "snapshot-table";
  const widthChoices = chart ? chartWidthChoices : panelWidthChoices;
  const dialogTitle = existing ? chart ? "Edit chart" : snapshot ? "Edit snapshot" : "Edit table" : "Add";
  const display = editorPresentation(draft);
  const pathsKey = JSON.stringify(draft.paths);
  const paths = useMemo<string[]>(() => JSON.parse(pathsKey) as string[], [pathsKey]);
  const metricCatalog = useMemo(() => {
    const missing = editorMetrics(catalog, paths.filter(path => !catalog.metrics.some(metric => metric.path === path)));
    return {...catalog, metrics: [...catalog.metrics, ...missing]};
  }, [catalog, paths]);
  const entries = useMemo(() => metricEntries(metricCatalog, []), [metricCatalog]);
  const matching = matchingMetrics(entries, search);
  const outside = paths.filter(path => !matching.some(entry => entry.metric.path === path)).length;
  const tables = tableCatalog?.tables.filter(table => `${table.name} ${table.path}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const previewPaths = useMemo(() => draft.combined && paths.length ? paths : previewPath ? [previewPath] : [], [draft.combined, paths, previewPath]);
  const previewMetrics = useMemo(() => editorMetrics(catalog, previewPaths), [catalog, previewPaths]);
  const [chartData, setChartData] = useState<ChartData>({metrics: [], series: [], axis: range.axis, pending: false, error: null, unavailable: false, truncated: catalog.truncated});

  function change(patch: Partial<PanelEditorDraft>) {
    setDraft(previous => ({...previous, ...patch})); setCommitError("");
  }
  function acceptView(value: SnapshotView) {
    setCommitError("");
    if (value.type === "bar") setBar(copySnapshotView(value) as SnapshotBarView);
    else setStatus(copySnapshotView(value) as SnapshotStatusView);
  }
  function changeMode(kind: string) {
    if (kind !== "chart" && kind !== "metric-table" && kind !== "snapshot-table" && kind !== "section") return;
    if (existing && kind !== existing.kind) return;
    setDraft(previous => {
      const next: PanelEditorDraft = {...previous, kind, sourceIds: null};
      delete next.columns; delete next.query;
      if (!existing && kind !== "chart") next.size = "wide";
      return next;
    });
    setCommitError("");
  }
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!snapshot || !visible || !runIds.length) return;
    const controller = new AbortController();
    setTableCatalog(null); setTableLoading(true); setTableError("");
    void reads.tables({run_ids: runIds}, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setTableCatalog(result);
      setDraft(previous => previous.collectionPath === null ? {...previous, collectionPath: result.tables[0]?.path ?? null} : previous);
    }).catch(error => {if (!controller.signal.aborted) setTableError(errorMessage(error));})
      .finally(() => {if (!controller.signal.aborted) setTableLoading(false);});
    return () => controller.abort();
  }, [snapshot, visible, runIds, reads, retry]);
  useEffect(() => {
    if (!table || initializedCollection.current === table.path) return;
    initializedCollection.current = table.path;
    const defaults = snapshotEditorViews(table, initialBinding.current && existing?.kind === "snapshot-table" ? existing.view : undefined);
    initialBinding.current = false;
    setBar(defaults.bar); setStatus(defaults.status);
  }, [table]);
  useEffect(() => {
    if (!chart || !visible) return;
    const controller = new AbortController();
    const available = previewMetrics.filter(metric => metric.sources.length);
    const initial: ChartData = {metrics: previewMetrics, series: [], axis: range.axis, pending: false, error: null, unavailable: !available.length, truncated: catalog.truncated};
    if (existing?.kind === "chart" && props.previewData && !retry && JSON.stringify(previewPaths) === JSON.stringify(chartPaths(existing))) {
      setChartData({...props.previewData, metrics: previewMetrics});
      return () => controller.abort();
    }
    if (!runIds.length || !previewPaths.length || previewPaths.length > 64 || !compatibleMetrics(available) || !available.length) {
      setChartData(initial); return () => controller.abort();
    }
    setChartData({...initial, pending: true});
    const sources = [...new Set(available.flatMap(metric => runIds.flatMap(id => reporters(metric, id).map(source => source.source_id))))];
    void reads.query({run_ids: runIds, paths: available.map(metric => metric.path), ...(sources.length ? {source_ids: sources} : {}),
      axis: range.axis, ...rangeBounds(range, catalog), max_points: Math.max(1, Math.min(1200,
        Math.floor(40_000 / Math.max(1, available.reduce((sum, metric) => sum + metric.sources.length, 0)))))}, controller.signal)
      .then(result => {if (!controller.signal.aborted) setChartData({...initial, axis: result.axis, series: result.series});})
      .catch(error => {if (!controller.signal.aborted) setChartData({...initial, error: errorMessage(error)});});
    return () => controller.abort();
  }, [chart, visible, runIds, previewPaths, previewMetrics, range, catalog, reads, retry, existing, props.previewData]);

  const sources = snapshot ? table?.sources ?? [] : editorMetrics(catalog, paths).flatMap(metric => metric.sources);
  const uniqueSources = [...new Map(sources.map(source => [source.source_id, source])).values()];
  function chooseCollection(path: string) {
    initialBinding.current = false;
    change({collectionPath: path, sourceIds: null});
  }
  function togglePath(path: string, checked: boolean) {
    change({paths: checked ? [...draft.paths, path] : draft.paths.filter(value => value !== path)}); setPreviewPath(path);
  }
  function listKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const checks = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="checkbox"]:not([disabled])')];
    if (!checks.length) return;
    const current = checks.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && current === 0) {searchRef.current?.focus(); return;}
    const next = event.key === "Home" ? 0 : event.key === "End" ? checks.length - 1
      : Math.max(0, Math.min(checks.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
    checks[next]?.focus();
  }
  function save() {
    const problem = panelEditorError(currentDraft, catalog, layout, existing, table);
    if (problem || !panelEditorReady(currentDraft)) {setCommitError(problem); return;}
    if (section) {onCommit({kind: "section", name: draft.title.trim()}); onClose(); return;}
    const panels = panelsFromEditor(currentDraft, catalog, existing);
    if (!validEditorPanels(panels)) {setCommitError("Choose valid panel settings before saving."); return;}
    onCommit({kind: "panels", panels, ...(chart ? {chartView: {smoothing: Number(draft.smoothing), logarithmic: draft.logarithmic}} : {})}); onClose();
  }
  const previewChart: Extract<PanelSpec, {kind: "chart"}> = {id: "editor-preview", kind: "chart", sectionId: draft.sectionId, size: draft.size,
    path: previewPaths[0] ?? "", ...(previewPaths.length > 1 ? {paths: previewPaths} : {}),
    ...(Object.keys(display).length && !panelEditorError({...currentDraft, paths: previewPaths}, catalog, {...layout, panels: []}, undefined, table) ? {presentation: display} : {})};
  const previewTable: TablePanelSpec = {
    id: "editor-preview", sectionId: draft.sectionId, size: draft.size,
    ...(draft.title.trim() ? {title: draft.title.trim()} : {}), ...(draft.sourceIds ? {sourceIds: draft.sourceIds} : {}),
    ...(draft.columns ? {columns: draft.columns} : {}), ...(draft.query ? {query: draft.query} : {}),
    ...(draft.kind === "metric-table" ? {kind: "metric-table", paths} : {kind: "snapshot-table", path: draft.collectionPath ?? "", ...(view ? {view} : {})}),
  };
  function tableChange(spec: TablePanelSpec) {
    setDraft(previous => {
      const next = {...previous};
      if (spec.columns) next.columns = spec.columns; else delete next.columns;
      if (spec.query) next.query = spec.query; else delete next.query;
      return next;
    });
    if (spec.kind === "snapshot-table" && spec.view) acceptView(spec.view);
  }
  let preview;
  if (section) preview = <h3>{draft.title.trim() || "Untitled section"}</h3>;
  else if (!runs.length) preview = <p className="muted">{snapshot ? "Select runs to discover snapshot collections." : "Select runs to preview recorded data."}</p>;
  else if (snapshot && tableLoading) preview = <p role="status" className="muted">Discovering snapshot collections…</p>;
  else if (snapshot && tableError) preview = <p role="alert" className="error-text">{tableError}<Button variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry</Button></p>;
  else if (snapshot && draft.collectionPath === null || draft.kind === "metric-table" && !paths.length) preview = <p className="muted">{snapshot ? "Choose a snapshot collection." : "Select metrics to preview a table."}</p>;
  else if (chart && !previewPaths.length) preview = <p className="muted">Choose a metric to preview.</p>;
  else if (chart && previewPaths.length > 64) preview = <p className="muted">Select at most 64 metrics for one query.</p>;
  else if (chart && !compatibleMetrics(previewMetrics.filter(metric => metric.sources.length))) preview = <p className="muted">These metrics have different units. Choose Separate charts or select metrics with the same unit.</p>;
  else if (snapshot && error) preview = <p className="muted">{error}</p>;
  else if (chart) preview = <ChartPanel ref={chartHandle} onExportReady={setCanExport} viewSettings={{smoothing: Number(draft.smoothing) || 0, logarithmic: draft.logarithmic}}
    spec={previewChart} catalog={catalog} runs={runs} range={range} reads={reads} colorFor={colorFor} labelFor={labelFor}
    active={visible} refreshRevision={0} data={chartData} onRetry={() => setRetry(value => value + 1)} onAction={noAction}
    onChange={spec => {if (spec.presentation) {
      const presentation = spec.presentation;
      change({title: presentation.title ?? "", style: presentation.style ?? "line", lineWidth: String(presentation.lineWidth ?? 1.8),
        points: presentation.points === undefined ? "auto" : presentation.points ? "show" : "hide", legend: presentation.legend ?? "auto",
        yMin: presentation.yMin === undefined ? "" : String(presentation.yMin), yMax: presentation.yMax === undefined ? "" : String(presentation.yMax)});
    }}} />;
  else preview = <RecordPanel spec={previewTable} catalog={catalog} runs={runs} range={range} reads={reads} colorFor={colorFor} labelFor={labelFor}
    active={visible} refreshRevision={0} onChange={tableChange} onAction={noAction} />;

  return <Dialog open onOpenChange={open => {if (!open) onClose();}}>
    <DialogContent className={`react-dialog dialog chart-editor${section ? " section-only" : ""}`} aria-label={dialogTitle}
      style={{width: section ? "min(400px, calc(100vw - 16px))" : "min(880px, calc(100vw - 16px))",
        maxWidth: "calc(100vw - 16px)", margin: 0, right: "auto", bottom: "auto"}}>
      <header className="dialog-header"><DialogTitle>{dialogTitle}</DialogTitle>
        {!section && <div className="add-mode-settings">
          {chart && <BindingSelect label="Chart layout" value={draft.combined ? "combined" : "separate"} options={[["separate", "Separate charts"], ["combined", "Combined plot"]]}
            onChange={value => change({combined: value === "combined"})} />}
          {layout.sections.length > 1 && <BindingSelect label="Destination section" value={draft.sectionId}
            options={layout.sections.map(section => [section.id, section.name || "Initial section"] as const)} onChange={sectionId => change({sectionId})} />}
        </div>}
      </header>
      <DialogDescription className="sr-only">Select recorded metrics or collections, preview the result, and explicitly save your changes.</DialogDescription>
      <Tabs.Root value={draft.kind} onValueChange={changeMode} className="dialog-body">
        {!existing && <div className="add-mode-bar"><Tabs.List className="add-type-tabs" aria-label="Add type">
          {([["chart", "Chart", ChartNoAxesCombined], ["metric-table", "Metric table", List], ["snapshot-table", "Snapshot", Table2], ["section", "Section", FolderPlus]] as const).map(([kind, label, Icon]) =>
            <Tabs.Trigger key={kind} value={kind} className="add-type-tab"><Icon aria-hidden="true" size={14} />{label}</Tabs.Trigger>)}
        </Tabs.List></div>}
        <Tabs.Content value={draft.kind} className="editor-panes" tabIndex={-1}>
          <section className="editor-metrics" aria-label="Metric and collection selection">
            <div className="editor-search-row"><input ref={searchRef} className="text-input" type="search" aria-label={snapshot ? "Search collections" : "Search metrics"}
              placeholder={snapshot ? "Search collections…" : "Search metrics…"} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => {
                const checks = resultsRef.current?.querySelectorAll<HTMLButtonElement>('[role="checkbox"]:not([disabled])');
                if (event.key === "ArrowDown" && checks?.length) {event.preventDefault(); checks[0]?.focus();}
                if (event.key === "Enter" && checks?.length === 1) {event.preventDefault(); if (checks[0]!.getAttribute("aria-checked") !== "true") checks[0]!.click();}
              }} />
              {!snapshot && !section && <Button variant="ghost" className="text-button" disabled={!paths.length} onClick={() => change({paths: []})}>Clear</Button>}
            </div>
            <div ref={resultsRef} className="metric-results" onKeyDown={listKeys}>
              {snapshot ? <>
                {tables.slice(0, 100).map(table => {
                  const count = table.sources.reduce((sum, source) => sum + source.row_count, 0);
                  return <button type="button" key={table.path} className="collection-option" data-path={table.path} title={table.path || "Root"}
                    aria-label={collectionName(table.path, table.name)} aria-pressed={draft.collectionPath === table.path} onClick={() => chooseCollection(table.path)}>
                    <span className="collection-heading"><span className="collection-label">{collectionName(table.path, table.name)}</span><small className="collection-count muted">{count.toLocaleString()} {count === 1 ? "row" : "rows"}</small></span>
                    <code className="collection-path muted">{table.path ? table.path.split("/").map((part, index) => <Fragment key={index}>{index > 0 && <><wbr />/</>}{part}</Fragment>) : "(root)"}</code>
                  </button>;
                })}
                {tables.length > 100 && <p className="editor-list-note muted">{tables.length} matching collections. Refine the search to see more.</p>}
                {tableCatalog && !tables.length && <p className="editor-list-note muted">No matching snapshot collections.</p>}
                {draft.collectionPath !== null && tableCatalog && !table && <p className="editor-list-note muted">Saved collection is not recorded for these runs.</p>}
              </> : !section && <>
                {matching.slice(0, 100).map((entry, index) => <Fragment key={entry.metric.path}>
                  {!search.trim() && (index === 0 || matching[index - 1]?.group !== entry.group) && <h3 className="metric-group">{entry.group}</h3>}
                  <div className={`metric-option${paths.includes(entry.metric.path) ? " is-selected" : ""}${previewPath === entry.metric.path ? " is-preview" : ""}`} data-path={entry.metric.path}>
                    <Checkbox className="metric-checkbox" checked={paths.includes(entry.metric.path)} aria-label={`Select metric ${entry.name}`}
                      onCheckedChange={checked => togglePath(entry.metric.path, checked === true)} />
                    <button type="button" className="metric-preview-option" aria-label={`Preview ${entry.name}`}
                      title={`${entry.metric.path}${isAmbiguous(entry.metric) ? " · Separate reporter traces" : ""}`} onClick={() => setPreviewPath(entry.metric.path)}>
                      <span><strong>{entry.name}</strong>{entry.metric.unit && <small className="metric-option-unit muted">{entry.metric.unit}</small>}
                        {entry.context && <small className="metric-context muted">{entry.context}</small>}</span>
                    </button>
                  </div>
                </Fragment>)}
                {!matching.length && <p className="editor-list-note muted"><Search aria-hidden="true" size={16} />No matching metrics.</p>}
                {matching.length > 100 && <p className="editor-list-note muted">{matching.length} matching metrics. Refine the search to see more.</p>}
              </>}
            </div>
          </section>
          <section className="editor-preview-pane">
            {snapshot && <SnapshotViewTabs type={viewType} onChange={type => {setViewType(type); setCommitError("");}} />}
            <div className={`chart-preview${!chart && !section ? " table-preview" : ""}`} aria-busy={chartData.pending && chart || tableLoading && snapshot}>{preview}</div>
            <div className={`presentation-settings${chart ? "" : " collection-settings"}`}>
              <div style={{gridArea: "title"}}><BindingField label="Title"><input className="text-input" aria-label="Panel title" value={draft.title}
                maxLength={section ? 100 : 120} placeholder={section ? "Section name" : "Automatic"} onChange={event => change({title: event.target.value})} /></BindingField></div>
              {!section && <div style={{gridArea: "width"}}><BindingField label="Width"><BindingSelect label="Panel width" value={draft.size} options={widthChoices}
                onChange={size => {if (widthChoices.some(([value]) => value === size)) change({size: size as PanelEditorDraft["size"]});}} /></BindingField></div>}
            </div>
            {chart && <details className="editor-appearance" open={appearanceOpen} onToggle={event => setAppearanceOpen(event.currentTarget.open)}>
              <summary>Appearance<ChevronDown aria-hidden="true" size={14} /></summary>
              <div className="appearance-settings">
                <div style={{gridArea: "style"}}><BindingField label="Presentation"><BindingSelect label="Presentation" value={draft.style} options={[["line", "Line"], ["area", "Area"]]} onChange={style => change({style: style === "area" ? "area" : "line"})} /></BindingField></div>
                <div style={{gridArea: "line"}}><BindingField label="Line width"><input className="text-input" type="number" min=".5" max="6" step=".1" aria-label="Line width" value={draft.lineWidth} onChange={event => change({lineWidth: event.target.value})} /></BindingField></div>
                <div style={{gridArea: "points"}}><BindingField label="Points"><BindingSelect label="Points" value={draft.points} options={[["auto", "Automatic"], ["show", "Show"], ["hide", "Hide"]]} onChange={points => {if (points === "auto" || points === "show" || points === "hide") change({points});}} /></BindingField></div>
                <div style={{gridArea: "legend"}}><BindingField label="Legend"><BindingSelect label="Legend" value={draft.legend} options={[["auto", "Automatic"], ["show", "Show"], ["hide", "Hide"]]} onChange={legend => {if (legend === "auto" || legend === "show" || legend === "hide") change({legend});}} /></BindingField></div>
                {([["yMin", "Y minimum", "ymin"], ["yMax", "Y maximum", "ymax"]] as const).map(([key, label, area]) => <div key={key} style={{gridArea: area}}><BindingField label={label}>
                  <input className="text-input" inputMode="decimal" aria-label={label} placeholder="Auto" value={draft[key]} onChange={event => change({[key]: event.target.value})} />
                </BindingField></div>)}
              </div>
              <div className="chart-transform-settings">
                <BindingField label="Y scale"><BindingSelect label="Y scale" value={draft.logarithmic ? "log" : "linear"}
                  options={[["linear", "Linear"], ["log", "Logarithmic"]]} onChange={scale => change({logarithmic: scale === "log"})} /></BindingField>
                <BindingField label={`Smoothing · EMA ${Number(draft.smoothing).toFixed(2)}`}><input aria-label="Smoothing" type="range" min="0" max=".99" step=".01"
                  value={draft.smoothing} onChange={event => change({smoothing: event.target.value})} /></BindingField>
              </div>
            </details>}
            {snapshot && view && <SnapshotBindingEditor table={table} view={viewType === "bar" ? bar : status} onChange={acceptView} />}
            {!chart && !section && uniqueSources.length > 0 && <fieldset className="reporter-choices"><legend>Reporters</legend>
              {uniqueSources.map(source => {
                const run = runs.find(run => run.id === source.run_id), label = `${run ? labelFor(run) : source.run_id} · ${source.label}`;
                return <label key={source.source_id}><Checkbox aria-label={`Include ${label}`} checked={draft.sourceIds === null || draft.sourceIds.includes(source.source_id)} onCheckedChange={checked => {
                  const selected = draft.sourceIds ?? uniqueSources.map(source => source.source_id);
                  change({sourceIds: checked === true ? [...selected, source.source_id] : selected.filter(id => id !== source.source_id)});
                }} /><span>{label}</span></label>;
              })}
            </fieldset>}
          </section>
        </Tabs.Content>
        <footer className="editor-actions">
          {chart && <Button variant="ghost" size="sm" disabled={!canExport}
            onClick={() => {
              if (!chartHandle.current) {setCommitError("Wait for the chart to finish loading."); return;}
              void chartHandle.current.exportPng();
            }}><Download />Export PNG</Button>}
          {!section && <span className="metric-selection-count muted">{snapshot ? tableCatalog?.truncated ? "Partial collection catalog" : "Snapshot collections"
            : paths.length ? `${paths.length} selected${outside ? ` · ${outside} outside search` : ""}` : ""}</span>}
          <p role="alert" className="editor-error error-text">{error}</p>
          <div className="editor-primary-actions">
            <Button type="button" variant="ghost" className="button quiet" onClick={onClose}>Cancel</Button>
            <Button type="button" className="button primary" disabled={Boolean(error) || !ready || snapshot && tableLoading} onClick={save}>{existing ? "Save changes" : "Add"}</Button>
          </div>
        </footer>
      </Tabs.Root>
    </DialogContent>
  </Dialog>;
}
