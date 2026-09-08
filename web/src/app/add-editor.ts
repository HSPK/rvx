import {uiIdentifier} from "../core/identifiers";
import type {ChartCatalog, ChartMetric} from "../domain/snapshots";
import type {TableCatalogResponse, TableDefinition} from "../domain/tables";
import type {ExperimentRun} from "../domain/types";
import {ChartRenderer} from "./chart";
import type {MetricCatalogQueryCoordinator} from "./coordinator";
import {matchingMetrics, metricEntries} from "./metric-catalog";
import {axisLabel, chartPaths, compatibleMetrics, copyChart, humanize, isAmbiguous, metricName, rangeBounds, reporters, validChartSpec, type ChartPresentation, type ChartSpec, type RangeState} from "./model";
import {copyPanel, isSnapshotVisual, panelLimit, sectionLimit, type PanelSpec, type SectionSpec, type TablePanelSpec, type ColumnPreference, type TableQueryPreference} from "./panels";
import {TablePanel} from "./table-panel";
import {SnapshotVisualPanel} from "./snapshot-visual/panel";
import {SnapshotBindings} from "./snapshot-bindings";
import {collectionLabel} from "./table-view";
import {button, el, errorText, field, select, type dialog} from "./ui";

interface AddContext {
  catalog: ChartCatalog; runs: ExperimentRun[]; range: RangeState; panels: PanelSpec[]; sections: SectionSpec[];
  targetSection: string; existing?: PanelSpec; colorFor: (id: string) => string; labelFor: (run: ExperimentRun) => string;
}
export type AddResult = {kind: "panels"; panels: PanelSpec[]} | {kind: "section"; name: string};
type AddKind = PanelSpec["kind"] | "section";

/** Own one isolated multi-selection draft, real preview and explicit Add/Save transaction. */
export class AddEditor {
  private lifetime = new AbortController();
  private request: AbortController | null = null;
  private catalogRequest: AbortController | null = null;
  private preview: ChartRenderer | TablePanel | SnapshotVisualPanel | null = null;
  private bindings: SnapshotBindings;
  private tableDraft: {columns?: ColumnPreference[]; query?: TableQueryPreference} = {};
  private previewHost = el("div", "chart-preview");
  private results = el("div", "metric-results");
  private search = el("input", "text-input");
  private count = el("span", "metric-selection-count muted");
  private error = el("p", "editor-error error-text");
  private settings = el("div", "presentation-settings");
  private sourceChoices = el("fieldset", "reporter-choices");
  private chartFields: HTMLElement[] = [];
  private primary: HTMLButtonElement;
  private clearControl: HTMLButtonElement;
  private mode: AddKind = "chart";
  private typeTabs = new Map<AddKind, HTMLButtonElement>();
  private modeSettings = el("div", "add-mode-settings");
  private panes = el("div", "editor-panes");
  private layoutInput: HTMLSelectElement;
  private sectionInput: HTMLSelectElement;
  private titleInput = el("input", "text-input");
  private widthInput = el("input", "text-input");
  private yMinInput = el("input", "text-input");
  private yMaxInput = el("input", "text-input");
  private styleInput: HTMLSelectElement;
  private pointsInput: HTMLSelectElement;
  private legendInput: HTMLSelectElement;
  private sizeInput: HTMLSelectElement;
  private selection = new Set<string>();
  private previewPath = "";
  private collectionPath: string | null = null;
  private tableCatalog: TableCatalogResponse | null = null;
  private sourceIds: Set<string> | null = null;
  private display: ChartPresentation = {};
  private draftError = "";
  private frame = 0;
  private entries: ReturnType<typeof metricEntries>;

  /** Keep checking fields separate from filtering and committing; previews use the same renderers and read coordinator. */
  constructor(private modal: ReturnType<typeof dialog>, private context: AddContext, private reads: MetricCatalogQueryCoordinator, private commit: (result: AddResult) => void) {
    const existing = context.existing;
    this.bindings = new SnapshotBindings(() => {
      this.updateDisplay();
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {this.frame = 0; void this.loadPreview();});
    }, existing?.kind === "snapshot-table" ? existing.view : undefined);
    if (existing && existing.kind !== "chart") this.rememberTableSettings(existing);
    this.entries = metricEntries(context.catalog, []);
    if (existing?.kind === "chart") {chartPaths(existing).forEach(path => this.selection.add(path)); this.display = {...existing.presentation};}
    else if (existing?.kind === "metric-table") existing.paths.forEach(path => this.selection.add(path));
    else if (existing?.kind === "snapshot-table") this.collectionPath = existing.path;
    if (existing && existing.kind !== "chart" && existing.sourceIds) this.sourceIds = new Set(existing.sourceIds);
    this.previewPath = [...this.selection][0] ?? this.entries.find(entry => entry.metric.sources.some(source => source.latest_value !== null))?.metric.path ?? this.entries[0]?.metric.path ?? "";
    const changed = (): void => {this.updateDisplay();};
    this.mode = existing?.kind ?? "chart";
    this.layoutInput = select("Chart layout", [["separate", "Separate charts"], ["combined", "Combined plot"]], existing?.kind === "chart" && chartPaths(existing).length > 1 ? "combined" : "separate", () => {this.updateDisplay(); void this.loadPreview();});
    this.sectionInput = select("Destination section", context.sections.map(section => [section.id, section.name || "Initial section"]), existing?.sectionId ?? context.targetSection, () => {});
    const bar = el("div", "add-mode-bar");
    this.modeSettings.append(this.layoutInput, this.sectionInput);
    bar.append(this.buildTypeTabs());
    modal.node.querySelector(".dialog-header > .icon-button")!.before(this.modeSettings);
    const left = el("section", "editor-metrics"); left.setAttribute("aria-label", "Metric and collection selection");
    this.search.type = "search"; this.search.placeholder = "Search metrics…"; this.search.setAttribute("aria-label", "Search metrics");
    const searchRow = el("div", "editor-search-row");
    this.clearControl = button("Clear", () => {this.selection.clear(); this.renderList(); this.updateDisplay(); void this.loadPreview();}, "text-button");
    searchRow.append(this.search, this.clearControl);
    left.append(searchRow, this.results);
    const right = el("section", "editor-preview-pane");
    this.styleInput = select("Presentation", [["line", "Line"], ["area", "Area"]], this.display.style ?? "line", changed);
    this.pointsInput = select("Points", [["auto", "Automatic"], ["show", "Show"], ["hide", "Hide"]], this.display.points === undefined ? "auto" : this.display.points ? "show" : "hide", changed);
    this.legendInput = select("Legend", [["auto", "Automatic"], ["show", "Show"], ["hide", "Hide"]], this.display.legend ?? "auto", changed);
    this.sizeInput = select("Panel width", [["normal", "Normal"], ["wide", "Wide"]], existing?.size ?? "normal", changed);
    this.titleInput.setAttribute("aria-label", "Panel title"); this.titleInput.maxLength = 120;
    this.titleInput.value = existing?.kind === "chart" ? existing.presentation?.title ?? "" : existing?.title ?? "";
    this.widthInput.type = "number"; this.widthInput.min = ".5"; this.widthInput.max = "6"; this.widthInput.step = ".1"; this.widthInput.value = String(this.display.lineWidth ?? 1.8); this.widthInput.setAttribute("aria-label", "Line width");
    for (const [input, label, value] of [[this.yMinInput, "Y minimum", this.display.yMin], [this.yMaxInput, "Y maximum", this.display.yMax]] as const) {
      input.inputMode = "decimal"; input.placeholder = "Auto"; input.value = value === undefined ? "" : String(value); input.setAttribute("aria-label", label);
    }
    for (const input of [this.titleInput, this.widthInput, this.yMinInput, this.yMaxInput]) input.addEventListener("input", changed);
    for (const [label, input, area] of [["Title", this.titleInput, "title"], ["Presentation", this.styleInput, "style"], ["Line width", this.widthInput, "line"], ["Points", this.pointsInput, "points"], ["Legend", this.legendInput, "legend"], ["Width", this.sizeInput, "width"], ["Y minimum", this.yMinInput, "ymin"], ["Y maximum", this.yMaxInput, "ymax"]] as const) {
      const wrapper = field(label, input); wrapper.style.gridArea = area; this.settings.append(wrapper);
      if (!["title", "width"].includes(area)) this.chartFields.push(wrapper);
    }
    right.append(this.bindings.tabs, this.previewHost, this.settings, this.bindings.element, this.sourceChoices);
    this.panes.append(left, right);
    const footer = el("footer", "editor-actions"); this.error.setAttribute("role", "alert");
    this.primary = button(existing ? "Save changes" : "Add", () => this.save(), "button primary");
    footer.append(this.count, this.error, button("Cancel", modal.close, "button quiet"), this.primary);
    modal.body.replaceChildren(bar, this.panes, footer);
    this.search.addEventListener("input", () => this.renderList());
    this.search.addEventListener("keydown", event => {
      const checks = this.results.querySelectorAll<HTMLInputElement>("input[type=checkbox]:not(:disabled)");
      if (event.key === "ArrowDown" && checks.length) {event.preventDefault(); checks[0]!.focus();}
      if (event.key === "Enter" && checks.length === 1) {event.preventDefault(); if (!checks[0]!.checked) checks[0]!.click();}
    });
    this.results.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...this.results.querySelectorAll<HTMLInputElement>("input[type=checkbox]:not(:disabled)")];
      const current = items.indexOf(event.target instanceof HTMLInputElement ? event.target : items[0]!);
      event.preventDefault();
      if (event.key === "ArrowUp" && current === 0) {this.search.focus(); return;}
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
      items[next]?.focus();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {this.request?.abort(); this.catalogRequest?.abort(); if (this.preview && !(this.preview instanceof ChartRenderer)) this.preview.setActive(false);}
      else if (this.mode === "snapshot-table" && !this.tableCatalog) void this.loadTables();
      else void this.loadPreview();
    }, {signal: this.lifetime.signal});
    this.changeMode(); this.search.focus();
  }
  /** Use one shared preview panel with native buttons and roving keyboard focus for the four Add types. */
  private buildTypeTabs(): HTMLElement {
    const tabs = el("div", "add-type-tabs");
    tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Add type");
    this.panes.id = uiIdentifier("add-content"); this.panes.setAttribute("role", "tabpanel");
    const choices: [AddKind, string][] = [["chart", "Chart"], ["metric-table", "Metric table"], ["snapshot-table", "Snapshot"], ["section", "Section"]];
    for (const [kind, label] of choices) {
      const tab = button(label, () => {
        if (this.mode === kind) return;
        this.mode = kind; this.sourceIds = null; this.tableDraft = {}; this.changeMode();
      }, "add-type-tab");
      tab.id = uiIdentifier("add-tab"); tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", this.panes.id);
      tab.disabled = Boolean(this.context.existing && this.context.existing.kind !== kind);
      this.typeTabs.set(kind, tab); tabs.append(tab);
    }
    tabs.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const buttons = [...this.typeTabs.values()].filter(tab => !tab.disabled);
      const index = buttons.findIndex(tab => tab === event.target);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]!.focus(); buttons[next]!.click();
    });
    return tabs;
  }
  /** Swap only the preview kind; unsaved selections remain intact across search and mode changes. */
  private changeMode(): void {
    this.request?.abort(); this.catalogRequest?.abort(); this.preview?.destroy(); this.preview = null;
    this.previewHost.replaceChildren();
    this.sourceChoices.replaceChildren();
    const chart = this.mode === "chart", snapshot = this.mode === "snapshot-table", section = this.mode === "section";
    for (const [kind, tab] of this.typeTabs) {
      const selected = kind === this.mode;
      tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
      if (selected) this.panes.setAttribute("aria-labelledby", tab.id);
    }
    this.modal.node.classList.toggle("section-only", section);
    this.clearControl.hidden = snapshot || section;
    this.layoutInput.hidden = !chart; this.sectionInput.hidden = section || this.context.sections.length === 1;
    this.modeSettings.hidden = this.layoutInput.hidden && this.sectionInput.hidden;
    this.settings.hidden = false; this.chartFields.forEach(field => {field.hidden = !chart;});
    this.settings.classList.toggle("collection-settings", !chart);
    this.bindings.tabs.hidden = !snapshot; this.bindings.element.hidden = !snapshot || !this.bindings.value;
    this.sourceChoices.hidden = chart || section;
    this.titleInput.maxLength = section ? 100 : 120;
    this.search.placeholder = snapshot ? "Search collections…" : "Search metrics…";
    this.search.setAttribute("aria-label", snapshot ? "Search collections" : "Search metrics");
    if (!this.context.existing && !chart) this.sizeInput.value = "wide";
    this.sizeInput.closest(".field")!.classList.toggle("hidden-setting", section);
    this.renderList(); this.updateDisplay();
    if (snapshot) void this.loadTables(); else void this.loadPreview();
  }
  /** Keep all checked fields while filtering, and leave real space between hover rectangles. */
  private renderList(): void {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>(".metric-option")?.dataset.path : undefined;
    this.results.replaceChildren();
    const mode = this.mode;
    if (mode === "section") {
      this.count.hidden = true;
      this.count.textContent = "New section";
      this.results.append(el("p", "editor-list-note muted", "A section groups panels in this workspace. Deleting it later will not delete its panels."));
      return;
    }
    if (mode === "snapshot-table") {
      this.count.hidden = !this.tableCatalog?.truncated;
      this.count.textContent = this.tableCatalog?.truncated ? "Partial collection catalog" : "Snapshot collections";
      const tables = this.tableCatalog?.tables.filter(table => `${table.name} ${table.path}`.toLowerCase().includes(this.search.value.toLowerCase())) ?? [];
      for (const table of tables.slice(0, 100)) {
        const label = collectionLabel(table);
        const option = button(label, () => {
          this.collectionPath = table.path; this.sourceIds = null;
          this.bindings.setCollection(table); this.renderList(); this.updateDisplay(); void this.loadPreview();
        }, "collection-option");
        option.title = table.path || "Root";
        option.dataset.path = table.path; option.setAttribute("aria-pressed", String(this.collectionPath === table.path));
        const heading = el("span", "collection-heading");
        const count = table.sources.reduce((sum, source) => sum + source.row_count, 0);
        heading.append(el("span", "collection-label", label), el("small", "collection-count muted", `${count.toLocaleString()} ${count === 1 ? "row" : "rows"}`));
        const path = el("code", "collection-path muted");
        if (!table.path) path.textContent = "(root)";
        else for (const [index, part] of table.path.split("/").entries()) {
          if (index) path.append(el("wbr"), "/");
          path.append(part);
        }
        option.replaceChildren(heading, path);
        this.results.append(option);
      }
      if (tables.length > 100) this.results.append(el("p", "editor-list-note muted", `${tables.length} matching collections. Refine the search to see more.`));
      if (this.tableCatalog && !tables.length) this.results.append(el("p", "editor-list-note muted", "No matching snapshot collections."));
      return;
    }
    const matching = matchingMetrics(this.entries, this.search.value);
    this.clearControl.disabled = !this.selection.size;
    const outside = [...this.selection].filter(path => !matching.some(entry => entry.metric.path === path)).length;
    this.count.textContent = `${this.selection.size} selected${outside ? ` · ${outside} outside search` : ""}`;
    this.count.hidden = this.selection.size === 0;
    let group = "";
    for (const entry of matching.slice(0, 100)) {
      if (!this.search.value.trim() && group !== entry.group) {group = entry.group; this.results.append(el("h3", "metric-group", group));}
      const row = el("div", "metric-option"); row.dataset.path = entry.metric.path;
      row.classList.toggle("is-selected", this.selection.has(entry.metric.path)); row.classList.toggle("is-preview", this.previewPath === entry.metric.path);
      const check = el("input", "metric-checkbox"); check.type = "checkbox"; check.checked = this.selection.has(entry.metric.path);
      check.setAttribute("aria-label", `Select metric ${entry.name}`);
      check.addEventListener("change", () => {
        check.checked ? this.selection.add(entry.metric.path) : this.selection.delete(entry.metric.path);
        this.previewPath = entry.metric.path; this.renderList(); this.updateDisplay(); void this.loadPreview();
      });
      const preview = button("", () => {this.previewPath = entry.metric.path; this.renderList(); void this.loadPreview();}, "metric-preview-option");
      preview.title = entry.metric.path; preview.setAttribute("aria-label", `Preview ${entry.name}`);
      preview.querySelector("span")!.append(el("strong", "", entry.name), el("small", "muted", [entry.metric.unit, isAmbiguous(entry.metric) ? "Separate reporter traces" : null].filter(Boolean).join(" · ")));
      if (entry.context) preview.querySelector("span")!.append(el("small", "metric-context muted", entry.context));
      row.append(check, preview); this.results.append(row);
    }
    if (!matching.length) this.results.append(el("p", "editor-list-note muted", "No matching metrics."));
    if (matching.length > 100) this.results.append(el("p", "editor-list-note muted", `${matching.length} matching metrics. Refine the search to see more.`));
    if (focused) [...this.results.querySelectorAll<HTMLElement>(".metric-option")].find(row => row.dataset.path === focused)?.querySelector<HTMLInputElement>("input")?.focus({preventScroll: true});
  }
  /** Discover real structured collections without fetching their complete snapshots. */
  private async loadTables(): Promise<void> {
    if (this.lifetime.signal.aborted || document.hidden) return;
    if (!this.context.runs.length) {this.previewHost.textContent = "Select runs to discover snapshot collections."; return;}
    this.catalogRequest?.abort(); const request = new AbortController(); this.catalogRequest = request;
    this.previewHost.textContent = "Discovering snapshot collections…";
    try {
      const catalog = await this.reads.tables({run_ids: this.context.runs.map(run => run.id)}, request.signal);
      if (request.signal.aborted) return;
      this.tableCatalog = catalog;
      if (this.collectionPath === null) this.collectionPath = catalog.tables[0]?.path ?? null;
      this.bindings.setCollection(catalog.tables.find(table => table.path === this.collectionPath) ?? null);
      this.renderList(); this.updateDisplay(); await this.loadPreview();
    } catch (error) {if (!request.signal.aborted) this.previewHost.textContent = errorText(error);}
  }
  /** Use catalog metadata for metric identities, retaining missing saved fields as explicit placeholders. */
  private metrics(paths: string[]): ChartMetric[] {
    return paths.map(path => this.context.catalog.metrics.find(metric => metric.path === path) ?? {path, name: humanize(path.split("/").at(-1) ?? "Metric"), group: "Saved field", unit: null, sources: [], run_ids: []});
  }
  /** Build a display-only chart record; the containing panel receives its independent identity on commit. */
  private chartSpec(paths: string[]): ChartSpec {
    return {path: paths[0] ?? "", ...(paths.length > 1 ? {paths} : {}), size: this.sizeInput.value === "wide" ? "wide" : "normal",
      ...(Object.keys(this.display).length ? {presentation: {...this.display}} : {})};
  }
  /** Construct a copied table draft with reporter and column configuration but no persisted snapshot pins. */
  private tableSpec(): TablePanelSpec {
    const existing = this.context.existing;
    const base = {id: existing?.id ?? "preview", sectionId: this.sectionInput.value, size: this.sizeInput.value === "wide" ? "wide" as const : "normal" as const,
      ...(this.titleInput.value.trim() ? {title: this.titleInput.value.trim()} : {}), ...(this.sourceIds ? {sourceIds: [...this.sourceIds]} : {}),
      ...this.tableDraft};
    const view = this.bindings.value;
    return this.mode === "metric-table" ? {...base, kind: "metric-table", paths: [...this.selection]}
      : {...base, kind: "snapshot-table", path: this.collectionPath ?? "", ...(view ? {view} : {})};
  }
  /** Retain table/visual interactions while switching renderers inside the isolated editor draft. */
  private rememberTableSettings(spec: TablePanelSpec): void {
    const copy = copyPanel(spec);
    if (copy.kind === "chart") return;
    this.tableDraft = {...(copy.columns ? {columns: copy.columns} : {}), ...(copy.query ? {query: copy.query} : {})};
    if (isSnapshotVisual(copy)) this.bindings.accept(copy.view);
  }
  /** Preview actual selected fields or current source collections, canceling obsolete reads on every selection. */
  private async loadPreview(): Promise<void> {
    if (this.lifetime.signal.aborted || document.hidden) return;
    this.request?.abort();
    if (this.mode === "section") {this.previewHost.replaceChildren(el("h3", "", this.titleInput.value.trim() || "Untitled section"), el("p", "muted", "Panels can be dragged into this group.")); return;}
    if (!this.context.runs.length) {this.previewHost.textContent = "Select runs to preview recorded data."; return;}
    if (this.mode !== "chart") {
      if (this.mode === "snapshot-table" && this.collectionPath === null || this.mode === "metric-table" && !this.selection.size) {
        this.preview?.destroy(); this.preview = null; this.previewHost.textContent = this.mode === "snapshot-table" ? "Choose a snapshot collection." : "Select metrics to preview a table."; return;
      }
      const spec = this.tableSpec();
      if (isSnapshotVisual(spec)) {
        if (this.bindings.error) {
          this.preview?.destroy(); this.preview = null; this.previewHost.textContent = this.bindings.error; this.renderSources(); return;
        }
        if (!(this.preview instanceof SnapshotVisualPanel)) {
          this.preview?.destroy();
          this.preview = new SnapshotVisualPanel(spec, this.reads, this.context.labelFor, this.context.colorFor, () => {}, "preview",
            changed => {this.rememberTableSettings(changed); this.updateDisplay();});
          this.previewHost.replaceChildren(this.preview.element);
        } else this.preview.applySpec(spec);
      } else {
        if (!(this.preview instanceof TablePanel) || this.preview.spec.kind !== spec.kind) {
          this.preview?.destroy();
          this.preview = new TablePanel(spec, this.reads, this.context.labelFor, () => {}, "preview",
            changed => {this.rememberTableSettings(changed); this.updateDisplay();});
          this.previewHost.replaceChildren(this.preview.element);
        } else this.preview.applySpec(spec);
      }
      this.preview.setContext(this.context.catalog, this.context.runs, this.context.range); this.preview.setActive(true); this.preview.refresh(false); this.renderSources(); return;
    }
    const paths = this.layoutInput.value === "combined" && this.selection.size ? [...this.selection] : this.previewPath ? [this.previewPath] : [];
    if (!paths.length) {this.previewHost.textContent = "Choose a metric to preview."; return;}
    if (paths.length > 64) {this.previewHost.textContent = "Select at most 64 metrics for one query."; return;}
    const metrics = this.metrics(paths), spec = this.chartSpec(paths);
    if (!compatibleMetrics(metrics.filter(metric => metric.sources.length))) {this.preview?.destroy(); this.preview = null; this.previewHost.textContent = "These metrics have different units. Choose Separate charts or select metrics with the same unit."; return;}
    if (!(this.preview instanceof ChartRenderer)) {
      this.preview?.destroy(); this.preview = new ChartRenderer(spec, metrics[0]!, () => {}, this.context.colorFor, this.context.labelFor, () => {void this.loadPreview();}, "preview");
      this.previewHost.replaceChildren(this.preview.element);
    } else {this.preview.setScope([]); this.preview.applySpec(spec);}
    this.preview.updateCombined(metrics, [], this.context.runs, this.context.range.axis, true);
    const available = metrics.filter(metric => metric.sources.length);
    if (!available.length) {this.preview.unavailable(this.context.runs, this.context.catalog.truncated); return;}
    const request = new AbortController(); this.request = request; this.previewHost.setAttribute("aria-busy", "true");
    try {
      const sources = [...new Set(available.flatMap(metric => this.context.runs.flatMap(run => reporters(metric, run.id).map(source => source.source_id))))];
      const result = await this.reads.query({run_ids: this.context.runs.map(run => run.id), paths: available.map(metric => metric.path),
        ...(sources.length ? {source_ids: sources} : {}), axis: this.context.range.axis, ...rangeBounds(this.context.range, this.context.catalog),
        max_points: Math.max(1, Math.min(1200, Math.floor(40_000 / Math.max(1, available.reduce((sum, metric) => sum + metric.sources.length, 0)))))}, request.signal);
      if (!request.signal.aborted && this.preview instanceof ChartRenderer) this.preview.updateCombined(metrics, result.series, this.context.runs, result.axis);
    } catch (error) {if (!request.signal.aborted && this.preview instanceof ChartRenderer) this.preview.fail(errorText(error));}
    finally {if (this.request === request) this.previewHost.setAttribute("aria-busy", "false");}
  }
  /** Select explicit table reporters using readable Run/role labels, never implicit averaging. */
  private renderSources(): void {
    const sources = this.mode === "snapshot-table" ? this.tableCatalog?.tables.find(table => table.path === this.collectionPath)?.sources ?? []
      : this.metrics([...this.selection]).flatMap(metric => metric.sources);
    const unique = [...new Map(sources.map(source => [source.source_id, source])).values()];
    this.sourceChoices.hidden = unique.length === 0;
    this.sourceChoices.replaceChildren(el("legend", "", "Reporters"));
    for (const source of unique) {
      const label = el("label"), check = el("input"); check.type = "checkbox"; check.checked = this.sourceIds === null || this.sourceIds.has(source.source_id);
      const run = this.context.runs.find(run => run.id === source.run_id);
      check.setAttribute("aria-label", `Include ${run ? this.context.labelFor(run) : source.run_id} · ${source.label}`);
      check.addEventListener("change", () => {
        if (this.sourceIds === null) this.sourceIds = new Set(unique.map(source => source.source_id));
        check.checked ? this.sourceIds.add(source.source_id) : this.sourceIds.delete(source.source_id);
        this.updateDisplay(); void this.loadPreview();
      });
      label.append(check, el("span", "", `${run ? this.context.labelFor(run) : source.run_id} · ${source.label}`)); this.sourceChoices.append(label);
    }
  }
  /** Validate typed presentation without mutating live panels or converting invalid data into a success. */
  private updateDisplay(): boolean {
    const display: ChartPresentation = {};
    if (this.titleInput.value.trim()) display.title = this.titleInput.value.trim();
    if (this.styleInput.value === "area") display.style = "area";
    const width = Number(this.widthInput.value);
    let error = "";
    if (this.mode === "chart") {
      if (!this.widthInput.value || !Number.isFinite(width) || width < .5 || width > 6) error = "Line width must be between 0.5 and 6.";
      if (width !== 1.8) display.lineWidth = width;
      if (this.pointsInput.value !== "auto") display.points = this.pointsInput.value === "show";
      if (this.legendInput.value === "show" || this.legendInput.value === "hide") display.legend = this.legendInput.value;
      for (const [input, key] of [[this.yMinInput, "yMin"], [this.yMaxInput, "yMax"]] as const) if (input.value.trim()) {
        const value = Number(input.value);
        if (!Number.isFinite(value)) error = "Y bounds must be finite numbers.";
        else display[key] = value;
      }
      if (display.yMin !== undefined && display.yMax !== undefined && display.yMin >= display.yMax) error = "Y minimum must be less than Y maximum.";
      if (this.layoutInput.value === "combined" && !compatibleMetrics(this.metrics([...this.selection]).filter(metric => metric.sources.length))) error = "Different units cannot share one scale. Choose Separate charts.";
      if (this.layoutInput.value === "separate" && this.selection.size > 1 && display.title && this.metrics([...this.selection]).some(metric => `${display.title} · ${metricName(metric)}`.length > 120)) error = "Shorten the title prefix so each chart title fits 120 characters.";
    }
    if (this.selection.size > 64) error = "Select at most 64 metrics for one query.";
    const count = this.mode === "chart" && this.layoutInput.value === "separate" ? this.selection.size : 1;
    if (this.mode !== "section" && this.context.panels.length - Number(Boolean(this.context.existing)) + count > panelLimit) error = `This workspace supports ${panelLimit} panels. Remove a panel or combine compatible fields.`;
    if (this.mode === "section" && this.context.sections.length >= sectionLimit) error = `This workspace supports ${sectionLimit} sections. Rename or remove an existing section first.`;
    if (this.sourceIds?.size === 0 && this.mode !== "chart") error = "Select at least one reporter.";
    if (this.mode === "snapshot-table" && this.bindings.error) error = this.bindings.error;
    const ready = this.mode === "section" ? this.titleInput.value.trim().length > 0 : this.mode === "snapshot-table" ? this.collectionPath !== null : this.selection.size > 0;
    this.error.textContent = error; this.primary.disabled = Boolean(error) || !ready; this.draftError = error;
    if (error) return false;
    this.display = display;
    if (this.preview instanceof ChartRenderer) this.preview.applySpec(this.chartSpec(this.layoutInput.value === "combined" && this.selection.size ? [...this.selection] : [this.previewPath]));
    else if (this.preview instanceof TablePanel) {
      const spec = this.tableSpec(); if (!isSnapshotVisual(spec)) this.preview.applySpec(spec);
    } else if (this.preview instanceof SnapshotVisualPanel) {
      const spec = this.tableSpec(); if (isSnapshotVisual(spec)) this.preview.applySpec(spec);
    }
    if (this.mode === "section") this.previewHost.replaceChildren(el("h3", "", this.titleInput.value.trim() || "Untitled section"));
    return ready;
  }
  /** Commit the checked selection, defaulting to separate independent charts with shared display settings. */
  private save(): void {
    if (!this.updateDisplay()) return;
    if (this.mode === "section") {this.commit({kind: "section", name: this.titleInput.value.trim()}); this.modal.close(); return;}
    const base = {sectionId: this.sectionInput.value, size: this.sizeInput.value === "wide" ? "wide" as const : "normal" as const};
    let panels: PanelSpec[];
    if (this.mode === "chart") {
      const groups = this.layoutInput.value === "combined" ? [[...this.selection]] : [...this.selection].map(path => [path]);
      panels = groups.map((paths, index) => {
        const chart = this.chartSpec(paths);
        if (groups.length > 1 && chart.presentation?.title) chart.presentation.title = `${chart.presentation.title} · ${metricName(this.metrics(paths)[0]!)}`;
        return {...base, ...chart, kind: "chart", id: index === 0 ? this.context.existing?.id ?? uiIdentifier("panel") : uiIdentifier("panel")};
      });
    } else panels = [{...this.tableSpec(), ...base, id: this.context.existing?.id ?? uiIdentifier("panel")}];
    this.commit({kind: "panels", panels}); this.modal.close();
  }
  /** Release every preview and request on Save, Cancel, backdrop, Escape or scope replacement. */
  destroy(): void {this.lifetime.abort(); this.request?.abort(); this.catalogRequest?.abort(); cancelAnimationFrame(this.frame); this.preview?.destroy();}
}
