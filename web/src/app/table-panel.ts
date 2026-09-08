import {exactProperty} from "../core/exact-json";
import type {ChartCatalog} from "../domain/snapshots";
import type {SummaryRow, TableCell, TableDataRow, TableDefinition, TableSource} from "../domain/tables";
import type {ExperimentRun} from "../domain/types";
import type {MetricCatalogQueryCoordinator} from "./coordinator";
import {formatTime, observedTime, humanize, metricName, rangeBounds, type RangeState} from "./model";
import {PanelChrome, type PanelAction} from "./panel-chrome";
import {copyPanel, type ColumnPreference, type TablePanelSpec} from "./panels";
import {collectionLabel, filterSummaryRows, TableView, type ViewColumn, type ViewRow} from "./table-view";
import {button, el, errorText} from "./ui";

const statisticColumns = [
  ["current", "Current"], ["minimum", "Min"], ["average", "Average"], ["p95", "P95"], ["maximum", "Max"], ["count", "Count"], ["missing", "Missing"], ["observations", "Observations"],
] as const;
/** Wrap already-renderable metadata without losing the distinction between null and missing. */
function cell(text: string, kind: TableCell["kind"] = "string"): TableCell {return {kind, text, truncated: false};}

/** Own latest authoritative reads and stable local grid state for one independent panel. */
export class TablePanel {
  readonly element = el("article", "table-card chart-card");
  readonly chrome: PanelChrome;
  private view: TableView;
  private feedback = el("div", "table-feedback muted");
  private availability = el("p", "table-availability muted");
  private scopeNote = el("span", "table-scope-note muted");
  private scope = el("div", "table-scope");
  private request: AbortController | null = null;
  private context: {catalog: ChartCatalog; runs: ExperimentRun[]; range: RangeState} | null = null;
  private definition: TableDefinition | null = null;
  private snapshots: TableSource[] = [];
  private summaryRows: SummaryRow[] = [];
  private unavailablePaths: string[] = [];
  private registeredSources = new Map<string, {label: string; role: string}>();
  private summaryLoaded = false;
  private active = false;
  private disposed = false;
  private loaded = false;

  /** Keep a table's presentation and actions independent from chart projection rendering. */
  constructor(readonly spec: TablePanelSpec, private reads: MetricCatalogQueryCoordinator,
    private labelFor: (run: ExperimentRun) => string, action: (action: PanelAction) => void,
    mode: "workspace" | "preview" = "workspace",
    private configurationChanged: (spec: TablePanelSpec) => void = () => {}) {
    this.chrome = new PanelChrome("table", action, mode === "preview");
    this.view = new TableView(() => {
      this.spec.query = {search: this.view.state.search, filters: this.view.state.filters.map(filter => ({...filter})),
        ...(this.view.state.sort ? {sort: {...this.view.state.sort}} : {})};
      this.configurationChanged(this.spec);
      if (this.spec.kind === "metric-table" && this.summaryLoaded) this.renderSummary(); else void this.load(true);
    }, (columns, refetch) => {
      this.spec.columns = columns;
      this.configurationChanged(this.spec);
      if (this.spec.kind === "metric-table" && this.summaryLoaded) this.renderSummary(); else if (refetch) void this.load(true);
    });
    this.scope.append(this.scopeNote); this.scope.hidden = true;
    this.feedback.setAttribute("role", "status");
    this.availability.hidden = true;
    this.element.append(this.chrome.element, this.scope, this.availability, this.feedback, this.view.element);
    if (mode === "preview") this.element.classList.add("table-preview");
    this.applySpec(spec);
  }
  /** Moving catalog bounds do not change query scope or clear successful observations. */
  setContext(catalog: ChartCatalog, runs: ExperimentRun[], range: RangeState): void {
    const old = this.context;
    const changed = !old || old.runs.map(run => run.id).join("\0") !== runs.map(run => run.id).join("\0")
      || this.spec.kind === "metric-table" && JSON.stringify(old.range) !== JSON.stringify(range);
    this.context = {catalog, runs, range: {...range}};
    if (changed) {this.cancel(); this.definition = null; this.summaryLoaded = false; this.loaded = false; this.view.clear(); this.registeredSources.clear();}
  }
  /** Clear rows before a new Run selection is loaded so old observations never masquerade as current. */
  setScope(runs: ExperimentRun[]): void {
    this.cancel(); this.definition = null; this.summaryLoaded = false; this.loaded = false; this.view.clear(); this.registeredSources.clear();
    if (this.context) this.context = {...this.context, runs};
    this.feedback.textContent = runs.length ? "Loading selected runs…" : "Select runs to show rows.";
  }
  /** Copy edited configuration and clear stale rows only when collection or reporter ownership changes. */
  applySpec(spec: TablePanelSpec): void {
    const beforeScope = this.spec.kind === "snapshot-table" ? this.spec.path : this.spec.paths;
    const afterScope = spec.kind === "snapshot-table" ? spec.path : spec.paths;
    const changed = JSON.stringify([this.spec.kind, beforeScope, this.spec.sourceIds]) !== JSON.stringify([spec.kind, afterScope, spec.sourceIds]);
    const queryChanged = JSON.stringify({search: this.view.state.search, filters: this.view.state.filters, sort: this.view.state.sort}) !== JSON.stringify({search: spec.query?.search ?? "", filters: spec.query?.filters ?? [], sort: spec.query?.sort});
    const copy = copyPanel(spec);
    if (copy.kind === "chart") return;
    Object.assign(this.spec, copy);
    for (const optional of ["title", "columns", "sourceIds", "query"] as const) if (!(optional in copy)) delete this.spec[optional];
    if (queryChanged) {this.view.setQuery(copy.query); this.loaded = false;}
    this.element.classList.toggle("wide", this.spec.size === "wide");
    this.element.dataset.path = this.spec.kind === "snapshot-table" ? this.spec.path : this.spec.paths.join(",");
    this.chrome.update(this.spec.title || (this.spec.kind === "metric-table" ? "Metric statistics" : this.definition ? collectionLabel(this.definition) : "Snapshot table"), null, this.spec.size);
    if (changed) {this.cancel(); this.definition = null; this.summaryLoaded = false; this.loaded = false; this.view.clear();}
  }
  /** Visibility owns read activity; collapsed/offscreen/removed tables release their in-flight work. */
  setActive(active: boolean): void {this.active = active; if (!active) this.cancel(); else if (!this.loaded && !this.request) void this.load(false);}
  /** Poll the latest observations even while browsing; a periodic tick never cancels a slow request. */
  refresh(fresh = false): void {
    if (this.request) return;
    void this.load(fresh);
  }
  /** Restore focused options after an adjacent panel is removed. */
  focusOptions(): void {this.chrome.trigger.focus();}
  /** Tables do not reinterpret graph zoom; shared range changes only affect true metric summaries. */
  resetZoom(): void {}
  /** Abort pending transport while leaving an explicit retry rather than a permanent spinner. */
  private cancel(): void {
    this.request?.abort(); this.request = null; this.view.setBusy(false);
    this.chrome.status.hidden = true;
  }
  /** Load the current authoritative page, preserving previous rows on transient failures. */
  private async load(latest: boolean): Promise<void> {
    const context = this.context;
    if (!this.active || !context || !context.runs.length || this.disposed || document.hidden) return;
    this.request?.abort(); const request = new AbortController(); this.request = request;
    this.chrome.status.hidden = this.loaded; this.chrome.status.textContent = this.loaded ? "" : "Loading…";
    this.feedback.textContent = ""; this.view.setBusy(!this.loaded);
    try {
      if (this.spec.sourceIds && !this.spec.sourceIds.length) throw new Error("Select at least one reporter in the table editor.");
      if (this.spec.kind === "metric-table") {
        if (!context.catalog.axes.includes(context.range.axis)) throw new Error("This alignment is not recorded. Choose another time alignment.");
        const selectedSources = this.spec.sourceIds ? new Set(this.spec.sourceIds) : null;
        const indexed = new Set(context.catalog.metrics.filter(metric => !selectedSources || metric.sources.some(source => selectedSources.has(source.source_id))).map(metric => metric.path));
        const paths = this.spec.paths.filter(path => indexed.has(path));
        this.unavailablePaths = this.spec.paths.filter(path => !indexed.has(path));
        this.availability.hidden = !this.unavailablePaths.length;
        this.availability.textContent = this.unavailablePaths.length
          ? `${context.catalog.truncated ? "Unavailable in the partial catalog" : "Not recorded in the selected scope"}: ${this.unavailablePaths.join(", ")}.`
          : "";
        if (!paths.length) {this.summaryRows = []; this.summaryLoaded = true; this.renderSummary();}
        else {
          const sourceIds = this.spec.sourceIds ?? [...new Set(context.catalog.metrics
            .filter(metric => paths.includes(metric.path)).flatMap(metric => metric.sources.map(source => source.source_id)))];
          const response = await this.reads.summary({run_ids: context.runs.map(run => run.id), paths, axis: context.range.axis,
            ...rangeBounds(context.range, context.catalog), source_ids: sourceIds}, request.signal, latest);
          if (request.signal.aborted) return;
          const known = new Set(context.catalog.metrics.flatMap(metric => metric.sources.map(source => source.source_id)));
          const missingMetadataRuns = [...new Set(response.rows.filter(row => !known.has(row.source_id)).map(row => row.run_id))];
          for (const runId of missingMetadataRuns) {
            const sources = await this.reads.sources(runId, request.signal);
            if (request.signal.aborted) return;
            for (const source of sources) {
              const label = `${humanize(source.role)}${source.rank === null ? source.node_id ? ` · ${source.node_id}` : "" : ` ${source.rank}`}`;
              this.registeredSources.set(source.id, {label, role: source.role});
            }
          }
          this.summaryRows = response.rows; this.summaryLoaded = true; this.renderSummary();
        }
      } else {
        const path = this.spec.path;
        if (!this.definition || latest) {
          const catalog = await this.reads.tables({run_ids: context.runs.map(run => run.id), ...(this.spec.sourceIds ? {source_ids: this.spec.sourceIds} : {})}, request.signal, latest);
          if (request.signal.aborted) return;
          this.availability.hidden = true; this.availability.textContent = "";
          this.definition = catalog.tables.find(table => table.path === path) ?? null;
        }
        if (!this.definition) {
          this.view.setData([{id: "$key", label: "Key"}], [], 0);
          this.feedback.textContent = "This collection is not recorded in the selected source snapshots. Edit the table to choose another collection.";
          this.chrome.status.hidden = false; this.chrome.status.textContent = "Not recorded"; this.loaded = true;
          this.element.dataset.loaded = "true"; return;
        }
        const columns = this.snapshotColumns(this.definition);
        // Discovery scopes reporters; every refresh requests their latest observations.
        const sourceIds = this.spec.sourceIds ?? this.definition.sources.map(source => source.source_id);
        if (!sourceIds.length) throw new Error("No source snapshots record this collection. Choose another collection or refresh.");
        const preferences = this.columnPreferences(columns);
        const selected = this.definition.columns.filter(column => column.path === "$key" || !preferences.find(pref => pref.id === column.path)?.hidden).map(column => column.path);
        // Let native validation report removed fields instead of silently reading unfiltered rows.
        const filters = this.view.state.filters.filter(filter => filter.enabled !== false)
          .map(({path, op, value}) => ({path, op, value}));
        const sort = this.view.state.sort;
        const query = {
          run_ids: context.runs.map(run => run.id), path: this.spec.path, columns: [...new Set([...selected, ...filters.map(filter => filter.path), ...(sort ? [sort.path] : [])])],
          source_ids: sourceIds,
          search: this.view.state.search, filters, ...(sort ? {sort} : {}), offset: this.view.state.offset, limit: this.view.state.limit,
        };
        let response = await this.reads.rows(query, request.signal, latest);
        if (request.signal.aborted) return;
        const lastPage = Math.max(0, Math.ceil(response.total / this.view.state.limit) - 1) * this.view.state.limit;
        if (this.view.state.offset > lastPage) {
          this.view.state.offset = lastPage;
          // Freeze only this retry to the just-returned observations, not future browse/refresh requests.
          response = await this.reads.rows({...query, offset: lastPage, snapshot_ids: response.snapshots.map(snapshot => snapshot.snapshot_id)}, request.signal, true);
          if (request.signal.aborted) return;
        }
        this.snapshots = response.snapshots;
        this.renderSnapshots(columns, response.rows, response.total);
      }
      this.loaded = true;
      const missingMetrics = this.spec.kind === "metric-table" && this.unavailablePaths.length === this.spec.paths.length;
      this.chrome.status.hidden = !missingMetrics;
      if (missingMetrics) this.chrome.status.textContent = "Not recorded";
      this.element.dataset.loaded = "true";
      this.chrome.update(this.spec.title || (this.spec.kind === "metric-table" ? "Metric statistics" : this.definition ? collectionLabel(this.definition) : "Snapshot table"), null, this.spec.size);
    } catch (error) {
      if (!request.signal.aborted) {
        this.chrome.status.hidden = false;
        this.chrome.status.textContent = this.loaded ? "Refresh failed" : "Request failed";
        this.feedback.replaceChildren(el("span", "", errorText(error)), button("Retry", () => {void this.load(latest);}, "text-button"));
      }
    } finally {
      if (this.request === request) {this.request = null; this.view.setBusy(false);}
    }
  }
  /** Keep all true summary statistics as separate Run/Source/metric rows before client pagination. */
  private renderSummary(): void {
    const context = this.context; if (!context || this.spec.kind !== "metric-table") return;
    const columns: ViewColumn[] = [{id: "@metric", label: "Metric", width: 180}, {id: "@run", label: "Run", width: 170}, {id: "@source", label: "Reporter", width: 150}, {id: "@unit", label: "Unit", width: 80},
      ...statisticColumns.map(([id, label]) => ({id, label, numeric: true, width: id === "count" || id === "missing" || id === "observations" ? 90 : 130})),
      {id: "@observed", label: "Observed", width: 175}];
    const metrics = new Map(context.catalog.metrics.map(metric => [metric.path, metric]));
    const sources = new Map(context.catalog.metrics.flatMap(metric => metric.sources).map(source => [source.source_id, source]));
    const rows: ViewRow[] = this.summaryRows.map(summary => {
      const metric = metrics.get(summary.path);
      const source = metric?.sources.find(source => source.source_id === summary.source_id) ?? sources.get(summary.source_id) ?? this.registeredSources.get(summary.source_id);
      const runName = this.runName(summary.run_id), key = JSON.stringify([summary.run_id, summary.source_id, summary.path]);
      const name = metric ? metricName(metric) : summary.path;
      const cells: Record<string, TableCell> = {"@metric": cell(name), "@run": cell(runName), "@source": cell(source?.label ?? "Reporter"),
        "@unit": cell(metric?.unit ?? "—"), "@observed": cell(observedTime(summary.observed_at_ns))};
      for (const [id] of statisticColumns) cells[id] = summary[id] === null ? cell("null", "null") : cell(exactProperty(summary, id), "number");
      return {key, cells, snapshotId: summary.snapshot_id, title: `${runName} ${name}`, cellTitles: {"@observed": formatTime(summary.observed_at_ns)}};
    });
    const filtered = filterSummaryRows(rows, this.view.state);
    this.view.state.offset = Math.min(this.view.state.offset, Math.max(0, Math.ceil(filtered.length / this.view.state.limit) - 1) * this.view.state.limit);
    this.view.setData(columns, filtered.slice(this.view.state.offset, this.view.state.offset + this.view.state.limit), filtered.length, this.columnPreferences(columns));
  }
  /** Lead with collection content, retaining explicit reporter metadata after the data columns. */
  private snapshotColumns(definition: TableDefinition): ViewColumn[] {
    const fields = definition.columns.filter(column => column.path !== "$key").map(column => ({id: column.path, label: column.name}));
    return [{id: "$key", label: "Key", width: 100}, ...fields, {id: "@run", label: "Run", width: 170, sortable: false, filterable: false},
      {id: "@source", label: "Reporter", width: 150, sortable: false, filterable: false}, {id: "@observed", label: "Observed", width: 175, sortable: false, filterable: false}];
  }
  /** Render exact typed cell text and attach each row to its own immutable snapshot evidence. */
  private renderSnapshots(columns: ViewColumn[], records: TableDataRow[], total: number): void {
    const rows: ViewRow[] = records.map(record => {
      const snapshot = this.snapshots.find(snapshot => snapshot.snapshot_id === record.snapshot_id);
      const runName = this.runName(record.run_id), key = JSON.stringify([record.run_id, record.source_id, record.row_key]);
      return {key, snapshotId: record.snapshot_id, title: `${runName} row ${record.row_key}`, cellTitles: {"@observed": formatTime(snapshot?.observed_at_ns)}, cells: {
        ...record.cells, "$key": record.cells.$key ?? cell(record.row_key), "@run": cell(runName), "@source": cell(snapshot?.label ?? "Reporter"),
        "@observed": cell(observedTime(snapshot?.observed_at_ns)),
      }};
    });
    this.view.setData(columns, rows, total, this.columnPreferences(columns));
    const missingRuns = this.spec.sourceIds ? 0 : this.context?.runs.filter(run => !this.snapshots.some(source => source.run_id === run.id)).length ?? 0;
    this.scope.hidden = !missingRuns;
    this.scopeNote.textContent = missingRuns ? `${missingRuns} ${missingRuns === 1 ? "run not recorded" : "runs not recorded"}` : "";
  }
  /** Start with a readable bounded column set, preserving all user visibility/order/width choices. */
  private columnPreferences(columns: ViewColumn[]): ColumnPreference[] {
    return this.spec.columns ?? columns.map((column, index) => ({id: column.id, ...(index >= 11 && !column.id.startsWith("@") ? {hidden: true} : {})}));
  }
  /** Resolve readable scoped Run names without leaking IDs into ordinary table labels. */
  private runName(id: string): string {const run = this.context?.runs.find(run => run.id === id); return run ? this.labelFor(run) : id;}
  /** Release API, grid and menu ownership when this panel or preview is removed. */
  destroy(): void {this.disposed = true; this.cancel(); this.view.destroy(); this.chrome.destroy();}
}
