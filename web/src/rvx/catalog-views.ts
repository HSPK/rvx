import type {ApiClient} from "../core/api-client";
import type {
  ExperimentRecord,
  ExperimentRun,
  ExperimentSource,
  ProjectRecord,
} from "../domain/types";
import type {WorkspaceData} from "./domain";
import {matchesRunSearch} from "./search";
import {
  commonRunParameters,
  parseRunParameters,
  type RunParameterValue,
} from "./run-parameters";
import {appendRow, denseTable, formatNs, summaryStrip} from "./ui";
import {
  VirtualTable,
  type VirtualColumn,
} from "./virtual-table";

export interface CatalogViewContext {
  api: ApiClient;
  data: WorkspaceData;
  page: {
    kind: "projects" | "project" | "experiment" | "runs" | "system";
    projectId?: string;
    experimentId?: string;
  };
  selected(runId: string): boolean;
  toggleRun(run: ExperimentRun): void;
  openProject(project: ProjectRecord): void;
  openExperiment(experiment: ExperimentRecord): void;
  openRun(run: ExperimentRun, preview: boolean): void;
  openRunMenu(
    event: MouseEvent,
    run: ExperimentRun,
    project: ProjectRecord,
    experiment: ExperimentRecord,
  ): void;
}

interface RunContext {
  run: ExperimentRun;
  project: ProjectRecord;
  experiment: ExperimentRecord;
  sources: ExperimentSource[];
  parameters: Record<string, RunParameterValue>;
}

export class CatalogViewHost {
  private virtualTable: VirtualTable<RunContext> | null = null;
  private search = "";
  private disposed = false;
  private runContexts: RunContext[] | null = null;
  private signature: string;
  private sortColumn = "";
  private sortAscending = true;

  constructor(
    readonly element: HTMLElement,
    private context: CatalogViewContext,
  ) {
    this.signature = catalogSignature(context.data);
    void this.render();
  }

  refresh(data: WorkspaceData): void {
    const signature = catalogSignature(data);
    if (this.context.page.kind === "system") {
      this.context = {...this.context, data};
      this.signature = signature;
      const counters = new Map(Object.entries(data.stats));
      this.element.querySelectorAll<HTMLElement>("[data-counter]").forEach(row => {
        const cell = row.children[1];
        if (cell) cell.textContent = String(counters.get(row.dataset.counter!) ?? "—");
      });
      const values = [
        data.stats.projects, data.stats.runs, `${data.stats.active_sources}/${data.stats.sources}`,
        data.stats.snapshots ?? 0, data.stats.ingested_points, data.stats.cursor_gaps,
      ];
      this.element.querySelectorAll(".rvx-summary-strip strong").forEach((element, index) => {
        element.textContent = String(values[index] ?? "");
      });
      return;
    }
    if (this.context.page.kind === "runs" && this.virtualTable) {
      this.context = {...this.context, data};
      this.signature = signature;
      this.runContexts = contextsForRuns(data.runs, data);
      const rows = this.runContexts.filter(item => matchesRunSearch(
        this.search, item.project, item.experiment, item.run, item.sources, item.parameters,
      ));
      const columns = runColumns(this.context, rows);
      this.virtualTable.setData(this.sortedRows(rows, columns), this.sortLabels(columns));
      const count = this.element.querySelector(".rvx-catalog-controls > span");
      if (count) count.textContent = `${rows.length.toLocaleString()} runs`;
      const values = [
        data.runs.length, activeRuns(data.runs, data.sources).length,
        data.runs.filter(run => run.status === "failed").length,
        data.runs.filter(run => this.context.selected(run.id)).length, data.sources.length,
      ];
      this.element.querySelectorAll(".rvx-summary-strip strong").forEach((element, index) => {
        element.textContent = String(values[index] ?? "");
      });
      return;
    }
    if (signature === this.signature) {
      this.context = {...this.context, data};
      return;
    }
    this.signature = signature;
    this.context = {...this.context, data};
    this.runContexts = null;
    this.element.replaceChildren();
    this.virtualTable?.destroy();
    this.virtualTable = null;
    void this.render();
  }

  destroy(): void {
    this.disposed = true;
    this.virtualTable?.destroy();
  }

  private async render(): Promise<void> {
    const kind = this.context.page.kind;
    if (kind === "projects") this.renderProjects();
    else if (kind === "project") this.renderProject();
    else if (kind === "experiment") await this.renderExperiment();
    else if (kind === "runs") this.renderRuns();
    else this.renderSystem();
  }

  private renderProjects(): void {
    const projects = this.context.data.projects;
    const registry = denseTable(["Project", "Experiments", "Runs", "Active", "Failed", "Sources", "Updated"]);
    for (const project of projects) {
      const experiments = this.context.data.experiments.filter(
        item => item.project_id === project.id,
      );
      const experimentIds = new Set(experiments.map(item => item.id));
      const runs = this.context.data.runs.filter(run =>
        experimentIds.has(run.experiment_id),
      );
      const runIds = new Set(runs.map(run => run.id));
      const sources = this.context.data.sources.filter(source =>
        runIds.has(source.run_id),
      );
      const row = appendRow(registry, [
        "", experiments.length, runs.length, activeRuns(runs, sources).length,
        runs.filter(run => run.status === "failed").length, sources.length, latestRunTime(runs, sources),
      ]);
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = project.name;
      open.addEventListener("click", () => this.context.openProject(project));
      row.cells[0]!.append(open);
    }
    this.element.append(
      pageHeader(
        "Experiment registry",
        "Projects",
        "Projects / Experiments / Runs",
      ),
      summaryStrip([
        ["Projects", projects.length],
        ["Runs", this.context.data.runs.length],
        ["Failed", this.context.data.runs.filter(run => run.status === "failed").length],
        [
          "Active",
          activeRuns(
            this.context.data.runs,
            this.context.data.sources,
          ).length,
        ],
        ["Sources", this.context.data.sources.length],
      ]),
      section("Project registry", registry),
    );
  }

  private renderProject(): void {
    const project = this.context.data.projects.find(
      item => item.id === this.context.page.projectId,
    );
    if (!project) {
      this.element.textContent = "Project is unavailable.";
      return;
    }
    this.element.append(
      pageHeader(
        "Project",
        project.name,
        "Experiments, active Runs, and source health in one operational scope.",
      ),
    );
    const experiments = this.context.data.experiments.filter(
      item => item.project_id === project.id,
    );
    const experimentIds = new Set(experiments.map(item => item.id));
    const runs = this.context.data.runs.filter(
      run => experimentIds.has(run.experiment_id),
    );
    const runIds = new Set(runs.map(run => run.id));
    const sources = this.context.data.sources.filter(source =>
      runIds.has(source.run_id),
    );
    this.element.append(
      summaryStrip([
        ["Experiments", experiments.length],
        ["Runs", runs.length],
        ["Active", activeRuns(runs, sources).length],
        ["Failed", runs.filter(run => run.status === "failed").length],
        [
          "Sources",
          `${sources.filter(source => source.state === "active").length}/${sources.length}`,
        ],
        ["Updated", latestRunTime(runs, sources)],
      ]),
    );

    const experimentTable = denseTable([
      "State",
      "Experiment",
      "Runs",
      "Active",
      "Failed",
      "Sources",
      "Updated",
    ]);
    for (const experiment of experiments) {
      const experimentRuns = runs.filter(
        run => run.experiment_id === experiment.id,
      );
      const runIds = new Set(experimentRuns.map(run => run.id));
      const experimentSources = sources.filter(source =>
        runIds.has(source.run_id),
      );
      const row = appendRow(experimentTable, [
        experimentState(experimentRuns, experimentSources),
        experiment.name,
        experimentRuns.length,
        activeRuns(experimentRuns, experimentSources).length,
        experimentRuns.filter(run => run.status === "failed").length,
        experimentSources.length,
        latestRunTime(experimentRuns, experimentSources),
      ]);
      row.addEventListener("click", () =>
        this.context.openExperiment(experiment),
      );
    }
    this.element.append(section("Experiments", experimentTable));

    const active = activeRuns(runs, sources);
    const activeTable = denseTable([
      "Run",
      "Experiment",
      "Sources",
      "Active",
      "Errors",
      "Updated",
    ]);
    for (const run of active) {
      const experiment = experiments.find(item => item.id === run.experiment_id);
      const runSources = sources.filter(source => source.run_id === run.id);
      const row = appendRow(activeTable, [
        run.name,
        experiment?.name ?? "--",
        runSources.length,
        runSources.filter(source => source.state === "active").length,
        runSources.filter(source => source.last_error).length,
        effectiveUpdated(run, runSources),
      ]);
      row.addEventListener("click", () => this.context.openRun(run, true));
    }
    this.element.append(section("Active Runs", activeTable));

    const attention = denseTable([
      "Severity",
      "Run",
      "Source",
      "Problem",
      "Updated",
    ]);
    for (const source of sources.filter(
      item => item.state !== "ended" && (item.state === "stale" || item.state === "lost" || item.last_error),
    )) {
      const run = runs.find(item => item.id === source.run_id);
      appendRow(attention, [
        source.state === "lost" ? "ERROR" : "WARN",
        run?.name ?? source.run_id,
        `${source.role}${source.rank === null ? "" : `:${source.rank}`}`,
        source.last_error ?? source.state,
        source.last_success_at_ns
          ? formatNs(source.last_success_at_ns)
          : "--",
      ]);
    }
    this.element.append(section("Attention", attention, false));
  }

  private async renderExperiment(): Promise<void> {
    const experiment = this.context.data.experiments.find(
      item => item.id === this.context.page.experimentId,
    );
    if (!experiment) {
      this.element.textContent = "Experiment is unavailable.";
      return;
    }
    const project = this.context.data.projects.find(
      item => item.id === experiment.project_id,
    );
    const runs = this.context.data.runs.filter(
      run => run.experiment_id === experiment.id,
    );
    const runIds = new Set(runs.map(run => run.id));
    const sources = this.context.data.sources.filter(source =>
      runIds.has(source.run_id),
    );
    this.element.append(
      pageHeader(
        project?.name ?? "Project",
        experiment.name,
        "Compare Runs, inspect key outcomes, and move directly into analysis.",
      ),
      summaryStrip([
        ["Project", project?.name ?? "--"],
        ["Runs", runs.length],
        ["Active", activeRuns(runs, sources).length],
        ["Finished", runs.filter(run => run.status === "finished").length],
        ["Failed", runs.filter(run => run.status === "failed").length],
        ["Sources", sources.length],
        ["Updated", latestRunTime(runs, sources)],
      ]),
    );

    const freshness = denseTable(["Source health", "Count", "Interpretation"]);
    appendRow(freshness, ["Active", sources.filter(source => source.state === "active").length, "Independent Source-local state observations"]);
    appendRow(freshness, ["Attention", sources.filter(source => source.state !== "ended" && (source.state === "stale" || source.state === "lost" || source.last_error)).length, "Stale, lost or errored operational Sources"]);
    appendRow(freshness, ["Ended", sources.filter(source => source.state === "ended").length, "Historical state remains available; not unhealthy"]);
    this.element.append(section("State freshness and data quality", freshness));
    this.element.append(
      section(
        "Runs",
        this.createRunTable(
          contextsForRuns(
            runs,
            this.context.data,
          ),
          390,
        ),
      ),
    );

    const parameters = parameterTable(runs);
    this.element.append(section("Parameters", parameters, false));

    const failures = denseTable([
      "Run",
      "Source",
      "State",
      "Reason",
      "Last success",
    ]);
    for (const source of sources.filter(item => item.state !== "ended" && (item.last_error || item.state === "stale" || item.state === "lost"))) {
      appendRow(failures, [
        runs.find(run => run.id === source.run_id)?.name ?? source.run_id,
        source.role,
        source.state,
        source.last_error ?? "--",
        source.last_success_at_ns
          ? formatNs(source.last_success_at_ns)
          : "--",
      ]);
    }
    this.element.append(section("Failures and Data Quality", failures, false));
  }

  private renderRuns(): void {
    this.element.append(
      pageHeader(
        "Global index",
        "Runs",
        "Search every experiment by state, role, node, source, or parameter.",
      ),
    );
    const controls = document.createElement("div");
    controls.className = "rvx-catalog-controls";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder =
      "status:running project:async role:learner param.seed=1";
    search.value = this.search;
    const count = document.createElement("span");
    controls.append(search, count);
    const render = (): void => {
      this.search = search.value.trim();
      const rows = (this.runContexts ?? []).filter(item =>
        matchesRunSearch(
          this.search,
          item.project,
          item.experiment,
          item.run,
          item.sources,
          item.parameters,
        ),
      );
      count.textContent = `${rows.length.toLocaleString()} runs`;
      const columns = runColumns(this.context, rows);
      this.virtualTable?.setData(this.sortedRows(rows, columns), this.sortLabels(columns));
      this.virtualTable?.scrollToTop();
    };
    search.addEventListener("input", render);
    this.element.append(controls);
    this.element.append(
      summaryStrip([
        ["Runs", this.context.data.runs.length],
        [
          "Active",
          activeRuns(
            this.context.data.runs,
            this.context.data.sources,
          ).length,
        ],
        [
          "Failed",
          this.context.data.runs.filter(run => run.status === "failed").length,
        ],
        [
          "Selected",
          this.context.data.runs.filter(run => this.context.selected(run.id))
            .length,
        ],
        ["Sources", this.context.data.sources.length],
      ]),
    );
    const tableHost = document.createElement("div");
    tableHost.className = "rvx-runs-table-host";
    this.virtualTable = new VirtualTable<RunContext>({
      rowHeight: 25,
      overscan: 10,
      onSort: column => {
        this.sortAscending = this.sortColumn === column ? !this.sortAscending : true;
        this.sortColumn = column;
        render();
      },
      onRowClick: row => this.context.openRun(row.run, true),
      onRowDoubleClick: row => this.context.openRun(row.run, false),
      onRowContextMenu: (event, row) =>
        this.context.openRunMenu(
          event,
          row.run,
          row.project,
          row.experiment,
        ),
    });
    tableHost.append(this.virtualTable.element);
    this.element.append(tableHost);
    this.runContexts = contextsForRuns(
      this.context.data.runs,
      this.context.data,
    );
    render();
  }

  private renderSystem(): void {
    const table = denseTable(["Operational counter", "Value"]);
    for (const [name, value] of Object.entries(this.context.data.stats)) {
      const legacy = ["hot_points", "wal_bytes", "parquet_files", "ingested_points", "compacted_values", "duplicate_points"].includes(name);
      const row = appendRow(table, [`${legacy ? "Legacy · " : ""}${name.replaceAll("_", " ")}`, value]);
      row.dataset.counter = name;
    }
    this.element.append(
      pageHeader(
        "Local engine",
        "System",
        "Storage, ingestion, source health, and durability counters.",
      ),
      summaryStrip([
        ["Projects", this.context.data.stats.projects],
        ["Runs", this.context.data.stats.runs],
        [
          "Sources",
          `${this.context.data.stats.active_sources}/${this.context.data.stats.sources}`,
        ],
        ["Snapshots", this.context.data.stats.snapshots ?? 0],
        ["Legacy points", this.context.data.stats.ingested_points],
        ["Gaps", this.context.data.stats.cursor_gaps],
      ]),
      section("RVX System", table),
    );
  }

  private createRunTable(rows: RunContext[], height: number): HTMLElement {
    const host = document.createElement("div");
    host.className = "rvx-runs-table-host";
    host.style.height = `${Math.min(
      height,
      Math.max(80, (rows.length + 1) * 25 + 2),
    )}px`;
    const table = new VirtualTable<RunContext>({
      rowHeight: 25,
      overscan: 8,
      onSort: column => {
        this.sortAscending = this.sortColumn === column ? !this.sortAscending : true;
        this.sortColumn = column;
        const columns = runColumns(this.context, rows);
        table.setData(this.sortedRows(rows, columns), this.sortLabels(columns));
      },
      onRowClick: row => this.context.openRun(row.run, true),
      onRowDoubleClick: row => this.context.openRun(row.run, false),
      onRowContextMenu: (event, row) =>
        this.context.openRunMenu(
          event,
          row.run,
          row.project,
          row.experiment,
        ),
    });
    table.setData(rows, runColumns(this.context, rows));
    host.append(table.element);
    this.virtualTable = table;
    return host;
  }

  private sortLabels(columns: VirtualColumn<RunContext>[]): VirtualColumn<RunContext>[] {
    return columns.map(column => column.id === this.sortColumn
      ? {...column, label: `${column.label} ${this.sortAscending ? "↑" : "↓"}`}
      : column);
  }

  private sortedRows(rows: RunContext[], columns: VirtualColumn<RunContext>[]): RunContext[] {
    const column = columns.find(column => column.id === this.sortColumn);
    if (!column) return rows;
    const direction = this.sortAscending ? 1 : -1;
    return rows.map(row => ({row, key: String(column.render(row))})).sort((a, b) => {
      const left = Number(a.key);
      const right = Number(b.key);
      return direction * (Number.isFinite(left) && Number.isFinite(right)
        ? left - right
        : a.key.localeCompare(b.key, undefined, {numeric: true}));
    }).map(item => item.row);
  }
}

function runColumns(
  context: CatalogViewContext,
  rows: RunContext[],
): VirtualColumn<RunContext>[] {
  const parameterNames = commonRunParameters(
    rows.map(row => row.parameters),
  ).filter(isVisibleParameter).slice(0, 3);
  return [
    {
      id: "select",
      label: "",
      width: "28px",
      render: row => {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = context.selected(row.run.id);
        checkbox.ariaLabel = `Select ${row.run.name}`;
        checkbox.addEventListener("click", event => event.stopPropagation());
        checkbox.addEventListener("change", () => context.toggleRun(row.run));
        return checkbox;
      },
    },
    {
      id: "state",
      label: "State",
      width: "78px",
      render: row => row.run.status,
    },
    {id: "run", label: "Run", width: "minmax(180px, 1fr)", render: row => row.run.name},
    {id: "project", label: "Project", width: "130px", render: row => row.project.name},
    {
      id: "experiment",
      label: "Experiment",
      width: "170px",
      render: row => row.experiment.name,
    },
    {
      id: "sources",
      label: "Sources",
      width: "72px",
      render: row => String(row.sources.length),
    },
    {
      id: "active",
      label: "Active",
      width: "68px",
      render: row => String(row.sources.filter(source => source.state === "active").length),
    },
    {
      id: "errors",
      label: "Errors",
      width: "68px",
      render: row => String(row.sources.filter(source => source.last_error).length),
    },
    ...parameterNames.map<VirtualColumn<RunContext>>(name => ({
      id: `param-${name}`,
      label: name,
      width: "100px",
      render: row => String(row.parameters[name] ?? "--"),
    })),
    {
      id: "updated",
      label: "Updated",
      width: "150px",
      render: row => effectiveUpdated(row.run, row.sources),
    },
  ];
}

function contextsForRuns(
  runs: ExperimentRun[],
  data: WorkspaceData,
): RunContext[] {
  const experiments = new Map(data.experiments.map(item => [item.id, item]));
  const projects = new Map(data.projects.map(item => [item.id, item]));
  const sources = new Map<string, ExperimentSource[]>();
  for (const source of data.sources) {
    const entries = sources.get(source.run_id) ?? [];
    entries.push(source);
    sources.set(source.run_id, entries);
  }
  return runs.flatMap(run => {
    const experiment = experiments.get(run.experiment_id);
    const project = experiment ? projects.get(experiment.project_id) : undefined;
    if (!experiment || !project) return [];
    return [{
      run,
      project,
      experiment,
      sources: sources.get(run.id) ?? [],
      parameters: parseRunParameters(run.config_json),
    }];
  });
}

function activeRuns(
  runs: ExperimentRun[],
  sources: ExperimentSource[],
): ExperimentRun[] {
  const active = new Set(
    sources
      .filter(source => source.state === "active")
      .map(source => source.run_id),
  );
  return runs.filter(run => run.status === "running" || active.has(run.id));
}

function experimentState(
  runs: ExperimentRun[],
  sources: ExperimentSource[],
): string {
  if (runs.some(run => run.status === "failed")) return "WARN";
  if (activeRuns(runs, sources).length) return "RUNNING";
  return "IDLE";
}

function latestRunTime(
  runs: ExperimentRun[],
  sources: ExperimentSource[] = [],
): string {
  const latest = Math.max(
    0,
    ...runs.map(run => run.updated_at_ns),
    ...sources.map(source => source.last_success_at_ns ?? 0),
  );
  return latest ? formatNs(latest) : "--";
}

function effectiveUpdated(
  run: ExperimentRun,
  sources: ExperimentSource[],
): string {
  const latest = Math.max(
    run.updated_at_ns,
    ...sources.map(source => source.last_success_at_ns ?? 0),
  );
  return formatNs(latest);
}

function parameterTable(runs: ExperimentRun[]): HTMLElement {
  const parameters = runs.map(run => parseRunParameters(run.config_json));
  const names = commonRunParameters(parameters).filter(isVisibleParameter);
  const table = denseTable(["Parameter", "Values", "Runs"]);
  for (const name of names) {
    const values = parameters
      .map(parameters => parameters[name])
      .filter(value => value !== undefined);
    appendRow(table, [
      name,
      [...new Set(values.map(String))].join(", "),
      values.length,
    ]);
  }
  return table;
}

function isVisibleParameter(name: string): boolean {
  return ![
    "source",
    "migrated_at",
    "monitor.",
    "collectors.",
    "history.",
    "prometheus.",
    "alerts.",
  ].some(prefix => name === prefix || name.startsWith(prefix));
}

function section(
  title: string,
  content: HTMLElement,
  open = true,
): HTMLElement {
  const root = document.createElement("details");
  root.className = "rvx-catalog-section";
  root.open = open;
  const summary = document.createElement("summary");
  summary.textContent = title;
  const body = document.createElement("div");
  body.className = "rvx-catalog-section-body";
  body.append(content);
  root.append(summary, body);
  return root;
}

/** Creates the identity header shared by Browser pages. */
function pageHeader(
  eyebrow: string,
  title: string,
  description: string,
): HTMLElement {
  const header = document.createElement("header");
  header.className = "rvx-page-heading";
  const label = document.createElement("span");
  label.textContent = eyebrow;
  const heading = document.createElement("h1");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = description;
  header.append(label, heading, copy);
  return header;
}

function catalogSignature(data: WorkspaceData): string {
  const latestRun = Math.max(0, ...data.runs.map(run => run.updated_at_ns));
  const sourceState = data.sources.reduce(
    (value, source) =>
      value +
      source.state.charCodeAt(0) +
      Number(Boolean(source.last_error)),
    0,
  );
  return [
    data.projects.length,
    data.experiments.length,
    data.runs.length,
    latestRun,
    data.sources.length,
    sourceState,
  ].join(":");
}
