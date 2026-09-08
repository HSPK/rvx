import type {ExperimentRecord, ExperimentRun, ProjectRecord} from "../domain/types";
import {filteredRuns, humanize, type RunFilters} from "./model";
import {el, icon, iconButton, message, select} from "./ui";

export interface RunMetadata {projects: ProjectRecord[]; experiments: ExperimentRecord[]; runs: ExperimentRun[]}
const rowHeight = 44;

/** One virtual selector is moved between the desktop rail and the mobile sheet. */
export class Runs {
  readonly element = el("section", "runs-selector");
  private viewport = el("div", "run-viewport");
  private rows = el("div", "run-rows");
  private count = el("span", "muted run-count");
  private selectionCount = el("span", "selection-count sr-only");
  private limit = el("p", "selection-limit sr-only");
  private search = el("input");
  private projectSelect: HTMLSelectElement;
  private experimentSelect: HTMLSelectElement;
  private statusSelect: HTMLSelectElement;
  private refreshButton: HTMLButtonElement;
  private refreshState = el("span", "refresh-state muted", "Refreshing…");
  private selected = new Set<string>();
  private filtered: ExperimentRun[] = [];
  private frame = 0;
  private key = "";
  private active = true;
  private disposed = false;
  private resize: ResizeObserver;

  /** Bind selection directly to shared analysis state, never to a navigation action. */
  constructor(private metadata: RunMetadata, private filters: RunFilters, private colorFor: (id: string) => string, private labelFor: (run: ExperimentRun) => string,
    private toggle: (id: string) => void, private changeFilters: (filters: RunFilters, replace: boolean) => void, refresh: () => void,
    private openDetails: (id: string) => void) {
    this.element.setAttribute("aria-label", "Run selector");
    this.element.style.setProperty("--run-row-height", `${rowHeight}px`);
    this.refreshButton = iconButton("Refresh runs", "refresh", refresh);
    this.refreshState.classList.add("sr-only"); this.refreshState.setAttribute("role", "status");
    this.count.classList.add("sr-only");
    const filterBar = el("div", "run-filters");
    const searchBox = el("label", "search-box");
    this.search.type = "search"; this.search.placeholder = "Find a run…"; this.search.setAttribute("aria-label", "Search runs");
    this.search.addEventListener("input", () => this.changeFilters({...this.filters, search: this.search.value}, true));
    searchBox.append(icon("search"), this.search);
    this.projectSelect = select("Project", [], "", value => this.changeFilters({...this.filters, project: value, experiment: ""}, false));
    this.experimentSelect = select("Experiment", [], "", value => this.changeFilters({...this.filters, experiment: value}, false));
    this.statusSelect = select("Status", [["", "Any status"], ...["running", "finished", "failed", "created", "cancelled"].map(value => [value, humanize(value)] as [string, string])], "", value => this.changeFilters({...this.filters, status: value}, false));
    this.statusSelect.classList.add("run-status-filter");
    const searchRow = el("div", "run-search-row"); searchRow.append(searchBox, this.statusSelect, this.refreshButton);
    filterBar.append(searchRow, this.projectSelect, this.experimentSelect);
    this.selectionCount.setAttribute("role", "status");
    this.limit.textContent = "Up to 4 runs keeps overlaid curves readable."; this.limit.hidden = true;
    this.viewport.tabIndex = 0; this.viewport.setAttribute("aria-label", "Scrollable run list");
    this.viewport.append(this.rows);
    this.viewport.addEventListener("scroll", () => {
      if (!this.frame && this.active) this.frame = requestAnimationFrame(() => {this.frame = 0; this.renderRows();});
    }, {passive: true});
    this.element.append(filterBar, this.count, this.refreshState, this.selectionCount, this.limit, this.viewport);
    this.resize = new ResizeObserver(() => {
      if (!this.active) return;
      this.element.style.setProperty("--rail-gutter", `${this.viewport.offsetWidth - this.viewport.clientWidth}px`);
      this.renderRows();
    });
    this.resize.observe(this.viewport);
    this.update(metadata, [], filters);
  }

  /** Refresh names, filters, and selected colors without recreating the chart workspace. */
  update(metadata: RunMetadata, ids: string[], filters: RunFilters): void {
    const changedFilters = JSON.stringify(this.filters) !== JSON.stringify(filters);
    const changedMetadata = this.metadata !== metadata || !this.projectSelect.options.length;
    this.metadata = metadata; this.filters = {...filters}; this.selected = new Set(ids);
    if (changedMetadata || changedFilters) {
      this.projectSelect.options.length = 0;
      for (const option of [new Option("Projects", ""), ...metadata.projects.map(project => new Option(project.name, project.id))]) this.projectSelect.add(option);
      this.experimentSelect.options.length = 0;
      for (const option of [new Option("Experiments", ""), ...metadata.experiments.filter(experiment => !filters.project || experiment.project_id === filters.project).map(experiment => new Option(experiment.name, experiment.id))]) this.experimentSelect.add(option);
      this.filtered = filteredRuns(metadata.runs, metadata.experiments, filters);
      this.count.textContent = this.filtered.length.toLocaleString();
      this.count.dataset.unit = this.filtered.length === 1 ? " run" : " runs";
      this.element.dataset.runCount = String(this.filtered.length);
      this.viewport.style.setProperty("--run-list-height", `${Math.min(this.filtered.length, 8) * rowHeight}px`);
      if (changedFilters) this.viewport.scrollTop = 0;
    }
    this.search.value = filters.search;
    for (const [control, value, label] of [
      [this.projectSelect, filters.project, "Unavailable project"], [this.experimentSelect, filters.experiment, "Unavailable experiment"], [this.statusSelect, filters.status, "Unknown status"],
    ] as const) {
      if (value && ![...control.options].some(option => option.value === value)) control.add(new Option(label, value));
      control.value = value;
    }
    this.statusSelect.classList.toggle("is-filtered", Boolean(filters.status));
    this.statusSelect.title = `Status: ${filters.status ? humanize(filters.status) : "Any"}`;
    const matching = new Set(this.filtered.map(run => run.id));
    const outside = ids.filter(id => !matching.has(id)).length;
    this.selectionCount.textContent = `${ids.length} selected${outside ? ` · ${outside} outside filters` : ""}`;
    this.limit.hidden = ids.length < 4;
    this.key = ""; this.renderRows();
  }

  /** Stop hidden selector rendering while retaining one shared DOM instance and filter state. */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) {cancelAnimationFrame(this.frame); this.frame = 0;}
    else {this.key = ""; this.renderRows();}
  }

  /** Bring keyboard focus to selection without changing any existing traces. */
  focus(): void {this.search.focus();}

  /** Show metadata refresh progress without clearing the selected runs or chart surface. */
  setRefreshing(value: boolean): void {
    this.refreshButton.disabled = value; this.refreshState.textContent = value ? "Refreshing runs…" : "";
    this.refreshButton.setAttribute("aria-busy", String(value));
    this.search.placeholder = value ? "Refreshing runs…" : "Find a run…";
    this.refreshButton.title = value ? "Refreshing runs…" : "Refresh runs";
    this.element.setAttribute("aria-busy", String(value));
  }

  /** Keep 10,000-run scopes bounded to a small visible window of checkbox labels. */
  private renderRows(): void {
    if (!this.active || this.disposed) return;
    if (!this.filtered.length) {
      this.rows.style.height = "";
      this.rows.replaceChildren(message(this.metadata.runs.length ? "No matching runs" : "No runs yet", this.metadata.runs.length ? "Change a filter to find another run. Your selection is unchanged." : "Registered runs will appear here."));
      return;
    }
    const height = rowHeight;
    const start = Math.max(0, Math.floor(this.viewport.scrollTop / height) - 3);
    const count = Math.min(32, Math.ceil((this.viewport.clientHeight || 500) / height) + 6);
    const visible = this.filtered.slice(start, start + count);
    const key = visible.map(run => run.id).join("\0");
    if (key === this.key) return;
    this.key = key;
    const experimentNames = new Map(this.metadata.experiments.map(experiment => [experiment.id, experiment.name]));
    const focusedRun = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".run-row")?.dataset.runId;
    const focusedDetails = document.activeElement?.classList.contains("run-detail-button");
    this.rows.style.height = `${this.filtered.length * height}px`;
    this.rows.replaceChildren(...visible.map((run, index) => {
      const name = this.labelFor(run);
      const row = el("div", `run-row${this.selected.has(run.id) ? " selected" : ""}`), choice = el("label", "run-choice");
      row.dataset.runId = run.id; row.title = `${name} · ${humanize(run.status)}${name === run.name ? ` · ${experimentNames.get(run.experiment_id) ?? "Experiment unavailable"}` : ""}`;
      row.style.transform = `translateY(${(start + index) * height}px)`;
      row.style.setProperty("--run-color", this.colorFor(run.id));
      const check = el("input", "run-checkbox");
      check.type = "checkbox"; check.checked = this.selected.has(run.id); check.disabled = this.selected.size >= 4 && !check.checked;
      check.setAttribute("aria-label", `Select ${name}`);
      check.addEventListener("change", () => this.toggle(run.id));
      const label = el("span", "run-name");
      label.append(el("strong", "", name));
      const status = el("span", `run-status status-${run.status}`);
      status.setAttribute("role", "img"); status.setAttribute("aria-label", humanize(run.status)); status.title = humanize(run.status);
      choice.append(check, status, label);
      const details = iconButton(`Run details for ${name}`, "info", () => this.openDetails(run.id));
      details.classList.add("run-detail-button"); details.dataset.runDetails = run.id;
      row.append(choice, details);
      return row;
    }));
    if (focusedRun) {
      const row = [...this.rows.querySelectorAll<HTMLElement>(".run-row")].find(row => row.dataset.runId === focusedRun);
      row?.querySelector<HTMLElement>(focusedDetails ? ".run-detail-button" : "input")?.focus({preventScroll: true});
    }
  }

  /** Release observers and pending frames when the application leaves the analysis route. */
  destroy(): void {this.disposed = true; this.resize.disconnect(); cancelAnimationFrame(this.frame);}
}
