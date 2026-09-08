import type {ChartCatalog, ChartMetric} from "../domain/snapshots";
import type {ExperimentRun} from "../domain/types";
import {ChartRenderer} from "./chart";
import {MetricCatalogQueryCoordinator} from "./coordinator";
import {axisLabel, chartPaths, defaultCharts, formatTime, observedTime, humanize, rangeBounds, reporters, timeWindowChoices, type RangeState} from "./model";
import {AddEditor, type AddResult} from "./add-editor";
import {PanelLayout, type LayoutView} from "./panel-layout";
import {chartPanel, copyLayout, copyPanel, emptyLayout, isSnapshotVisual, type PanelSpec, type TablePanelSpec, type WorkspaceLayout, type WorkspaceSet} from "./panels";
import type {PanelAction} from "./panel-chrome";
import {TablePanel} from "./table-panel";
import {SnapshotVisualPanel} from "./snapshot-visual/panel";
import {renderTimeSettings} from "./time-controls";
import {runObservationState} from "./run-context";
import {PreferencesStore} from "./preferences";
import {layoutSignature, WorkspaceState} from "./workspace-state";
import type {RunMetadata} from "./runs";
import {anchoredDialog, button, dialog, el, errorText, icon, iconButton, message, select} from "./ui";

type PanelView = ChartRenderer | TablePanel | SnapshotVisualPanel;
const blankCatalog: ChartCatalog = {runs: [], metrics: [], defaults: [], axes: ["wall_time", "elapsed"], truncated: false};
const workspaceNames = new Intl.Collator(undefined, {numeric: true});

/** Own selected Runs, visible reads and one persistent flat panel/section workspace. */
export class ChartWorkspace {
  readonly element = el("main", "workspace-page");
  readonly header = el("div", "workspace-header");
  private session = new WorkspaceState();
  private saveStatus = el("span", "workspace-save-status");
  private saveControl = button("Save", () => this.saveCurrent(), "button workspace-save");
  private saveSlot = el("div", "workspace-save-slot");
  private loadedRevision = 0;
  private saving = false;
  private suspended = false;
  private feedbackKey = "";
  private savedTimer: ReturnType<typeof setTimeout> | null = null;
  private lifetime = new AbortController();
  private catalogRequest: AbortController | null = null;
  private queryRequest: AbortController | null = null;
  private catalog: ChartCatalog | null = null;
  private cards = new Map<string, PanelView>();
  private visible = new Set<string>();
  private layout: WorkspaceLayout = emptyLayout();
  private layoutView: PanelLayout;
  private initialized = false;
  private range: RangeState;
  private grid = el("div", "panel-workspace");
  private scroll = el("div", "chart-scroll");
  private notice = el("div", "workspace-notice");
  private subtitle = el("div", "collection-freshness");
  private chips = el("div", "run-chips");
  private rangeSelect: HTMLSelectElement;
  private observer: IntersectionObserver;
  private timer: ReturnType<typeof setInterval>;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private openDialog: ReturnType<typeof dialog> | null = null;
  private busy = false;
  private outsideFilters: string[] = [];
  private selectionEmpty = el("div", "selection-empty");
  private selectionFeedback = el("p", "selection-feedback muted");
  private runsControl: HTMLButtonElement;
  private addControl: HTMLButtonElement;
  private setsControl: HTMLButtonElement;
  private setupRefresh: HTMLButtonElement;
  private lastExperimentId = "";

  /** Mount one shared viewport; individual panel identity never depends on metric paths. */
  constructor(private runIds: string[], private metadata: RunMetadata, private reads: MetricCatalogQueryCoordinator, private preferences: PreferencesStore,
    range: RangeState, private colorFor: (id: string) => string, private labelFor: (run: ExperimentRun) => string, private openRuns: () => void, private toggleRun: (id: string) => void,
    private rangeUpdated: (range: RangeState) => void, refreshRuns: () => void, private openRunDetails: (runId: string) => void,
    private openRunColor: (runId: string) => void) {
    this.runIds = [...runIds]; this.range = {...range};
    this.session.open(this.layout, this.experimentId);
    this.setupRefresh = button("Refresh runs", refreshRuns, "button primary"); this.setupRefresh.setAttribute("aria-label", "Refresh runs");
    const controls = el("div", "workspace-controls"), strip = el("div", "selection-strip");
    this.runsControl = button("Runs", openRuns, "button runs-control", "runs"); this.runsControl.setAttribute("aria-haspopup", "dialog");
    strip.append(this.runsControl, this.chips);
    const toolbar = el("div", "chart-toolbar"), time = el("div", "time-controls");
    this.rangeSelect = select("Time range", timeWindowChoices, this.range.window, value => {
      if (value === "custom") {this.rangeSelect.value = this.range.window; this.timeSettings(); return;}
      this.range.window = value; delete this.range.from; delete this.range.to; this.rangeChanged();
    });
    time.append(this.rangeSelect);
    const actions = el("div", "chart-actions");
    this.addControl = button("Add", () => this.openEditor(), "button add-chart-button", "plus");
    this.setsControl = button("Default", () => this.workspaceSets(), "workspace-picker");
    this.setsControl.append(icon("down"));
    this.setsControl.setAttribute("aria-label", "Workspace sets");
    this.setsControl.setAttribute("aria-haspopup", "dialog");
    this.setsControl.setAttribute("aria-expanded", "false");
    this.setsControl.setAttribute("aria-keyshortcuts", "F2 ArrowDown");
    this.setsControl.addEventListener("keydown", event => {
      if (event.key === "F2") {event.preventDefault(); this.workspaceSets(true);}
      else if (event.key === "ArrowDown") {event.preventDefault(); this.workspaceSets();}
    });
    this.saveControl.setAttribute("aria-label", "Save current workspace");
    this.saveStatus.setAttribute("role", "status");
    this.saveSlot.append(this.saveControl); this.header.append(this.setsControl, this.saveSlot);
    actions.append(this.subtitle, this.addControl); toolbar.append(strip, time, actions);
    this.notice.setAttribute("role", "status"); this.notice.hidden = true;
    this.selectionFeedback.setAttribute("role", "status"); this.selectionFeedback.hidden = true; this.selectionEmpty.hidden = true;
    controls.append(toolbar, this.selectionFeedback, this.notice);
    this.scroll.tabIndex = 0; this.scroll.setAttribute("role", "region"); this.scroll.setAttribute("aria-label", "Analysis panels");
    this.scroll.append(this.selectionEmpty, this.grid);
    this.element.append(el("h1", "sr-only", "Run analysis"), controls, this.scroll);
    this.layoutView = new PanelLayout(this.scroll, () => this.layout, () => {this.recordChange(); this.syncPanels(); this.scheduleQuery(false);},
      id => this.openEditor(undefined, id), () => this.visibilityChanged());
    this.grid.append(message("Loading panels", "Finding recorded fields…"));
    this.observer = new IntersectionObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const id = entry.target instanceof HTMLElement ? entry.target.dataset.panelId : undefined;
        if (!id) continue;
        if (entry.isIntersecting && !this.visible.has(id)) {this.visible.add(id); changed = true;}
        else if (!entry.isIntersecting && this.visible.delete(id)) changed = true;
      }
      if (changed) this.visibilityChanged();
    }, {root: this.scroll, threshold: .01});
    this.timer = setInterval(() => {
      if (!this.suspended && !document.hidden && this.runs.length && this.runIds.length <= 4 && (this.activeIds().size || !this.initialized) && !this.busy && !this.queryRequest) void this.refresh(true);
    }, 5000);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.catalogRequest?.abort(); this.queryRequest?.abort(); this.cancelScheduled();
        for (const view of this.cards.values()) if (!(view instanceof ChartRenderer)) view.setActive(false);
      } else {
        void this.refresh(true);
      }
    }, {signal: this.lifetime.signal});
    window.addEventListener("beforeunload", event => {
      if (this.session.dirty || this.saving || this.preferences.uncertain) {event.preventDefault(); event.returnValue = "";}
    }, {signal: this.lifetime.signal});
    this.updateHeading(); this.updateControls(); void this.refresh();
  }
  /** Share metadata refresh progress with first-use guidance without moving the panel surface. */
  setMetadataRefreshing(refreshing: boolean): void {this.setupRefresh.disabled = refreshing; this.setupRefresh.querySelector("span")!.textContent = refreshing ? "Refreshing…" : "Refresh runs";}
  /** Reconcile URL and peer Run selection without recreating panel instances or persistent ordering. */
  setSelection(runIds: string[], metadata: RunMetadata, range: RangeState, outsideFilters: string[]): void {
    const oldRuns = this.runs.map(run => run.id).join("\0"), changedIds = this.runIds.join("\0") !== runIds.join("\0");
    const changedRange = JSON.stringify(this.range) !== JSON.stringify(range), changedMetadata = this.metadata !== metadata;
    this.runIds = [...runIds]; this.metadata = metadata; this.outsideFilters = outsideFilters; this.range = {...range};
    const scope = changedIds || oldRuns !== this.runs.map(run => run.id).join("\0");
    if (scope || changedRange) this.openDialog?.close();
    if (this.runs[0]) this.lastExperimentId = this.runs[0].experiment_id;
    if (scope) {
      this.catalogRequest?.abort(); this.queryRequest?.abort(); this.catalog = null;
      for (const card of this.cards.values()) card.setScope(this.runs);
    }
    this.updateHeading(); this.updateControls();
    if (!this.showSelectionState()) return;
    if (changedRange) for (const card of this.cards.values()) card.resetZoom();
    if (scope || changedRange || changedMetadata) void this.refresh();
  }
  /** Resolve current Run identities separately from scoped display labels. */
  private get runs(): ExperimentRun[] {return this.runIds.flatMap(id => this.metadata.runs.filter(run => run.id === id));}
  /** Keep the last experiment available while temporarily clearing selection. */
  private get experimentId(): string {return this.runs[0]?.experiment_id ?? this.lastExperimentId;}
  /** A workspace keeps its own save scope when Runs from another experiment are overlaid. */
  private get workspaceScope(): string {return this.session.scope || this.experimentId;}
  /** Display current identity and persistence feedback without adding a second page title. */
  private updateWorkspaceHeader(): void {
    this.setsControl.querySelector("span")!.textContent = this.session.name;
    const experiment = this.metadata.experiments.find(item => item.id === this.workspaceScope);
    this.setsControl.title = `${this.session.name}${experiment ? ` · ${experiment.name}` : ""}${this.session.id ? " · F2 to rename" : ""}`;
    this.header.dataset.workspaceId = this.session.id ?? "";
    const failed = this.session.saveFailed || this.preferences.uncertain;
    this.saveSlot.dataset.state = this.saving ? "saving" : failed ? "failed" : this.session.status;
    const feedbackKey = `${this.session.id ?? ""}:${this.saveSlot.dataset.state}`;
    if (feedbackKey !== this.feedbackKey) {
      this.feedbackKey = feedbackKey;
      if (this.savedTimer) clearTimeout(this.savedTimer);
      this.savedTimer = null; this.saveSlot.dataset.expired = "false";
      if (this.saveSlot.dataset.state === "saved") this.savedTimer = setTimeout(() => {
        this.savedTimer = null; this.saveSlot.dataset.expired = "true";
      }, 3000);
    }
    const status = this.saving || this.session.status === "saved" && !failed;
    this.saveStatus.dataset.state = this.saveSlot.dataset.state;
    const statusText = this.saving ? "Saving…" : "Saved";
    if (this.saveStatus.textContent !== statusText) this.saveStatus.textContent = statusText;
    this.saveStatus.title = this.saving ? "Saving this submitted layout to the server." : "Panel layout and table settings are saved on the server. Runs and time range stay in the URL.";
    this.saveControl.querySelector("span")!.textContent = failed ? "Retry save" : "Save";
    this.saveControl.setAttribute("aria-label", failed ? "Retry saving workspace" : "Save current workspace");
    this.saveControl.disabled = !this.workspaceScope;
    this.saveControl.classList.toggle("save-needed", this.session.dirty || failed);
    this.saveControl.title = failed ? "Save failed. Your changes are not saved." : this.session.dirty ? "Unsaved changes" : "Save this workspace";
    const node = status ? this.saveStatus : this.saveControl;
    if (this.saveSlot.firstChild !== node) this.saveSlot.replaceChildren(node);
    document.title = `${this.session.dirty ? "* " : ""}${this.session.name} · RVX`;
  }
  /** Reconcile edit state only at configuration mutations, not during incoming observations or hover. */
  private recordChange(): void {this.session.changed(this.layout); this.updateWorkspaceHeader();}
  /** Keep time controls truthful without adding visible navigation titles. */
  private updateControls(): void {
    this.addControl.disabled = this.runIds.length > 4;
    this.rangeSelect.value = this.range.window;
    for (const option of this.rangeSelect.options) option.disabled = !["wall_time", "elapsed"].includes(this.range.axis) && !["all", "custom"].includes(option.value);
    this.rangeSelect.querySelector<HTMLOptionElement>('option[value="custom"]')!.textContent = this.range.window === "custom" ? "Custom" : "Custom…";
    this.rangeSelect.title = `${axisLabel(this.range.axis)} · Time range`;
  }
  /** Keep selected names, independent observation freshness and unavailable selections visible. */
  private updateHeading(): void {
    this.updateWorkspaceHeader();
    const runs = this.runs;
    this.runsControl.setAttribute("aria-label", `Select runs (${this.runIds.length} selected)`);
    const latest = this.catalog?.runs.flatMap(run => run.last_observed_at_ns === null ? [] : [run.last_observed_at_ns]) ?? [];
    const asOf = Date.now();
    const states = new Map(runs.map(run => [run.id, runObservationState(run, this.catalog?.runs.find(info => info.run_id === run.id), asOf)]));
    this.subtitle.replaceChildren();
    if (latest.length) {
      const time = el("span", "freshness-time", observedTime(Math.max(...latest))); time.title = formatTime(Math.max(...latest));
      this.subtitle.append(el("span", "freshness-label", "Updated "), time);
    }
    else if (this.catalog && runs.length) this.subtitle.append(el("span", "", "Waiting for data"));
    this.chips.hidden = !this.runIds.length;
    this.chips.replaceChildren(...this.runIds.map(id => {
      const run = runs.find(run => run.id === id), name = run ? this.labelFor(run) : id;
      const chip = el("span", `run-chip${run ? "" : " unavailable-run"}`); chip.dataset.runId = id; chip.title = name; chip.style.setProperty("--run-color", this.colorFor(id));
      const labels = el("span", "chip-labels"), flags = el("span", "chip-flags");
      const label = run ? button(name, () => this.openRunDetails(run.id), "chip-name chip-details") : el("span", "chip-name", name);
      if (run) {label.dataset.runDetails = run.id; label.setAttribute("aria-label", `Run details for ${name}`); label.title = "Run details";}
      labels.append(label);
      if (!run || this.outsideFilters.includes(id)) flags.append(el("span", "chip-state muted", run ? "outside filters" : "unavailable"));
      if (states.get(id) === "stale") flags.append(el("span", "chip-state stale-text", "No recent data"));
      else if (states.get(id) === "empty") flags.append(el("span", "chip-state muted", "No data"));
      if (flags.childElementCount) labels.append(flags);
      const swatch = run ? button(`Change color for ${name}`, () => this.openRunColor(id), "run-color-button") : el("span", "run-color-button");
      swatch.append(el("i", "run-color-dot"));
      if (run) {swatch.setAttribute("aria-label", `Change color for ${name}`); swatch.dataset.runColor = id; swatch.title = "Run color";}
      chip.append(swatch, labels, iconButton(`Remove ${name} from selection`, "close", () => this.toggleRun(id))); return chip;
    }));
    const missing = this.runIds.length - runs.length;
    this.selectionFeedback.hidden = !missing && this.runIds.length <= 4;
    this.selectionFeedback.textContent = this.runIds.length > 4 ? "Select up to 4 runs so overlays remain readable." : `${missing} selected ${missing === 1 ? "run is" : "runs are"} unavailable.`;
  }
  /** Never query empty Run selections or leave old curves/rows visible as new evidence. */
  private showSelectionState(): boolean {
    const valid = this.runs.length > 0 && this.runIds.length <= 4;
    this.grid.hidden = !valid; this.selectionEmpty.hidden = valid;
    if (!valid) {
      this.catalogRequest?.abort(); this.queryRequest?.abort(); this.notice.hidden = true;
      if (!this.metadata.runs.length && !this.runIds.length) this.selectionEmpty.replaceChildren(message("No runs yet", "Set up a Run and register a Source with the RVX CLI, then refresh the Run list.", this.setupRefresh));
      else this.selectionEmpty.replaceChildren(message(this.runIds.length > 4 ? "Select up to 4 runs" : this.runIds.length ? "Selected runs unavailable" : "Select runs", "Choose runs to display their recorded data.", button("Choose runs", this.openRuns)));
    }
    return valid;
  }
  /** Discover useful defaults once, then preserve deliberate panels and groups through live refresh. */
  private async refresh(fresh = false): Promise<void> {
    if (this.suspended || this.lifetime.signal.aborted || document.hidden || !this.showSelectionState()) return;
    this.catalogRequest?.abort();
    const request = new AbortController(); this.catalogRequest = request; this.busy = true;
    if (!this.catalog && !this.cards.size) this.grid.replaceChildren(message("Loading panels", "Finding recorded fields…"));
    try {
      const catalog = await this.reads.catalog(this.runs.map(run => run.id), request.signal, fresh);
      if (request.signal.aborted) return;
      this.catalog = catalog; this.notice.hidden = true;
      if (!this.initialized) {
        const saved = this.preferences.selected(this.experimentId);
        if (saved) {this.layout = copyLayout(saved); this.initialized = true;}
        else {
          const defaults = defaultCharts(catalog);
          if (defaults.length) {this.layout.panels = defaults.map(chart => chartPanel(chart, this.layout.sections[0]!.id)); this.initialized = true;}
        }
        this.session.open(this.layout, this.experimentId, saved); this.loadedRevision = this.preferences.workspaces.revision;
      }
      this.updateHeading(); this.updateControls(); this.syncPanels();
      if (catalog.truncated) this.showNotice("The metric catalog is partial; some fields are outside discovery budgets.");
      await this.queryVisible(fresh);
    } catch (error) {
      if (!request.signal.aborted) {
        if (this.cards.size) this.showNotice(`Updates unavailable. ${errorText(error)}`, () => {void this.refresh(true);});
        else this.grid.replaceChildren(message("Could not load panels", errorText(error), button("Try again", () => {void this.refresh(true);})));
      }
    } finally {if (this.catalogRequest === request) this.busy = false;}
  }
  /** Create one renderer per stable panel ID and keep section reparenting separate from data ownership. */
  private syncPanels(): void {
    this.layoutView.ensurePanels(new Set(this.layout.panels.map(panel => panel.id)));
    for (const [id, view] of this.cards) if (!this.layout.panels.some(panel => panel.id === id)) {
      this.observer.unobserve(view.element); view.destroy(); view.element.remove(); this.cards.delete(id); this.visible.delete(id);
    }
    if (!this.layout.panels.length && this.layout.sections.length === 1 && !this.layout.sections[0]!.name) {
      const captures = this.catalog?.runs.reduce((sum, run) => sum + run.snapshot_count, 0) ?? 0;
      const title = this.initialized ? "No panels selected" : !captures ? "Waiting for the first observation" : !this.catalog?.metrics.length ? "Choose a snapshot view" : "Choose recorded fields";
      this.grid.replaceChildren(message(title, "Use Add to create charts, metric statistics, snapshot views or sections.")); return;
    }
    if (!this.grid.contains(this.layoutView.element)) this.grid.replaceChildren(this.layoutView.element);
    for (const panel of this.layout.panels) {
      let view = this.cards.get(panel.id);
      if (view && ((view instanceof ChartRenderer) !== (panel.kind === "chart")
        || (view instanceof SnapshotVisualPanel) !== isSnapshotVisual(panel))) {
        const expanded = this.layoutView.releaseView(panel.id);
        this.observer.unobserve(view.element); view.destroy(); view.element.remove(); this.cards.delete(panel.id); this.visible.delete(panel.id); view = undefined;
        if (expanded) queueMicrotask(() => {
          if (!this.lifetime.signal.aborted && !this.openDialog && this.cards.has(panel.id)) this.layoutView.expand(panel.id);
        });
      }
      if (!view) {
        if (panel.kind === "chart") {
          view = new ChartRenderer(panel, this.metrics(chartPaths(panel))[0]!, action => this.panelAction(panel.id, action),
            this.colorFor, this.labelFor, () => {void this.queryVisible(true);});
          view.setScope(this.runs);
        } else if (isSnapshotVisual(panel)) {
          view = new SnapshotVisualPanel(panel, this.reads, this.labelFor, this.colorFor, action => this.panelAction(panel.id, action),
            "workspace", changed => this.updateRecordConfiguration(changed));
        } else view = new TablePanel(panel, this.reads, this.labelFor, action => this.panelAction(panel.id, action), "workspace",
          changed => this.updateRecordConfiguration(changed));
        view.element.dataset.panelId = panel.id; this.cards.set(panel.id, view); this.observer.observe(view.element);
      }
      if (view instanceof ChartRenderer && panel.kind === "chart") view.applySpec(panel);
      else if (view instanceof SnapshotVisualPanel && isSnapshotVisual(panel)) {
        view.applySpec(panel); if (this.catalog) view.setContext(this.catalog, this.runs, this.range);
      } else if (view instanceof TablePanel && panel.kind !== "chart") {view.applySpec(panel); if (this.catalog) view.setContext(this.catalog, this.runs, this.range);}
    }
    this.layoutView.sync(new Map<string, LayoutView>(this.cards));
    this.visibilityChanged(false);
  }
  /** Persist copied record-view settings while leaving position and width with the layout owner. */
  private updateRecordConfiguration(changed: TablePanelSpec): void {
    const index = this.layout.panels.findIndex(panel => panel.id === changed.id);
    const current = this.layout.panels[index];
    if (!current || current.kind === "chart") return;
    this.layout.panels[index] = {...copyPanel(changed), id: current.id, sectionId: current.sectionId, size: current.size};
    this.recordChange();
  }
  /** Find catalog fields or explicit unavailable placeholders without introducing unindexed API paths. */
  private metrics(paths: string[]): ChartMetric[] {
    return paths.map(path => this.catalog?.metrics.find(metric => metric.path === path) ?? {path, name: humanize(path.split("/").at(-1) ?? "Metric"), group: "Saved field", unit: null, run_ids: [], sources: []});
  }
  /** Fullscreen replaces the active viewport; collapsed groups never consume reads. */
  private activeIds(): Set<string> {
    if (this.suspended) return new Set();
    const expanded = this.layoutView.expandedId;
    return expanded ? new Set([expanded]) : new Set([...this.visible].filter(id => !this.layoutView.isCollapsed(id)));
  }
  /** Immediately cancel hidden table work and schedule only the visible chart projection. */
  private visibilityChanged(schedule = true): void {
    const active = this.activeIds();
    for (const [id, view] of this.cards) if (!(view instanceof ChartRenderer)) view.setActive(Boolean(this.catalog) && active.has(id) && !document.hidden);
    if (schedule) this.scheduleQuery(false);
  }
  /** Coalesce viewport changes without adding another refresh clock. */
  private scheduleQuery(_manual = true): void {
    this.cancelScheduled(); this.scheduled = setTimeout(() => {this.scheduled = null; void this.queryVisible();}, 40);
  }
  /** Release scheduled work before scope or visibility replacement. */
  private cancelScheduled(): void {if (this.scheduled) clearTimeout(this.scheduled); this.scheduled = null;}
  /** Batch visible chart fields; independent tables use authoritative reads on the same cadence. */
  private async queryVisible(fresh = false): Promise<void> {
    if (this.suspended || !this.catalog || !this.runs.length || this.runIds.length > 4 || document.hidden || this.lifetime.signal.aborted) return;
    if (fresh && this.queryRequest && !this.queryRequest.signal.aborted) return;
    this.queryRequest?.abort(); this.queryRequest = null;
    const active = this.activeIds();
    const charts = this.layout.panels.filter(panel => {
      const view = this.cards.get(panel.id);
      return panel.kind === "chart" && active.has(panel.id) && (fresh || !(view instanceof ChartRenderer) || !view.hasFailure);
    });
    for (const [id, view] of this.cards) if (!(view instanceof ChartRenderer)) {
      view.setContext(this.catalog, this.runs, this.range); view.setActive(active.has(id));
      if (active.has(id)) view.refresh(fresh);
    }
    if (!charts.length) return;
    if (!this.catalog.axes.includes(this.range.axis)) {
      for (const panel of charts) {const view = this.cards.get(panel.id); if (view instanceof ChartRenderer) view.fail("This alignment is not recorded. Choose another time alignment.");}
      return;
    }
    const allPaths = [...new Set(charts.flatMap(panel => panel.kind === "chart" ? chartPaths(panel) : []))];
    const metrics = this.metrics(allPaths).filter(metric => metric.sources.length);
    for (const panel of charts) if (panel.kind === "chart" && !chartPaths(panel).some(path => metrics.some(metric => metric.path === path))) {
      const view = this.cards.get(panel.id); if (view instanceof ChartRenderer) view.unavailable(this.runs, this.catalog.truncated);
    }
    if (!metrics.length) return;
    const sources = [...new Set(metrics.flatMap(metric => this.runs.flatMap(run => reporters(metric, run.id).map(source => source.source_id))))];
    const request = new AbortController(); this.queryRequest = request;
    for (const panel of charts) {const view = this.cards.get(panel.id); if (view instanceof ChartRenderer) view.beginRead();}
    try {
      const result = await this.reads.query({run_ids: this.runs.map(run => run.id), paths: metrics.map(metric => metric.path),
        ...(sources.length ? {source_ids: sources} : {}), axis: this.range.axis, ...rangeBounds(this.range, this.catalog),
        max_points: Math.max(1, Math.min(1600, Math.floor(40_000 / Math.max(1, metrics.reduce((sum, metric) => sum + metric.sources.length, 0)))))}, request.signal, fresh);
      if (request.signal.aborted) return;
      if (result.axis !== this.range.axis) throw new Error("The returned projection uses another alignment.");
      for (const panel of charts) if (panel.kind === "chart") {
        const view = this.cards.get(panel.id), paths = chartPaths(panel);
        if (view instanceof ChartRenderer && paths.some(path => metrics.some(metric => metric.path === path))) view.updateCombined(this.metrics(paths), result.series.filter(series => paths.includes(series.path)), this.runs, result.axis);
      }
    } catch (error) {if (!request.signal.aborted) for (const panel of charts) {const view = this.cards.get(panel.id); if (view instanceof ChartRenderer) view.fail(errorText(error));}}
    finally {if (this.queryRequest === request) this.queryRequest = null;}
  }
  /** Apply explicit time changes while retaining panel identity and table browse ownership. */
  private rangeChanged(): void {
    this.updateControls(); this.rangeUpdated(this.range);
    for (const card of this.cards.values()) card.resetZoom();
    this.queryRequest?.abort(); if (!this.initialized) void this.refresh(); else void this.queryVisible(true);
  }
  /** Handle only visible editing actions; reordering belongs to the dedicated drag handle. */
  private panelAction(id: string, action: PanelAction): void {
    const index = this.layout.panels.findIndex(panel => panel.id === id);
    const panel = this.layout.panels[index]; if (!panel) return;
    if (action === "edit") {this.openEditor(panel); return;}
    if (action === "expand") {this.layoutView.expand(id); return;}
    if (action === "remove") this.layout.panels = this.layout.panels.filter(panel => panel.id !== id);
    else panel.size = panel.size === "normal" ? "wide" : "normal";
    this.initialized = true; this.recordChange(); this.syncPanels();
    if (action === "remove") {
      const next = this.layout.panels[index] ?? this.layout.panels.at(-1);
      if (next) this.cards.get(next.id)?.focusOptions(); else this.addControl.focus();
    }
  }
  /** Own one editor at a time and release preview reads synchronously on every close path. */
  private modal(title: string, className = "", onClose?: () => void): ReturnType<typeof dialog> {
    this.openDialog?.close();
    const modal = dialog(title, className, () => {onClose?.(); if (this.openDialog === modal) this.openDialog = null;}); this.openDialog = modal; return modal;
  }
  /** Expose Chart, both table kinds and Section in one isolated Add surface. */
  private openEditor(existing?: PanelSpec, sectionId?: string): void {
    let editor: AddEditor | null = null;
    const modal = this.modal(existing ? "Edit panel" : "Add", "chart-editor", () => editor?.destroy());
    editor = new AddEditor(modal, {catalog: this.catalog ?? blankCatalog, runs: this.runs, range: {...this.range},
      panels: this.layout.panels.map(copyPanel), sections: this.layout.sections.map(section => ({...section})),
      targetSection: sectionId ?? existing?.sectionId ?? this.layout.sections[0]!.id, ...(existing ? {existing: copyPanel(existing)} : {}),
      colorFor: this.colorFor, labelFor: this.labelFor}, this.reads, result => this.commitPanels(result, existing?.id));
  }
  /** Preserve the edited panel ID and allow independent charts/tables to reuse the same metric paths. */
  private commitPanels(result: AddResult, previousId?: string): void {
    this.initialized = true;
    if (result.kind === "section") {this.layoutView.addSection(result.name); return;}
    const index = previousId ? this.layout.panels.findIndex(panel => panel.id === previousId) : -1;
    const panels = result.panels.map(copyPanel);
    if (index >= 0) {
      this.layout.panels.splice(index, 1, ...panels);
    } else this.layout.panels.push(...panels);
    for (const panel of panels) {const section = this.layout.sections.find(section => section.id === panel.sectionId); if (section) section.collapsed = false;}
    this.recordChange(); this.syncPanels(); this.scheduleQuery();
  }
  /** Keep human time editing separate from display-only panel settings. */
  private timeSettings(): void {
    const modal = this.modal("Time settings");
    renderTimeSettings(modal, this.catalog?.axes ?? ["wall_time", "elapsed"], this.range, range => {
      if ((["axis", "window", "from", "to"] as const).some(key => range[key] !== this.range[key])) {this.range = range; this.rangeChanged(); this.syncPanels();}
    }, this.catalog ? rangeBounds(this.range, this.catalog) : this.range);
  }
  /** Switch from a cached anchored list immediately, refreshing only its rows when safe. */
  private workspaceSets(rename = false): void {
    if (this.openDialog?.node.classList.contains("workspace-popover")) {
      if (rename) this.openDialog.node.querySelector<HTMLButtonElement>('[aria-label="Rename workspace"]')?.click();
      else this.openDialog.close();
      return;
    }
    const modal = this.workspacePopover("Workspace sets");
    modal.node.classList.add("workspace-menu");
    const refreshRows = this.renderWorkspaceSets(modal);
    if (rename) modal.node.querySelector<HTMLButtonElement>('[aria-label="Rename workspace"]')?.click();
    else modal.node.querySelector<HTMLElement>('[aria-current="true"], .saved-set-name, [aria-label="Workspace set name"]')?.focus({preventScroll: true});
    const revision = this.preferences.workspaces.revision;
    void this.preferences.bootstrap().then(ok => {
      if (this.openDialog !== modal) return;
      if (ok && this.session.id && !this.preferences.data.sets.some(set => set.id === this.session.id)) {
        this.session.detach(); this.loadedRevision = this.preferences.workspaces.revision; this.updateWorkspaceHeader();
      }
      const current = this.preferences.data.sets.find(set => set.id === this.session.id);
      if (ok && current && current.name !== this.session.name) {this.session.name = current.name; this.updateWorkspaceHeader();}
      if (ok && revision !== this.preferences.workspaces.revision && !modal.node.querySelector(".workspace-rename-input")) refreshRows();
    });
  }
  /** Keep workspace management limited to saved definitions and direct layout actions. */
  private renderWorkspaceSets(modal: ReturnType<typeof dialog>): () => void {
    const list = el("div", "workspace-set-list"), search = el("input", "text-input workspace-search");
    search.type = "search"; search.placeholder = "Find workspace"; search.setAttribute("aria-label", "Search workspaces");
    const renderRows = (): void => {
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.workspaceId : undefined;
      const top = list.scrollTop;
      list.replaceChildren();
      const sets = this.preferences.data.sets.filter(set => set.experimentId === this.workspaceScope)
        .sort((a, b) => Number(b.id === this.session.id) - Number(a.id === this.session.id) || workspaceNames.compare(a.name, b.name));
      search.hidden = sets.length <= 8 && !search.value;
      for (const set of sets.filter(set => set.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))) {
        const row = el("div", "saved-set");
        const remove = iconButton(`Delete workspace set ${set.name}`, "trash", () => {
          remove.disabled = true;
          void this.preferences.remove(set.id).then(ok => {
            remove.disabled = false;
            if (!ok) {if (this.preferences.conflict) this.resolveConflict(); return;}
            if (this.session.id === set.id) {this.session.detach(); this.loadedRevision = this.preferences.workspaces.revision; this.updateWorkspaceHeader();}
            else this.reconcilePreferences();
            row.remove();
          });
        });
        const choose = button(set.name, () => {
          if (set.id === this.session.id && !this.session.dirty) {modal.close(); return;}
          this.confirmDiscard(() => this.activateWorkspace(set));
        }, "button quiet saved-set-name");
        choose.dataset.workspaceId = set.id;
        if (set.id === this.session.id) choose.setAttribute("aria-current", "true");
        row.append(choose);
        if (set.id === this.session.id) row.append(iconButton("Rename workspace", "edit", () => this.renameWorkspace(modal, row, set)));
        row.append(remove); list.append(row);
      }
      if (!list.childElementCount && search.value) list.append(el("p", "workspace-list-empty muted", "No matches"));
      list.scrollTop = top;
      if (focused) [...list.querySelectorAll<HTMLButtonElement>("[data-workspace-id]")].find(button => button.dataset.workspaceId === focused)?.focus({preventScroll: true});
    };
    search.addEventListener("input", () => {list.scrollTop = 0; renderRows();});
    list.addEventListener("keydown", event => {
      if (event.target instanceof HTMLInputElement || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const choices = [...list.querySelectorAll<HTMLButtonElement>(".saved-set-name")];
      if (!choices.length) return;
      const current = choices.findIndex(choice => choice === document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length;
      event.preventDefault(); choices[next]?.focus();
    });
    modal.body.append(search, list);
    const actions = el("div", "workspace-list-actions");
    const saveAs = button("Save as…", () => {
      saveAs.hidden = true; this.renderSaveForm(modal);
      const input = modal.body.querySelector<HTMLInputElement>('[aria-label="Workspace set name"]');
      input?.focus(); input?.select();
    }, "text-button");
    const reset = iconButton("Reset to defaults", "refresh", () => this.confirmDiscard(() => {
      const scope = this.workspaceScope;
      if (scope) this.preferences.select(scope, null);
      this.layout = emptyLayout(); this.layout.panels = (this.catalog ? defaultCharts(this.catalog) : []).map(chart => chartPanel(chart, this.layout.sections[0]!.id));
      this.session.open(this.layout, scope); this.loadedRevision = this.preferences.workspaces.revision; this.initialized = this.layout.panels.length > 0;
      this.openDialog?.close(); this.updateWorkspaceHeader(); this.syncPanels(); this.scheduleQuery();
    }));
    actions.append(saveAs, reset); modal.body.append(actions);
    if (!this.session.id) {saveAs.hidden = true; this.renderSaveForm(modal);}
    renderRows();
    return renderRows;
  }
  /** Own one lightweight header-anchored editor or picker at a time. */
  private workspacePopover(title: string): ReturnType<typeof dialog> {
    this.openDialog?.close();
    const modal = anchoredDialog(title, this.setsControl, () => {if (this.openDialog === modal) this.openDialog = null;});
    this.openDialog = modal;
    return modal;
  }
  /** Rename the active saved definition in place; unsaved panel edits remain separate and dirty. */
  private renameWorkspace(modal: ReturnType<typeof dialog>, row: HTMLElement, set: WorkspaceSet): void {
    const name = el("input", "text-input workspace-rename-input"); name.value = set.name; name.maxLength = 80;
    name.setAttribute("aria-label", "Workspace name");
    const error = el("p", "error-text workspace-rename-error"); error.setAttribute("role", "status");
    const save = iconButton("Apply workspace name", "check", () => {void commit();});
    const cancel = iconButton("Cancel rename", "close", () => {modal.close(); this.workspaceSets();});
    const commit = async (): Promise<void> => {
      if (!name.value.trim()) {error.textContent = "Enter a name."; name.focus(); return;}
      if (name.value.trim() === set.name) {modal.close(); return;}
      save.disabled = name.disabled = cancel.disabled = true;
      const ok = await this.writeWorkspace(name.value.trim(), false, true);
      if (this.openDialog !== modal) return;
      if (ok && this.session.name === name.value.trim()) modal.close();
      else {
        save.disabled = name.disabled = cancel.disabled = false;
        error.textContent = ok ? "Previous rename confirmed. Apply the new name." : this.preferences.error || "Rename failed.";
        name.focus();
      }
    };
    name.addEventListener("keydown", event => {
      if (event.key === "Enter") {event.preventDefault(); void commit();}
    });
    row.classList.add("is-renaming"); row.replaceChildren(name, save, cancel, error); name.focus(); name.select();
  }
  /** Bind a save-name form to the same transactional write used by the persistent header action. */
  private renderSaveForm(modal: ReturnType<typeof dialog>, after?: () => void, copy = false): void {
    const name = el("input", "text-input"); name.maxLength = 80;
    name.value = copy ? `${this.session.name} copy`.slice(0, 80) : this.session.id ? this.session.name : ""; name.setAttribute("aria-label", "Workspace set name");
    const status = el("p", "muted"); status.setAttribute("role", "status");
    const save = button("Save", () => {
      if (!name.value.trim()) {status.textContent = "Give the workspace set a name."; name.focus(); return;}
      if (copy && this.preferences.data.sets.some(set => set.experimentId === this.workspaceScope && set.name === name.value.trim())) {
        status.textContent = "Choose a new name to preserve the server version."; return;
      }
      save.disabled = true;
      void this.writeWorkspace(name.value.trim(), copy).then(ok => {
        save.disabled = false;
        if (ok) {const active = this.openDialog === modal; modal.close(); if (active && !this.session.dirty) after?.();}
        else status.textContent = "Save failed. Your draft remains available.";
      });
    }, "button primary"); save.disabled = !this.workspaceScope;
    const updateSave = (): void => {
      const existing = this.preferences.data.sets.some(set => set.experimentId === this.workspaceScope && set.name === name.value.trim());
      save.querySelector("span")!.textContent = existing ? "Update" : "Save";
      save.setAttribute("aria-label", existing ? "Update workspace set" : "Save workspace set");
      status.textContent = "";
    };
    name.addEventListener("input", updateSave); updateSave();
    name.addEventListener("keydown", event => {if (event.key === "Enter") {event.preventDefault(); if (!save.disabled) save.click();}});
    name.placeholder = "Workspace name";
    const form = el("div", "workspace-save-form");
    form.append(name, save); modal.body.append(form, status);
  }
  /** Accept the immutable submitted baseline, retaining edits made while the save was in flight. */
  private async writeWorkspace(name: string, copy = false, rename = false): Promise<boolean> {
    const scope = this.workspaceScope;
    if (!scope) {this.showNotice("Select a Run before saving a workspace."); return false;}
    if (this.saving) return false;
    const stored = rename ? this.preferences.data.sets.find(set => set.id === this.session.id) : undefined;
    if (rename && !stored) {this.showNotice("This workspace is no longer available. Reopen the workspace list."); return false;}
    const modal = this.openDialog;
    this.saving = true; this.updateWorkspaceHeader();
    const submitted = this.preferences.uncertain ? await this.preferences.retrySave()
      : await this.preferences.save(name, scope, stored ?? this.layout, copy || rename ? this.preferences.workspaces.revision : this.loadedRevision,
        !copy && this.session.id && (rename || name === this.session.name) ? this.session.id : undefined);
    this.saving = false;
    if (this.lifetime.signal.aborted) return false;
    if (!submitted) {
      this.session.failed(); this.updateWorkspaceHeader();
      if (!rename && this.preferences.conflict && this.openDialog === modal) this.resolveConflict();
      return false;
    }
    this.session.saved(submitted, this.layout); this.loadedRevision = this.preferences.lastSavedRevision;
    this.updateWorkspaceHeader(); return true;
  }
  /** Save named workspaces directly; new drafts require one explicit name before persistence. */
  private saveCurrent(after?: () => void): void {
    if (this.preferences.conflict) {this.resolveConflict(); return;}
    if (this.preferences.pendingDeletion) {this.showNotice("Retry the pending deletion in the server settings notification before saving."); return;}
    if (!this.session.id && !this.preferences.uncertain) {
      const modal = this.workspacePopover("Save workspace");
      this.renderSaveForm(modal, after); modal.body.querySelector<HTMLInputElement>("input")?.focus(); return;
    }
    const modal = this.openDialog;
    void this.writeWorkspace(this.session.name).then(ok => {
      if (ok && this.openDialog === modal) {modal?.close(); if (!this.session.dirty) after?.();}
    });
  }
  /** Conflicts are an explicit fork/reload decision; never silently refresh a revision and overwrite. */
  private resolveConflict(): void {
    const modal = this.workspacePopover("Workspace changed on server");
    const actions = el("div", "workspace-confirm-actions");
    const reload = button("Reload", () => {
        const current = this.preferences.data.sets.find(set => set.id === (this.session.id ?? this.preferences.conflictRecord?.id));
        this.preferences.conflict = null;
        if (current) this.activateWorkspace(current);
        else {this.session.detach(); this.loadedRevision = this.preferences.workspaces.revision; modal.close(); this.updateWorkspaceHeader();}
      }, "button quiet");
    reload.setAttribute("aria-label", "Reload server version");
    const keep = button("Keep draft", modal.close, "button quiet");
    actions.append(reload, button("Save copy", () => {
      const copy = this.workspacePopover("Save workspace copy"); this.renderSaveForm(copy, undefined, true);
      copy.body.querySelector<HTMLInputElement>("input")?.select();
    }, "button primary"), keep);
    modal.body.append(el("p", "workspace-confirm-message", "Changed on the server. Your draft is preserved."), actions);
    keep.focus();
  }
  /** Guard replacing edited layouts and permit continuing only after a successful save or explicit discard. */
  private confirmDiscard(action: () => void): void {
    if (this.saving || this.preferences.uncertain) {this.showNotice("Finish or retry the pending save before switching workspaces."); return;}
    if (!this.session.dirty) {action(); return;}
    const modal = this.workspacePopover("Unsaved changes"), actions = el("div", "workspace-confirm-actions");
    const save = button("Save", () => this.saveCurrent(action), "button primary");
    save.setAttribute("aria-label", "Save and continue");
    const discard = button("Discard", () => {modal.close(); action();}, "button quiet");
    discard.setAttribute("aria-label", "Discard changes");
    const cancel = button("Cancel", modal.close, "button quiet");
    actions.append(save, discard, cancel);
    modal.body.append(el("p", "workspace-confirm-message", `“${this.session.name}” has unsaved changes.`), actions);
    cancel.focus();
  }
  /** Switch identity, baseline and visible layout together after storage accepts the chosen workspace. */
  private activateWorkspace(set: WorkspaceSet): void {
    const current = this.preferences.data.sets.find(item => item.id === set.id);
    if (!current) {this.showNotice("This saved workspace is no longer available. Open the workspace list again."); return;}
    this.preferences.select(current.experimentId, current.id);
    this.layout = copyLayout(current); this.session.open(this.layout, current.experimentId, current); this.loadedRevision = this.preferences.workspaces.revision; this.initialized = true;
    this.openDialog?.close(); this.updateWorkspaceHeader(); this.syncPanels(); this.scheduleQuery();
  }
  /** Reconnect discovery updates metadata only; it never replaces an unsaved or in-flight layout. */
  reconcilePreferences(): void {
    if (this.saving || this.preferences.uncertain) return;
    const current = this.preferences.data.sets.find(set => set.id === this.session.id);
    if (this.session.id && !current) {this.session.detach(); this.loadedRevision = this.preferences.workspaces.revision; this.updateWorkspaceHeader(); return;}
    if (!this.session.id && !this.session.dirty) {
      const selected = this.preferences.selected(this.workspaceScope);
      if (selected) this.activateWorkspace(selected);
      else this.loadedRevision = this.preferences.workspaces.revision;
    } else if (current) {
      this.session.name = current.name;
      if (layoutSignature(current) !== layoutSignature(this.layout)) {
        this.showNotice("A newer workspace is available on the server. Your current layout is unchanged.", () => {
          this.confirmDiscard(() => this.activateWorkspace(current));
        });
      } else if (!this.session.dirty) {
        this.session.open(this.layout, current.experimentId, current); this.loadedRevision = this.preferences.workspaces.revision;
      }
      this.updateWorkspaceHeader();
    }
  }
  refreshNow(): void {if (!this.busy && !this.queryRequest) void this.refresh(true);}
  /** Suspend transport, not panel state, while authentication is being restored. */
  suspend(suspended: boolean): void {
    this.suspended = suspended;
    if (suspended) {
      this.catalogRequest?.abort(); this.queryRequest?.abort(); this.cancelScheduled();
      for (const card of this.cards.values()) if (!(card instanceof ChartRenderer)) card.setActive(false);
    } else void this.refresh(true);
  }
  /** Reuse the existing save/discard guard before a deliberate sign-out. */
  prepareToLeave(action: () => void): void {this.confirmDiscard(action);}
  /** Keep selected swatches and rendered curves synchronized without changing query state. */
  refreshColors(): void {
    this.updateHeading();
    for (const card of this.cards.values()) if (card instanceof ChartRenderer || card instanceof SnapshotVisualPanel) card.refreshColors();
  }
  retrySave(): void {this.saveCurrent();}
  /** Present recoverable failures without discarding successful evidence. */
  private showNotice(text: string, retry?: () => void): void {
    this.notice.hidden = false; this.notice.replaceChildren(el("span", "", text));
    if (retry) this.notice.append(button("Try again", retry, "text-button"));
    this.notice.append(iconButton("Dismiss message", "close", () => {this.notice.hidden = true;}));
  }
  /** Release expanded DOM, previews, reads, tables, charts and all viewport observers together. */
  destroy(): void {
    this.lifetime.abort(); this.catalogRequest?.abort(); this.queryRequest?.abort(); this.cancelScheduled(); clearInterval(this.timer);
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.layoutView.destroy(); this.observer.disconnect(); for (const card of this.cards.values()) card.destroy();
    this.cards.clear(); this.openDialog?.close();
  }
}
