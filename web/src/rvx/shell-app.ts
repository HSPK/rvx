import type {
  ExperimentRecord,
  ExperimentRun,
  ExperimentSource,
  ProjectRecord,
} from "../domain/types";
import {CatalogViewHost} from "./catalog-views";
import {readBrowserStorage, type BrowserStorageKey} from "./browser-storage";
import {CatalogStore} from "./catalog-store";
import {ContextMenu} from "./context-menu";
import type {
  ViewDefinition,
  WorkspaceData,
  WorkspacePane,
  WorkspaceTab,
} from "./domain";
import {
  type BrowserRoute,
  RouterStore,
  type RvxRoute,
} from "./router-store";
import {QueryStore, SnapshotStore} from "./query-store";
import {matchesRunSearch} from "./search";
import {
  BrowserWorkspacePersistence,
  WorkspaceStore,
} from "./workspace-store";
import {ViewHost} from "./views";

const CONTEXT_RUN_LIMIT = 100;

export class RvxAppShell {
  private readonly router = new RouterStore();
  private readonly catalog = new CatalogStore();
  private readonly queries = new QueryStore(this.catalog.api);
  private readonly snapshots = new SnapshotStore(this.catalog.api);
  private readonly workspace = new WorkspaceStore(
    new BrowserWorkspacePersistence(),
  );
  private readonly menu = new ContextMenu();
  private readonly selectedRunIds = new Set<string>();
  private readonly root: HTMLElement;
  private shell!: HTMLElement;
  private rail!: HTMLElement;
  private contextBrowser!: HTMLElement;
  private mobileContextToggle!: HTMLButtonElement;
  private main!: HTMLElement;
  private status!: HTMLElement;
  private contextPath!: HTMLElement;
  private contextSearch!: HTMLInputElement;
  private axis!: HTMLSelectElement;
  private catalogHost: CatalogViewHost | null = null;
  private catalogKey = "";
  private readonly viewHosts = new Map<string, ViewHost>();
  private refreshTimer: number | null = null;
  private contextFilter = "";
  private contextWidth = storedNumber("rvx.layout.context", 230);
  private splitPercent = storedNumber("rvx.layout.split", 50);
  private navigatorSignature = "";

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
    document.title = "RVX";
    this.buildShell();
    this.bindKeyboard();
    await this.catalog.refresh().catch(() => undefined);
    this.render();
    this.router.subscribe(() => {
      this.setMobileContextOpen(false);
      this.contextFilter = "";
      this.contextSearch.value = "";
      this.render();
    });
    this.catalog.subscribe(() => this.renderCatalogUpdate());
    this.workspace.subscribe(() => {
      if (this.router.snapshot().mode === "workspace") this.renderWorkspace();
    });
    this.refreshTimer = window.setInterval(
      () => void this.catalog.refresh().catch(() => undefined),
      5_000,
    );
    window.addEventListener("beforeunload", () => this.destroy(), {once: true});
  }

  destroy(): void {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.catalogHost?.destroy();
    for (const host of this.viewHosts.values()) host.destroy();
    this.queries.clear();
    this.snapshots.clear();
    this.menu.close();
  }

  private buildShell(): void {
    this.shell = document.createElement("div");
    this.shell.className = "rvx-app-shell";
    this.shell.style.setProperty("--rvx-context-width", `${this.contextWidth}px`);
    this.shell.style.setProperty("--rvx-split", `${this.splitPercent}%`);

    const header = document.createElement("header");
    header.className = "rvx-context-bar";
    const brand = document.createElement("strong");
    brand.className = "rvx-brand";
    brand.textContent = "RVX";
    this.mobileContextToggle = document.createElement("button");
    this.mobileContextToggle.type = "button";
    this.mobileContextToggle.className = "rvx-mobile-context-toggle";
    this.mobileContextToggle.textContent = "Views";
    this.mobileContextToggle.setAttribute("aria-controls", "rvx-context-browser");
    this.mobileContextToggle.setAttribute("aria-expanded", "false");
    this.mobileContextToggle.addEventListener("click", () =>
      this.setMobileContextOpen(
        !this.shell.classList.contains("rvx-context-open"),
      ),
    );
    this.contextPath = document.createElement("div");
    this.contextPath.className = "rvx-context-path";
    this.contextSearch = document.createElement("input");
    this.contextSearch.type = "search";
    this.contextSearch.className = "rvx-search";
    this.contextSearch.addEventListener("input", () => {
      this.contextFilter = this.contextSearch.value.trim().toLowerCase();
      this.renderContextBrowser();
    });
    this.axis = document.createElement("select");
    this.axis.ariaLabel = "Projection axis";
    for (const value of [
      "wall_time",
      "optimizer_step",
      "env_step",
      "tokens",
      "policy_version",
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value.replaceAll("_", " ");
      this.axis.append(option);
    }
    this.axis.addEventListener("change", () => {
      const tab = this.workspace.activeTab();
      if (tab) this.workspace.updateState(tab.id, {axis: this.axis.value});
    });
    header.append(
      brand,
      this.mobileContextToggle,
      this.contextPath,
      this.contextSearch,
      this.axis,
    );

    this.rail = document.createElement("nav");
    this.rail.className = "rvx-global-rail";
    this.rail.setAttribute("aria-label", "RVX navigation");
    this.contextBrowser = document.createElement("aside");
    this.contextBrowser.className = "rvx-context-browser";
    this.contextBrowser.id = "rvx-context-browser";
    this.contextBrowser.addEventListener("click", event => {
      if ((event.target as Element).closest("button")) {
        this.setMobileContextOpen(false);
      }
    });
    this.main = document.createElement("main");
    this.main.className = "rvx-main";
    this.status = document.createElement("footer");
    this.status.className = "rvx-statusbar";
    const resizer = document.createElement("div");
    resizer.className = "rvx-context-resizer";
    this.bindContextResizer(resizer);
    const contextScrim = document.createElement("button");
    contextScrim.type = "button";
    contextScrim.className = "rvx-context-scrim";
    contextScrim.ariaLabel = "Close Views";
    contextScrim.addEventListener("click", () =>
      this.setMobileContextOpen(false),
    );
    this.shell.append(
      header,
      this.rail,
      this.contextBrowser,
      this.main,
      this.status,
      resizer,
      contextScrim,
    );
    this.root.replaceChildren(this.shell);
  }

  /** Opens or closes the narrow-screen Context Browser drawer. */
  private setMobileContextOpen(open: boolean): void {
    this.shell.classList.toggle("rvx-context-open", open);
    this.mobileContextToggle.setAttribute("aria-expanded", String(open));
  }

  private render(): void {
    const route = this.router.snapshot();
    this.shell.dataset.mode = route.mode;
    this.shell.dataset.page = route.mode === "browser"
      ? route.page
      : "workspace";
    this.renderRail(route);
    this.renderContextBrowser();
    this.renderHeader(route);
    this.renderStatus();
    if (route.mode === "browser") this.renderBrowser(route);
    else {
      this.ensureWorkspace(route.runIds);
      this.renderWorkspace();
    }
  }

  private renderCatalogUpdate(): void {
    const route = this.router.snapshot();
    this.renderRail(route);
    this.renderContextBrowser();
    this.renderHeader(route);
    this.renderStatus();
    if (route.mode === "browser") {
      this.renderBrowser(route);
      return;
    }
    if (!this.viewHosts.size) {
      this.renderWorkspace();
      return;
    }
    const data = this.catalog.snapshot();
    for (const pane of ["primary", "secondary"] as const) {
      const tab = this.workspace.activeTab(pane);
      if (tab) this.viewHosts.get(tab.id)?.refresh(data);
    }
  }

  private renderRail(route: RvxRoute): void {
    const page = route.mode === "browser" ? route.page : null;
    const key = page === "projects" || page === "project" || page === "experiment" ? "projects" : page ?? "workspace";
    if (this.rail.dataset.page === key) return;
    this.rail.dataset.page = key;
    this.rail.replaceChildren(
      railButton("Projects", page === "projects" || page === "project" || page === "experiment", () =>
        this.router.navigate({mode: "browser", page: "projects"}),
      ),
      railButton("Runs", page === "runs", () =>
        this.router.navigate({mode: "browser", page: "runs"}),
      ),
      railButton("System", page === "system", () =>
        this.router.navigate({mode: "browser", page: "system"}),
      ),
    );
  }

  private renderContextBrowser(): void {
    const route = this.router.snapshot();
    const data = this.catalog.snapshot();
    const signature = JSON.stringify([
      route, this.contextFilter, [...this.selectedRunIds],
      data.projects.map(project => [project.id, project.name]),
      data.experiments.map(experiment => [experiment.id, experiment.name]),
      data.runs.map(run => [run.id, run.name, run.status]),
      data.sources.map(source => [source.id, source.role, source.state, source.node_id, source.source_session_id]),
    ]);
    if (signature === this.navigatorSignature) return;
    this.navigatorSignature = signature;
    const header = document.createElement("header");
    const title = document.createElement("strong");
    const back = document.createElement("button");
    back.type = "button";
    back.className = "rvx-context-back";
    const list = document.createElement("div");
    list.className = "rvx-context-list";

    if (route.mode === "workspace") {
      title.textContent = route.runIds.length > 1
        ? `${route.runIds.length} Runs`
        : data.runs.find(run => run.id === route.runIds[0])?.name ?? "Workspace";
      back.textContent = "← Back";
      back.addEventListener("click", () => this.router.leaveWorkspace());
      header.append(back, title);
      this.contextSearch.placeholder = "Filter workspace views";
      for (const item of workspaceItems(data, route.runIds)) {
        if (
          this.contextFilter &&
          !item.label.toLowerCase().includes(this.contextFilter)
        ) {
          continue;
        }
        const entry = contextButton(item.label, () => this.activateWorkspaceView(item.view));
        entry.dataset.viewKind = item.view.kind;
        list.append(entry);
      }
    } else if (route.page === "projects") {
      title.textContent = "Projects";
      header.append(title);
      this.contextSearch.placeholder = "Search projects";
      for (const project of data.projects.filter(project =>
        project.name.toLowerCase().includes(this.contextFilter),
      )) {
        list.append(contextButton(project.name, () =>
          this.router.navigate({
            mode: "browser",
            page: "project",
            projectId: project.id,
          }),
        ));
      }
    } else if (route.page === "project") {
      const project = data.projects.find(item => item.id === route.projectId);
      title.textContent = project?.name ?? "Project";
      back.textContent = "← Projects";
      back.addEventListener("click", () =>
        this.router.navigate({mode: "browser", page: "projects"}),
      );
      header.append(back, title);
      this.contextSearch.placeholder = "Search experiments";
      for (const experiment of data.experiments.filter(
        item =>
          item.project_id === route.projectId &&
          item.name.toLowerCase().includes(this.contextFilter),
      )) {
        list.append(contextButton(experiment.name, () =>
          this.router.navigate({
            mode: "browser",
            page: "experiment",
            projectId: experiment.project_id,
            experimentId: experiment.id,
          }),
        ));
      }
    } else if (route.page === "experiment") {
      const project = data.projects.find(item => item.id === route.projectId);
      const experiment = data.experiments.find(
        item => item.id === route.experimentId,
      );
      title.textContent = experiment?.name ?? "Experiment";
      back.textContent = `← ${project?.name ?? "Project"}`;
      back.addEventListener("click", () =>
        this.router.navigate({
          mode: "browser",
          page: "project",
          ...(route.projectId ? {projectId: route.projectId} : {}),
        }),
      );
      header.append(back, title);
      this.contextSearch.placeholder =
        "Search Runs or status:running role:learner";
      const runs = data.runs
        .filter(run => run.experiment_id === route.experimentId)
        .filter(run =>
          matchesRunSearch(
            this.contextFilter,
            project ?? emptyProject(),
            experiment ?? emptyExperiment(),
            run,
            data.sources.filter(source => source.run_id === run.id),
          ),
        );
      for (const run of runs.slice(0, CONTEXT_RUN_LIMIT)) {
        list.append(this.contextRun(run, project, experiment));
      }
      if (runs.length > CONTEXT_RUN_LIMIT) {
        list.append(contextButton(
          `+${(runs.length - CONTEXT_RUN_LIMIT).toLocaleString()} more Runs`,
          () => this.router.navigate({mode: "browser", page: "runs"}),
        ));
      }
    } else if (route.page === "runs") {
      title.textContent = "Runs";
      header.append(title);
      this.contextSearch.placeholder = "Filter Projects";
      for (const project of data.projects.filter(project =>
        project.name.toLowerCase().includes(this.contextFilter),
      )) {
        list.append(contextButton(project.name, () =>
          this.router.navigate({
            mode: "browser",
            page: "project",
            projectId: project.id,
          }),
        ));
      }
    } else {
      title.textContent = "System";
      header.append(title);
      this.contextSearch.placeholder = "Search system metrics";
    }
    this.contextBrowser.replaceChildren(header, list);
  }

  private renderBrowser(route: BrowserRoute): void {
    for (const host of this.viewHosts.values()) host.destroy();
    this.viewHosts.clear();
    const key = [
      route.page,
      route.projectId ?? "",
      route.experimentId ?? "",
    ].join(":");
    const context = this.catalogContext(route);
    if (this.catalogHost && this.catalogKey === key) {
      this.catalogHost.refresh(this.catalog.snapshot());
      return;
    }
    this.catalogHost?.destroy();
    this.catalogKey = key;
    const root = document.createElement("section");
    root.className = "rvx-browser-page";
    this.main.replaceChildren(root);
    this.catalogHost = new CatalogViewHost(root, context);
  }

  private renderWorkspace(): void {
    this.catalogHost?.destroy();
    this.catalogHost = null;
    this.catalogKey = "";
    const state = this.workspace.snapshot();
    const activeKind = this.workspace.activeTab()?.view.kind;
    for (const entry of this.contextBrowser.querySelectorAll<HTMLElement>("[data-view-kind]")) {
      entry.classList.toggle("active", entry.dataset.viewKind === activeKind);
    }
    const valid = new Set(state.tabs.map(tab => tab.id));
    for (const [id, host] of this.viewHosts) {
      if (!valid.has(id)) {
        host.destroy();
        this.viewHosts.delete(id);
      }
    }
    const container = document.createElement("div");
    container.className = "rvx-panes";
    container.dataset.focusedPane = state.focusedPane;
    container.classList.toggle("rvx-panes-split", state.secondaryVisible);
    const children: HTMLElement[] = [this.renderPane("primary")];
    if (state.secondaryVisible) {
      const resizer = document.createElement("div");
      resizer.className = "rvx-split-resizer";
      this.bindSplitResizer(resizer);
      children.push(resizer, this.renderPane("secondary"));
    }
    container.append(...children);
    this.main.replaceChildren(container);
  }

  private renderPane(pane: WorkspacePane): HTMLElement {
    const root = document.createElement("section");
    root.className = "rvx-pane";
    root.dataset.pane = pane;
    const tabbar = document.createElement("div");
    tabbar.className = "rvx-tabbar";
    const tabs = this.workspace.snapshot().tabs.filter(tab => tab.pane === pane);
    const active = this.workspace.activeTab(pane);
    for (const tab of tabs) tabbar.append(this.renderTab(tab, active?.id === tab.id));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "rvx-add-view";
    add.textContent = "+";
    add.title = "New workspace view";
    add.addEventListener("click", event => this.openViewMenu(event, pane));
    tabbar.append(add);
    let viewRoot: HTMLElement = document.createElement("div");
    viewRoot.className = "rvx-view";
    if (active) {
      let existing = this.viewHosts.get(active.id);
      if (existing && !existing.matchesTab(active)) {
        existing.destroy();
        this.viewHosts.delete(active.id);
        existing = undefined;
      }
      if (existing) {
        viewRoot = existing.element;
        existing.updateTab(active);
      } else {
        const host = new ViewHost(viewRoot, this.viewContext(active));
        this.viewHosts.set(active.id, host);
      }
      if (this.workspace.snapshot().focusedPane === pane) this.axis.value = active.state.axis;
    } else {
      viewRoot.classList.add("rvx-view-empty");
      viewRoot.textContent = "Choose a workspace view.";
    }
    root.append(tabbar, viewRoot);
    return root;
  }

  private renderTab(tab: WorkspaceTab, active: boolean): HTMLElement {
    const root = document.createElement("div");
    root.className = "rvx-tab";
    root.classList.toggle("active", active);
    root.classList.toggle("preview", tab.preview);
    const title = document.createElement("button");
    title.type = "button";
    title.textContent = tab.title;
    title.addEventListener("click", () => this.workspace.activate(tab.id));
    title.addEventListener("dblclick", () => this.workspace.pin(tab.id));
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Close view";
    close.addEventListener("click", () => this.workspace.close(tab.id));
    root.addEventListener("contextmenu", event => {
      event.preventDefault();
      this.menu.open(event, [
        ...(tab.preview
          ? [{label: "Pin view", action: () => this.workspace.pin(tab.id)}]
          : []),
        {label: "Duplicate view", action: () => this.workspace.duplicate(tab.id)},
        {
          label: tab.pane === "primary"
            ? "Move to second pane"
            : "Move to first pane",
          action: () => this.workspace.move(
            tab.id,
            tab.pane === "primary" ? "secondary" : "primary",
          ),
        },
        {separator: true},
        {label: "Close view", action: () => this.workspace.close(tab.id)},
      ]);
    });
    root.append(title, close);
    return root;
  }

  private renderHeader(route: RvxRoute): void {
    const data = this.catalog.snapshot();
    if (route.mode === "workspace") {
      const runs = route.runIds
        .map(id => data.runs.find(run => run.id === id)?.name)
        .filter(Boolean);
      this.contextPath.textContent =
        `Workspace / ${runs.join(", ") || "Run"}`;
      this.axis.hidden = false;
    } else {
      const project = data.projects.find(item => item.id === route.projectId);
      const experiment = data.experiments.find(
        item => item.id === route.experimentId,
      );
      this.contextPath.textContent = [
        browserPageLabel(route.page),
        project?.name,
        experiment?.name,
      ].filter(Boolean).join(" / ");
      this.axis.hidden = true;
    }
  }

  private renderStatus(): void {
    const stats = this.catalog.snapshot().stats;
    const connection = document.createElement("span");
    connection.className = "rvx-status-dot";
    connection.dataset.state = this.catalog.error ? "offline" : "live";
    this.status.replaceChildren(
      connection,
      statusItem("Projects", stats.projects),
      statusItem("Runs", stats.runs),
      statusItem("Sources", `${stats.active_sources}/${stats.sources}`),
      statusItem("Snapshots", (stats.snapshots ?? 0).toLocaleString()),
      statusItem("Storage", "snapshot store"),
      statusItem("Legacy points", stats.ingested_points.toLocaleString()),
      statusItem("Legacy WAL", formatBytes(stats.wal_bytes)),
      statusItem("Gaps", stats.cursor_gaps),
      statusItem("Failures", stats.scrape_failures),
    );
  }

  private catalogContext(route: BrowserRoute) {
    const data = this.catalog.snapshot();
    return {
      api: this.catalog.api,
      data,
      page: {
        kind: route.page === "projects" ? "projects" as const
          : route.page === "project" ? "project" as const
            : route.page === "experiment" ? "experiment" as const
              : route.page === "runs" ? "runs" as const
                : "system" as const,
        ...(route.projectId ? {projectId: route.projectId} : {}),
        ...(route.experimentId ? {experimentId: route.experimentId} : {}),
      },
      selected: (runId: string) => this.selectedRunIds.has(runId),
      toggleRun: (run: ExperimentRun) => this.toggleRun(run),
      openProject: (project: ProjectRecord) =>
        this.router.navigate({
          mode: "browser",
          page: "project",
          projectId: project.id,
        }),
      openExperiment: (experiment: ExperimentRecord) =>
        this.router.navigate({
          mode: "browser",
          page: "experiment",
          projectId: experiment.project_id,
          experimentId: experiment.id,
        }),
      openRun: (run: ExperimentRun, preview: boolean) => {
        if (preview) this.selectOnly(run);
        else this.enterRunWorkspace(run);
      },
      openRunMenu: (
        event: MouseEvent,
        run: ExperimentRun,
        project: ProjectRecord,
        experiment: ExperimentRecord,
      ) => this.openRunMenu(event, run, project, experiment),
    };
  }

  private viewContext(tab: WorkspaceTab) {
    const data = this.catalog.snapshot();
    return {
      api: this.catalog.api,
      queries: this.queries,
      snapshots: this.snapshots,
      refreshCatalog: () => this.catalog.refresh(),
      registerAxes: (axes: string[]) => {
        for (const axis of new Set(axes)) {
          if ([...this.axis.options].some(option => option.value === axis)) continue;
          const option = document.createElement("option");
          option.value = axis;
          option.textContent = axis.replaceAll("_", " ");
          this.axis.append(option);
        }
      },
      data,
      store: this.workspace,
      tab,
      openSource: (source: ExperimentSource) => this.openSource(source),
      selected: (runId: string) => this.selectedRunIds.has(runId),
      toggleRun: (run: ExperimentRun) => this.toggleRun(run),
      openProject: (project: ProjectRecord) =>
        this.router.navigate({
          mode: "browser",
          page: "project",
          projectId: project.id,
        }),
      openExperiment: (experiment: ExperimentRecord) =>
        this.router.navigate({
          mode: "browser",
          page: "experiment",
          projectId: experiment.project_id,
          experimentId: experiment.id,
        }),
      openRun: (run: ExperimentRun, preview: boolean) => {
        if (preview) this.selectOnly(run);
        else this.enterRunWorkspace(run);
      },
      openRunMenu: (
        event: MouseEvent,
        run: ExperimentRun,
        project: ProjectRecord,
        experiment: ExperimentRecord,
      ) => this.openRunMenu(event, run, project, experiment),
    };
  }

  private contextRun(
    run: ExperimentRun,
    project: ProjectRecord | undefined,
    experiment: ExperimentRecord | undefined,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "rvx-context-run";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = this.selectedRunIds.has(run.id);
    checkbox.ariaLabel = `Select ${run.name}`;
    checkbox.addEventListener("change", () => this.toggleRun(run));
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = run.name;
    button.addEventListener("click", () => this.selectOnly(run));
    button.addEventListener("dblclick", () => this.enterRunWorkspace(run));
    if (project && experiment) {
      row.addEventListener("contextmenu", event => {
        event.preventDefault();
        this.openRunMenu(event, run, project, experiment);
      });
    }
    row.append(checkbox, button);
    return row;
  }

  private toggleRun(run: ExperimentRun): void {
    if (this.selectedRunIds.has(run.id)) this.selectedRunIds.delete(run.id);
    else this.selectedRunIds.add(run.id);
    this.renderContextBrowser();
    if (this.selectedRunIds.size > 1) {
      this.enterCompareWorkspace([...this.selectedRunIds]);
    }
  }

  private selectOnly(run: ExperimentRun): void {
    this.selectedRunIds.clear();
    this.selectedRunIds.add(run.id);
    this.renderContextBrowser();
  }

  private enterRunWorkspace(run: ExperimentRun): void {
    const data = this.catalog.snapshot();
    const experiment = data.experiments.find(
      item => item.id === run.experiment_id,
    );
    this.workspace.replace(runView("run-overview", run, experiment), {
      pinned: true,
    });
    this.router.enterWorkspace([run.id], {
      ...(experiment ? {projectId: experiment.project_id} : {}),
      ...(experiment ? {experimentId: experiment.id} : {}),
    });
  }

  private ensureWorkspace(runIds: string[]): void {
    if (!runIds.length) return;
    const tabs = this.workspace.snapshot().tabs;
    if (tabs.length && workspaceMatchesRuns(tabs, runIds)) return;
    if (runIds.length > 1) {
      this.workspace.replace({
        kind: "compare",
        title: `${runIds.length} Runs`,
        runIds,
      }, {pinned: true});
      return;
    }
    const data = this.catalog.snapshot();
    const run = data.runs.find(item => item.id === runIds[0]);
    const experiment = data.experiments.find(
      item => item.id === run?.experiment_id,
    );
    if (run) {
      this.workspace.replace(runView("run-overview", run, experiment), {
        pinned: true,
      });
    }
  }

  private enterCompareWorkspace(runIds: string[]): void {
    this.workspace.replace({
      kind: "compare",
      title: `${runIds.length} Runs`,
      runIds,
    }, {pinned: true});
    this.router.enterWorkspace(runIds);
  }

  private activateWorkspaceView(view: ViewDefinition): void {
    const existing = this.workspace.snapshot().tabs.find(
      tab =>
        tab.view.kind === view.kind &&
        tab.view.sourceId === view.sourceId &&
        sameRuns(tab.view.runIds, view.runIds),
    );
    if (existing) {
      this.workspace.activate(existing.id);
      return;
    }
    this.workspace.open(view, {preview: true});
  }

  private openSource(source: ExperimentSource): void {
    const data = this.catalog.snapshot();
    const run = data.runs.find(item => item.id === source.run_id);
    this.activateWorkspaceView({
      kind: "source-detail",
      title: `${source.role}${source.rank === null ? "" : `:${source.rank}`}`,
      runIds: run ? [run.id] : [],
      sourceId: source.id,
    });
  }

  private openRunMenu(
    event: MouseEvent,
    run: ExperimentRun,
    project: ProjectRecord,
    experiment: ExperimentRecord,
  ): void {
    this.menu.open(event, [
      {label: "Open Workspace", shortcut: "Enter", action: () =>
        this.enterRunWorkspace(run),
      },
      {label: "Open Field trends", action: () => {
        this.enterRunWorkspace(run);
        this.activateWorkspaceView(runView(
          "metric",
          run,
          experiment,
          defaultRunMetric(this.catalog.snapshot(), run.id),
        ));
      }},
      {label: "Open Sources Workspace", action: () => {
        this.enterRunWorkspace(run);
        this.activateWorkspaceView(runView("sources", run, experiment));
      }},
      {separator: true},
      {
        label: this.selectedRunIds.has(run.id)
          ? "Remove from comparison"
          : "Select for comparison",
        action: () => this.toggleRun(run),
      },
      {label: `Project: ${project.name}`, action: () =>
        this.router.navigate({
          mode: "browser",
          page: "project",
          projectId: project.id,
        }),
      },
    ]);
  }

  private openViewMenu(event: MouseEvent, pane: WorkspacePane): void {
    const route = this.router.snapshot();
    if (route.mode !== "workspace" || !route.runIds.length) return;
    const data = this.catalog.snapshot();
    const run = data.runs.find(item => item.id === route.runIds[0]);
    const experiment = data.experiments.find(
      item => item.id === run?.experiment_id,
    );
    if (!run) return;
    const defaultMetric = defaultRunMetric(data, run.id);
    this.menu.open(event, [
      ...["run-overview", "snapshot-history", "snapshot-diff", "metric", "pipeline", "sources", "run-details", "legacy"].map(
        kind => ({
          label: workspaceLabel(kind),
          action: () => this.workspace.open(
            runView(
              kind as ViewDefinition["kind"],
              run,
              experiment,
              defaultMetric,
            ),
            {pane, pinned: true},
          ),
        }),
      ),
      ...(this.workspace.snapshot().recentlyClosed.length
        ? [{separator: true}, {label: "Restore closed view", action: () => this.workspace.restoreClosed()}]
        : []),
    ]);
  }

  private bindContextResizer(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", event => {
      const start = this.contextWidth;
      const startX = event.clientX;
      const move = (current: PointerEvent): void => {
        this.contextWidth = Math.min(
          420,
          Math.max(180, start + current.clientX - startX),
        );
        this.root
          .querySelector<HTMLElement>(".rvx-app-shell")
          ?.style.setProperty("--rvx-context-width", `${this.contextWidth}px`);
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.localStorage.setItem(
          "rvx.layout.context",
          String(this.contextWidth),
        );
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  private bindSplitResizer(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", event => {
      event.preventDefault();
      const move = (current: PointerEvent): void => {
        const bounds = this.main.getBoundingClientRect();
        this.splitPercent = Math.min(
          75,
          Math.max(25, (current.clientX - bounds.left) / bounds.width * 100),
        );
        this.root
          .querySelector<HTMLElement>(".rvx-app-shell")
          ?.style.setProperty("--rvx-split", `${this.splitPercent}%`);
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.localStorage.setItem(
          "rvx.layout.split",
          String(this.splitPercent),
        );
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        this.menu.close();
        this.setMobileContextOpen(false);
      }
      if (event.ctrlKey && event.key.toLowerCase() === "w") {
        const tab = this.workspace.activeTab();
        if (tab && this.router.snapshot().mode === "workspace") {
          event.preventDefault();
          this.workspace.close(tab.id);
        }
      }
      if (event.ctrlKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        this.contextSearch.focus();
      }
    });
  }
}

function railButton(
  title: string,
  active: boolean,
  action: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = title;
  button.ariaLabel = title;
  button.classList.toggle("active", active);
  button.addEventListener("click", action);
  const label = document.createElement("span");
  label.textContent = title;
  button.append(railIcon(title), label);
  return button;
}

/** Builds the compact line icon used by the global application rail. */
function railIcon(name: string): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const paths: Record<string, string> = {
    Projects:
      '<rect x="3" y="3" width="7" height="7" rx="1"/>' +
      '<rect x="14" y="3" width="7" height="7" rx="1"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1"/>' +
      '<rect x="14" y="14" width="7" height="7" rx="1"/>',
    Runs:
      '<path d="M5 4h14v5H5z"/><path d="M5 15h14v5H5z"/>' +
      '<path d="M8 9v6M16 9v6"/>',
    System:
      '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/>' +
      '<circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  };
  icon.innerHTML = paths[name] ?? '<circle cx="12" cy="12" r="7"/>';
  return icon;
}

function contextButton(
  label: string,
  action: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function workspaceItems(
  data: WorkspaceData,
  runIds: string[],
): Array<{label: string; view: ViewDefinition}> {
  if (runIds.length > 1) {
    return [{
      label: "Compare",
      view: {kind: "compare", title: `${runIds.length} Runs`, runIds},
    }];
  }
  const run = data.runs.find(item => item.id === runIds[0]);
  const experiment = data.experiments.find(
    item => item.id === run?.experiment_id,
  );
  if (!run) return [];
  const defaultMetric = defaultRunMetric(data, run.id);
  return [
    {label: "Snapshots", view: runView("run-overview", run, experiment)},
    {label: "History", view: runView("snapshot-history", run, experiment)},
    {label: "Changes", view: runView("snapshot-diff", run, experiment)},
    {
      label: "Field trends",
      view: runView("metric", run, experiment, defaultMetric),
    },
    {label: "Pipeline", view: runView("pipeline", run, experiment)},
    {label: "Sources", view: runView("sources", run, experiment)},
    {label: "Run Details", view: runView("run-details", run, experiment)},
    {label: "Legacy history", view: runView("legacy", run, experiment)},
  ];
}

function runView(
  kind: ViewDefinition["kind"],
  run: ExperimentRun,
  experiment?: ExperimentRecord,
  metric = "train/loss",
): ViewDefinition {
  return {
    kind,
    title: kind === "run-overview"
      ? "Snapshots"
      : workspaceLabel(kind),
    ...(experiment ? {projectId: experiment.project_id} : {}),
    ...(experiment ? {experimentId: experiment.id} : {}),
    runIds: [run.id],
    ...(kind === "metric" ? {metric} : {}),
  };
}

/** Chooses a useful first metric from the Run's source roles. */
function defaultRunMetric(data: WorkspaceData, runId: string): string {
  return data.sources.some(
    source => source.run_id === runId && source.role === "hostmon",
  )
    ? "cpu/percent"
    : "train/loss";
}

function workspaceLabel(kind: string): string {
  const labels: Record<string, string> = {
    "run-overview": "Snapshots",
    "snapshot-history": "History",
    "snapshot-diff": "Changes",
    metric: "Field trends",
    legacy: "Legacy history",
    pipeline: "Pipeline",
    sources: "Sources",
    "run-details": "Run Details",
  };
  return labels[kind] ?? kind;
}

function browserPageLabel(page: BrowserRoute["page"]): string {
  if (page === "projects") return "Projects";
  if (page === "project") return "Project";
  if (page === "experiment") return "Experiment";
  if (page === "runs") return "Runs";
  return "System";
}

function sameRuns(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

/** Checks whether persisted analytical tabs belong to the routed Run set. */
function workspaceMatchesRuns(
  tabs: WorkspaceTab[],
  runIds: string[],
): boolean {
  const persisted = [...new Set(tabs.flatMap(tab => tab.view.runIds))].sort();
  const routed = [...new Set(runIds)].sort();
  return sameRuns(persisted, routed);
}

function statusItem(label: string, value: string | number): HTMLElement {
  const item = document.createElement("span");
  item.textContent = `${label} ${value}`;
  return item;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function storedNumber(key: BrowserStorageKey, fallback: number): number {
  const value = Number(readBrowserStorage(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function emptyProject(): ProjectRecord {
  return {id: "", name: "", created_at_ns: 0};
}

function emptyExperiment(): ExperimentRecord {
  return {id: "", project_id: "", name: "", created_at_ns: 0};
}
