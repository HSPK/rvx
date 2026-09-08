import type {ChartCatalog} from "../../domain/snapshots";
import type {SnapshotAggregateRequest, SnapshotAggregateResponse, SnapshotRecordsResponse, SnapshotStatusView} from "../../domain/snapshot-views";
import type {TableDefinition, TableFilter} from "../../domain/tables";
import type {ExperimentRun} from "../../domain/types";
import type {MetricCatalogQueryCoordinator} from "../coordinator";
import type {RangeState} from "../model";
import {PanelChrome, type PanelAction} from "../panel-chrome";
import {copyPanel, isSnapshotVisual, type SnapshotVisualPanelSpec} from "../panels";
import {openTableFilters} from "../table-filters";
import {collectionLabel} from "../table-view";
import {statusDisplayControls} from "../status-display-controls";
import {anchoredDialog, button, dialog, el, errorText, iconButton} from "../ui";
import {SnapshotBars, barMeasures} from "./bar";
import {TaskDetails, VisualTooltip, type VisualNames} from "./details";
import {SnapshotStatusGrid} from "./status";
import "./styles.css";

/** Strip UI-only disabled flags from every native visual query without discarding saved rules. */
export function nativeFilters(spec: SnapshotVisualPanelSpec): TableFilter[] {
  return (spec.query?.filters ?? []).filter(filter => filter.enabled !== false).map(({path, op, value}) => ({path, op, value}));
}

/** Ignore retained Table sorting and local presentation choices when identifying native visual queries. */
export function visualQueryKey(spec: SnapshotVisualPanelSpec): string {
  const view = spec.view;
  return JSON.stringify([spec.path, spec.sourceIds, spec.query?.search ?? "", nativeFilters(spec),
    view.type === "bar" ? [view.type, view.categoryPath, view.valuePaths, view.aggregation, view.limit, view.order]
      : [view.type, view.idPaths, view.statusPath, view.labelPath, view.groupPath, view.valuePath, view.shadePath, view.sort]]);
}

/** Own latest snapshot reads and lifecycle while the workspace owns visibility and the shared cadence. */
export class SnapshotVisualPanel {
  readonly element = el("article", "chart-card snapshot-visual-card");
  readonly chrome: PanelChrome;
  private body = el("div", "sv-body");
  private tools = el("div", "sv-tools");
  private search = el("input", "text-input sv-search");
  private filters: HTMLButtonElement;
  private arrange: HTMLButtonElement;
  private feedback = el("div", "sv-feedback muted");
  private footer = el("footer", "sv-footer");
  private summary = el("span", "sv-summary muted");
  private coverage = el("span", "sv-coverage muted");
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private tooltip = new VisualTooltip();
  private details: TaskDetails;
  private visual: SnapshotBars | SnapshotStatusGrid | null = null;
  private filterDialog: ReturnType<typeof dialog> | null = null;
  private arrangeDialog: ReturnType<typeof anchoredDialog> | null = null;
  private request: AbortController | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private context: {catalog: ChartCatalog; runs: ExperimentRun[]} | null = null;
  private definition: TableDefinition | null = null;
  private lifetime = new AbortController();
  private names: VisualNames;
  private queryKey = "";
  private scopeKey = "";
  private mappingKey = "";
  private active = false;
  private disposed = false;
  private loaded = false;
  private offset = 0;
  private total = 0;
  private committedOffset = 0;

  /** Compose clean shared chrome, a persistent query toolbar and one independently owned visual surface. */
  constructor(readonly spec: SnapshotVisualPanelSpec, private reads: MetricCatalogQueryCoordinator,
    private labelFor: (run: ExperimentRun) => string, private colorFor: (id: string) => string,
    action: (action: PanelAction) => void, mode: "workspace" | "preview" = "workspace",
    private configurationChanged: (spec: SnapshotVisualPanelSpec) => void = () => {}) {
    this.names = {runName: id => this.runName(id), fieldName: path => this.fieldName(path), colorFor: id => this.colorFor(id)};
    this.chrome = new PanelChrome("snapshot", action, mode === "preview", () => this.tooltip.hide());
    this.details = new TaskDetails(reads, this.names);
    this.search.type = "search"; this.search.placeholder = "Search…"; this.search.setAttribute("aria-label", "Search snapshot rows");
    this.search.addEventListener("input", () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {this.debounce = null; this.changeQuery({...(this.spec.query ?? {}), search: this.search.value});}, 180);
    }, {signal: this.lifetime.signal});
    this.filters = button("Filter", () => this.openFilters(), "button quiet");
    this.arrange = button("Arrange", () => this.openArrangement(), "button quiet");
    this.arrange.setAttribute("aria-haspopup", "dialog"); this.arrange.setAttribute("aria-expanded", "false");
    this.tools.append(this.search, this.filters, this.arrange);
    this.previous = iconButton("Previous task page", "left", () => this.page(-1));
    this.next = iconButton("Next task page", "right", () => this.page(1));
    this.footer.append(this.summary, this.coverage, this.previous, this.next);
    this.feedback.setAttribute("role", "status"); this.feedback.hidden = true;
    this.element.append(this.chrome.element, this.tools, this.feedback, this.body, this.footer, this.tooltip.element);
    this.element.classList.toggle("snapshot-visual-preview", mode === "preview");
    document.addEventListener("visibilitychange", () => {
      if (this.visual instanceof SnapshotStatusGrid) this.visual.setActive(this.active && !document.hidden);
      if (document.hidden) {this.cancel(); this.details.close(); this.arrangeDialog?.close(); this.tooltip.hide();}
    }, {signal: this.lifetime.signal});
    this.applySpec(spec);
  }

  /** Adopt saved edits without refetching local colors, decimal precision, geometry or density choices. */
  applySpec(spec: SnapshotVisualPanelSpec): void {
    const copy = copyPanel(spec);
    if (!isSnapshotVisual(copy)) throw new Error("A snapshot visual requires Bar or Status configuration.");
    const view = copy.view;
    const scope = JSON.stringify([copy.path, copy.sourceIds]);
    const mapping = JSON.stringify(view.type === "bar" ? [view.type, view.categoryPath, view.valuePaths, view.aggregation]
      : [view.type, view.idPaths, view.statusPath, view.labelPath, view.groupPath, view.valuePath]);
    const query = visualQueryKey(copy), scopeChanged = scope !== this.scopeKey, mappingChanged = mapping !== this.mappingKey;
    const queryChanged = query !== this.queryKey;
    Object.assign(this.spec, copy);
    for (const optional of ["title", "columns", "sourceIds", "query"] as const) if (!(optional in copy)) delete this.spec[optional];
    this.scopeKey = scope; this.mappingKey = mapping; this.queryKey = query;
    if (scopeChanged || mappingChanged) this.clearScope();
    else if (queryChanged) {this.cancel(); this.details.close(); this.offset = 0;}
    this.element.dataset.path = this.spec.path; this.element.dataset.view = view.type;
    this.element.classList.toggle("wide", this.spec.size === "wide");
    if (this.search.value !== (this.spec.query?.search ?? "")) this.search.value = this.spec.query?.search ?? "";
    const count = nativeFilters(this.spec).length;
    this.filters.querySelector("span")!.textContent = count ? `Filter · ${count}` : "Filter";
    if (view.type === "bar" && !(this.visual instanceof SnapshotBars)) {
      this.visual?.destroy(); this.visual = new SnapshotBars(this.names, this.tooltip); this.body.replaceChildren(this.visual.element);
    } else if (view.type === "status-grid" && !(this.visual instanceof SnapshotStatusGrid)) {
      this.visual?.destroy();
      this.visual = new SnapshotStatusGrid(this.names, this.tooltip,
        (task, snapshot) => this.details.open(this.spec.path, task.record, snapshot, task.label),
        (raw, color) => this.changeColor(raw, color));
      this.body.replaceChildren(this.visual.element);
    }
    if (!queryChanged) {
      if (view.type === "bar" && this.visual instanceof SnapshotBars) this.visual.applyView(view);
      else if (view.type === "status-grid" && this.visual instanceof SnapshotStatusGrid) this.visual.applyView(view);
    }
    this.previous.hidden = this.next.hidden = view.type !== "status-grid";
    this.arrange.hidden = view.type !== "status-grid" || this.element.classList.contains("snapshot-visual-preview");
    this.arrange.disabled = !this.definition;
    this.updateChrome(); this.updatePaging();
  }

  /** Ignore moving time ranges because these views show only the latest collection snapshots. */
  setContext(catalog: ChartCatalog, runs: ExperimentRun[], _range: RangeState): void {
    const changed = !this.context || this.context.runs.map(run => run.id).sort().join("\0") !== runs.map(run => run.id).sort().join("\0");
    this.context = {catalog, runs};
    if (changed) this.clearScope();
  }

  /** Clear old publishers synchronously before a new Run selection can be painted. */
  setScope(runs: ExperimentRun[]): void {
    this.clearScope();
    if (this.context) this.context = {...this.context, runs};
    this.feedback.hidden = false; this.feedback.textContent = runs.length ? "Loading selected runs…" : "Select runs to show snapshots.";
  }

  /** Cancel hidden/offscreen reads while retaining the last successful frame for reactivation. */
  setActive(active: boolean): void {
    this.active = active;
    if (this.visual instanceof SnapshotStatusGrid) this.visual.setActive(active);
    if (!active) {this.cancel(); this.details.close(); this.filterDialog?.close(); this.arrangeDialog?.close(); this.tooltip.hide();}
    else if (!this.loaded && !this.request) void this.load(false);
  }

  /** Let the shared workspace tick request latest data without cancelling slow in-flight work. */
  refresh(fresh = false): void {if (!this.request) void this.load(fresh);}

  /** Restore focus to the surviving panel's existing options trigger. */
  focusOptions(): void {this.chrome.trigger.focus();}

  /** Snapshot categories and tasks have no time zoom or historical axis. */
  resetZoom(): void {}

  /** Repaint preserved Run colors independently of metadata and data transport. */
  refreshColors(): void {this.visual?.refreshColors();}

  /** Clear data only when its ownership or field mapping becomes obsolete. */
  private clearScope(): void {
    this.cancel(); this.details.close(); this.filterDialog?.close(); this.filterDialog = null; this.arrangeDialog?.close(); this.tooltip.hide();
    this.definition = null; this.loaded = false; this.offset = 0; this.total = 0; this.committedOffset = 0;
    this.visual?.clear(); this.summary.textContent = ""; this.coverage.textContent = "";
    this.feedback.textContent = ""; this.feedback.hidden = true; delete this.element.dataset.loaded;
  }

  /** Abort the current consumer without resetting successful content or introducing repeated Loading labels. */
  private cancel(): void {
    this.request?.abort(); this.request = null; this.body.removeAttribute("aria-busy");
    if (!this.loaded) this.chrome.status.hidden = true;
  }

  /** Resolve actual collection publishers, then stage a complete visual frame before any data painting. */
  private async load(fresh: boolean): Promise<void> {
    const context = this.context;
    if (this.request || !this.active || this.disposed || !context || !context.runs.length || document.hidden) return;
    const request = new AbortController(); this.request = request;
    if (!this.loaded) {this.chrome.status.hidden = false; this.chrome.status.textContent = "Loading…"; this.body.setAttribute("aria-busy", "true");}
    try {
      if (this.spec.sourceIds && !this.spec.sourceIds.length) throw new Error("Select at least one Source in the snapshot editor.");
      if (!this.definition || fresh) {
        const catalog = await this.reads.tables({run_ids: context.runs.map(run => run.id),
          ...(this.spec.sourceIds ? {source_ids: this.spec.sourceIds} : {})}, request.signal, fresh);
        if (request.signal.aborted) return;
        this.definition = catalog.tables.find(table => table.path === this.spec.path) ?? null;
      }
      if (!this.definition) throw new Error("This collection is not recorded in the selected Sources. Edit the snapshot to choose another collection.");
      this.arrange.disabled = false;
      const selected = this.spec.sourceIds ? new Set(this.spec.sourceIds) : null;
      const sourceIds = [...new Set(this.definition.sources.filter(source => context.runs.some(run => run.id === source.run_id)
        && (!selected || selected.has(source.source_id))).map(source => source.source_id))].sort();
      if (!sourceIds.length) throw new Error("No selected Source snapshots record this collection.");
      const common = {run_ids: context.runs.map(run => run.id), source_ids: sourceIds, path: this.spec.path,
        search: this.spec.query?.search ?? "", filters: nativeFilters(this.spec)};
      const view = this.spec.view;
      if (view.type === "bar") {
        const measures = barMeasures(view).map(measure => ({...measure, op: view.aggregation}));
        const response = await this.reads.aggregate({...common, group_by: [view.categoryPath], measures, offset: 0, limit: view.limit,
          ...(view.order !== "label" ? {order: {measure: measures[0]!.id, direction: view.order === "value-asc" ? "asc" as const : "desc" as const}} : {})}, request.signal, fresh);
        if (request.signal.aborted) return;
        if (!(this.visual instanceof SnapshotBars) || this.spec.view.type !== "bar") return;
        this.visual.setData(response, this.spec.view); this.barSummary(response);
      } else {
        const columns = [...new Set([...view.idPaths, view.statusPath, ...[view.labelPath, view.groupPath, view.valuePath, view.shadePath].filter((path): path is string => path !== undefined)])];
        const query = {...common, columns, identity_paths: [...view.idPaths], offset: this.offset, limit: 1000,
          ...(view.sort ? {sort: {...view.sort}} : {})};
        let records = await this.reads.records(query, request.signal, fresh);
        if (request.signal.aborted) return;
        const lastPage = Math.max(0, Math.ceil(records.total / 1000) - 1) * 1000;
        if (query.offset > lastPage) {
          records = await this.reads.records({...query, offset: lastPage,
            snapshot_ids: [...new Set(records.snapshots.map(snapshot => snapshot.snapshot_id))]}, request.signal, true);
          if (request.signal.aborted) return;
        }
        const snapshotIds = [...new Set(records.snapshots.map(snapshot => snapshot.snapshot_id))];
        const measures: SnapshotAggregateRequest["measures"] = [{id: "count", op: "count"}];
        if (view.shadePath !== undefined) measures.push({id: "shade_min", op: "min", path: view.shadePath}, {id: "shade_max", op: "max", path: view.shadePath});
        const countQuery: SnapshotAggregateRequest = {...common, snapshot_ids: snapshotIds, group_by: [view.statusPath],
          measures, limit: 128, offset: 0};
        const counts = await this.reads.aggregate(countQuery, request.signal, fresh);
        if (request.signal.aborted) return;
        if (counts.total_groups > 128) throw new Error("More than 128 task states. Choose a categorical status field.");
        const pinned = new Set(snapshotIds);
        if (counts.matched_rows !== records.total || counts.groups.some(group => group.series.some(series => !pinned.has(series.snapshot_id)))) {
          throw new Error("Task counts do not match the pinned record observation. Retry this snapshot.");
        }
        if (!(this.visual instanceof SnapshotStatusGrid) || this.spec.view.type !== "status-grid") return;
        this.visual.setData(records, counts, this.spec.view); this.statusSummary(records);
      }
      this.loaded = true; this.element.dataset.loaded = "true";
      this.arrange.disabled = false;
      this.chrome.status.hidden = true; this.feedback.hidden = true; this.feedback.replaceChildren();
      this.updateChrome(); this.updatePaging();
    } catch (error) {
      if (!request.signal.aborted) {
        this.chrome.status.hidden = false; this.chrome.status.textContent = this.loaded ? "Update failed" : "Request failed";
        this.feedback.hidden = false;
        this.feedback.replaceChildren(el("span", "", errorText(error)), button("Retry", () => this.refresh(true), "text-button"));
      }
    } finally {
      if (this.request === request) {this.request = null; this.body.removeAttribute("aria-busy");}
    }
  }

  /** Explain native top-category ranking without implying merged Source values or page-derived statistics. */
  private barSummary(response: SnapshotAggregateResponse): void {
    const top = response.groups.length < response.total_groups;
    this.summary.textContent = `${top && this.spec.view.type === "bar" && this.spec.view.order !== "label" ? "Top " : ""}${response.groups.length} / ${response.total_groups} categories · ${response.matched_rows} rows`;
    this.summary.title = this.spec.view.type === "bar" && this.spec.view.order !== "label"
      ? "Global category ranking uses the maximum first measure across Sources; Run and Source values remain separate."
      : "Canonical category order across all filtered records; Run and Source values remain separate.";
    this.updateCoverage(response.snapshots.map(source => source.run_id));
  }

  /** Publish only the page that has matching full-filtered-dataset status counts. */
  private statusSummary(response: SnapshotRecordsResponse): void {
    this.offset = this.committedOffset = response.offset; this.total = response.total;
    this.summary.textContent = response.total ? `${response.offset + 1}–${response.offset + response.rows.length} / ${response.total} tasks` : "0 tasks";
    this.summary.title = "Each cell is one task in this page. Status counts cover the full filtered dataset, not just visible cells.";
    this.updateCoverage(response.snapshots.map(source => source.run_id));
  }

  /** Keep unavailable Run observations explicit rather than inventing successful or zero-valued tasks. */
  private updateCoverage(runIds: string[]): void {
    const missing = this.context?.runs.filter(run => !runIds.includes(run.id)).length ?? 0;
    this.coverage.textContent = missing ? `${missing} ${missing === 1 ? "Run" : "Runs"} not recorded` : "";
  }

  /** Keep native pagination controls consistent with the last committed frame. */
  private updatePaging(): void {
    this.previous.disabled = this.committedOffset === 0;
    this.next.disabled = this.committedOffset + 1000 >= this.total;
  }

  /** Treat explicit page navigation as a new latest query, never a permanently pinned browsing session. */
  private page(delta: number): void {
    this.cancel(); this.details.close(); this.offset = Math.max(0, this.committedOffset + delta * 1000); void this.load(true);
  }

  /** Persist query preferences through the workspace while retaining reusable disabled conditions. */
  private changeQuery(query: NonNullable<SnapshotVisualPanelSpec["query"]>): void {
    this.applySpec({...this.spec, query}); this.configurationChanged(this.spec); this.refresh(true);
  }

  /** Reuse the existing table condition editor rather than creating a separate snapshot filtering language. */
  private openFilters(): void {
    this.tooltip.hide(); this.arrangeDialog?.close(); this.filterDialog?.close();
    const columns = this.definition?.columns.map(column => ({id: column.path, label: column.name})) ?? [];
    this.filterDialog = openTableFilters(columns, this.spec.query?.filters ?? [], filters => {
      this.changeQuery({...this.spec.query, filters});
    }, () => {this.filterDialog = null;});
  }

  /** Adjust native task ordering or cached geometry beside the live panel without opening the full editor. */
  private openArrangement(): void {
    if (this.arrangeDialog) {this.arrangeDialog.close(); return;}
    if (this.spec.view.type !== "status-grid" || !this.definition) return;
    this.tooltip.hide(); this.filterDialog?.close();
    const popup = anchoredDialog("Arrange tasks", this.arrange, () => {this.arrangeDialog = null;});
    this.arrangeDialog = popup; popup.node.classList.add("sv-arrange-popover");
    popup.body.append(statusDisplayControls(() => {
      if (this.spec.view.type !== "status-grid") throw new Error("Task arrangement requires a status grid.");
      return this.spec.view;
    }, this.definition.columns, view => this.changeArrangement(view)));
    popup.body.querySelector<HTMLSelectElement>("select")?.focus({preventScroll: true});
  }

  /** Fetch a newly ordered first page only for sort changes; geometry changes reuse the coherent frame. */
  private changeArrangement(view: SnapshotStatusView): void {
    const spec = {...this.spec, view}, changed = visualQueryKey(spec) !== this.queryKey;
    this.applySpec(spec); this.configurationChanged(this.spec);
    if (changed) this.refresh(true);
  }

  /** Mark raw-state color edits dirty while repainting cached task cells without network traffic. */
  private changeColor(raw: string, color: string): void {
    if (this.spec.view.type !== "status-grid") return;
    if (!Object.hasOwn(this.spec.view.colors ?? {}, raw) && Object.keys(this.spec.view.colors ?? {}).length >= 128) {
      this.feedback.hidden = false; this.feedback.textContent = "The snapshot already has 128 saved state colors."; return;
    }
    this.spec.view = {...this.spec.view, colors: {...this.spec.view.colors, [raw]: color}};
    if (this.visual instanceof SnapshotStatusGrid) this.visual.applyView(this.spec.view);
    this.configurationChanged(this.spec);
  }

  /** Update shared card titles without replacing focused header controls. */
  private updateChrome(): void {
    const name = this.definition ? collectionLabel(this.definition) : "Snapshot";
    this.chrome.update(this.spec.title || name, this.spec.view.type === "bar" ? this.spec.view.unit ?? null : null, this.spec.size);
  }

  /** Resolve readable Run labels while retaining unknown IDs as explicit ownership. */
  private runName(id: string): string {
    const run = this.context?.runs.find(run => run.id === id); return run ? this.labelFor(run) : id;
  }

  /** Use authoritative field labels without changing JSON-pointer query identity. */
  private fieldName(path: string): string {return this.definition?.columns.find(column => column.path === path)?.name ?? (path || "(root)");}

  /** Release every owned read, timer, observer, dialog, listener and hover surface on removal. */
  destroy(): void {
    this.disposed = true; this.cancel(); this.lifetime.abort();
    if (this.debounce) clearTimeout(this.debounce);
    this.filterDialog?.close(); this.arrangeDialog?.close(); this.details.close(); this.visual?.destroy(); this.tooltip.destroy(); this.chrome.destroy();
  }
}
