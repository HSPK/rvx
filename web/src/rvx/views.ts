import type {ApiClient} from "../core/api-client";
import type {ClusterGPUReport, ExperimentRun, ExperimentSource} from "../domain/types";
import type {WorkspaceData, WorkspaceTab} from "./domain";
import type {QueryStore, SnapshotStore} from "./query-store";
import type {WorkspaceStore} from "./workspace-store";
import {SnapshotView, button, node} from "./snapshot-view";
import {appendRow, denseTable, formatNs, runSection, summaryStrip} from "./ui";

export interface ViewContext {
  api: ApiClient;
  queries: QueryStore;
  snapshots: SnapshotStore;
  data: WorkspaceData;
  store: WorkspaceStore;
  tab: WorkspaceTab;
  openSource(source: ExperimentSource): void;
  refreshCatalog(): Promise<WorkspaceData>;
  registerAxes(axes: string[]): void;
}

const HOSTMON_SECTIONS = [
  ["tasks", "Tasks"], ["metrics", "Live metrics"], ["collectors", "Collectors"],
  ["kubernetes", "Kubernetes"], ["alerts", "Alerts"],
  ["gpu-fleet", "GPU Fleet"], ["workloads", "Workloads"], ["system", "Host system"],
  ["settings", "Settings"], ["layouts", "Layouts"],
] as const;

export class ViewHost {
  private snapshot: SnapshotView | null = null;
  private readonly abort = new AbortController();
  private signature = "";

  constructor(readonly element: HTMLElement, private context: ViewContext) {
    void this.render();
  }

  destroy(): void {
    this.abort.abort();
    this.snapshot?.destroy();
  }

  updateTab(tab: WorkspaceTab): void {
    if (this.context.tab.state.axis !== tab.state.axis) this.snapshot?.setAxis(tab.state.axis);
    this.context.tab = tab;
  }

  matchesTab(tab: WorkspaceTab): boolean {
    return this.context.tab.view.kind === tab.view.kind &&
      this.context.tab.view.sourceId === tab.view.sourceId &&
      this.context.tab.view.section === tab.view.section &&
      JSON.stringify(this.context.tab.view.runIds) === JSON.stringify(tab.view.runIds);
  }

  refresh(data: WorkspaceData): void {
    this.context.data = data;
    if (this.snapshot) {
      this.snapshot.refresh(data);
      const strip = this.element.querySelector(".rvx-summary-strip");
      if (strip) this.updateSummary(strip as HTMLElement);
      return;
    }
    // Operational read-through is explicitly refreshed by the user, not by catalog polls.
    if (["hostmon-section", "legacy", "run-details"].includes(this.context.tab.view.kind)) return;
    const signature = JSON.stringify(this.sources());
    if (signature !== this.signature) {
      this.signature = signature;
      this.element.replaceChildren();
      void this.render();
    }
  }

  private async render(): Promise<void> {
    const kind = this.context.tab.view.kind;
    if (["run-overview", "metric", "snapshot-history", "snapshot-diff", "compare"].includes(kind)) {
      const strip = node("div", "rvx-summary-strip");
      this.updateSummary(strip);
      const root = node("div", "rvx-snapshot-workspace");
      this.element.append(strip, root);
      this.snapshot = new SnapshotView(root, this.context);
    } else if (kind === "sources") this.renderSources();
    else if (kind === "pipeline") this.renderPipeline();
    else if (kind === "run-details") this.renderRunDetails();
    else if (kind === "source-detail") this.renderSourceDetails();
    else if (kind === "hostmon-section") await this.renderHostmon();
    else if (kind === "legacy") this.renderLegacy();
    else this.element.textContent = "Choose a snapshot analysis View from the Navigator.";
  }

  private updateSummary(strip: HTMLElement): void {
    const runs = this.context.data.runs.filter(run => this.context.tab.view.runIds.includes(run.id));
    const sources = this.sources();
    const fields: Array<[string, string | number]> = [
      ["Run", runs.map(run => run.name).join(" / ")],
      ["Lifecycle", runs.map(run => run.status).join(" / ")],
      ["Sources", `${sources.filter(source => source.state === "active").length}/${sources.length} active`],
      ["Roles", new Set(sources.map(source => source.role)).size],
      ["Health", pipelineHealth(sources)],
      ["Source freshness", sources.length ? formatNs(Math.max(...sources.map(source => source.last_success_at_ns ?? 0))) : "No Sources"],
    ];
    const signature = JSON.stringify(fields);
    if (strip.dataset.signature !== signature) {
      strip.replaceChildren(...summaryStrip(fields).childNodes);
      strip.dataset.signature = signature;
    }
  }

  private sources(): ExperimentSource[] {
    return this.context.data.sources.filter(source => this.context.tab.view.runIds.includes(source.run_id));
  }

  private renderSources(): void {
    const table = denseTable(["State", "Role", "Rank", "Node", "PID", "Endpoint", "Session", "Interval", "Error"]);
    for (const source of this.sources()) {
      const row = appendRow(table, [
        source.state, source.role, source.rank ?? "—", source.node_id ?? "—",
        source.descriptor?.pid ?? "—", source.endpoint, source.source_session_id ?? "—",
        `${source.scrape_interval_ms} ms`, source.last_error ?? "—",
      ]);
      const open = button(source.role, () => this.context.openSource(source));
      row.cells[1]!.replaceChildren(open);
    }
    this.element.append(runSection("Sources · Source-local sessions", table));
  }

  private renderPipeline(): void {
    const table = denseTable(["Role", "Health", "Sources", "Active", "Stale", "Nodes", "Failures"]);
    const all = this.sources();
    for (const role of new Set(all.map(source => source.role))) {
      const sources = all.filter(source => source.role === role);
      appendRow(table, [
        role, pipelineHealth(sources), sources.length,
        sources.filter(source => source.state === "active").length,
        sources.filter(source => source.state === "stale").length,
        new Set(sources.map(source => source.node_id).filter(Boolean)).size,
        sources.filter(source => source.state !== "ended" && source.last_error).length,
      ]);
    }
    this.element.append(node("p", "rvx-snapshot-intro", "Role health is operational, not a claim of atomic state across Sources. Ended historical Sources do not degrade health."), table);
  }

  private renderRunDetails(): void {
    const run = this.context.data.runs.find(run => run.id === this.context.tab.view.runIds[0]);
    if (!run) return;
    const table = denseTable(["Run identity", "Value"]);
    for (const [name, value] of [
      ["Name", run.name], ["Run ID", run.id], ["Experiment", run.experiment_id],
      ["Lifecycle", run.status], ["Created", formatNs(run.created_at_ns)],
      ["Updated", formatNs(run.updated_at_ns)], ["Sources", this.sources().length],
    ] as const) appendRow(table, [name, value]);
    this.element.append(table);
    this.element.append(this.lifecycleControl("Run lifecycle", run.status,
      state => state === "created"
        ? ["created", "running", "finished", "failed", "cancelled"]
        : state === "running" ? ["running", "finished", "failed", "cancelled"] : [state],
      async value => {
        const updated = await this.context.api.updateRunStatus(run.id, value as ExperimentRun["status"]);
        Object.assign(run, updated);
        table.tBodies[0]!.rows[3]!.cells[1]!.textContent = updated.status;
      }));
    const config = node("pre", "rvx-config-view");
    try { config.textContent = JSON.stringify(JSON.parse(run.config_json), null, 2); }
    catch { config.textContent = run.config_json; }
    this.element.append(runSection("Resolved configuration", config, false));
    if (this.sources().some(source => source.role === "hostmon")) {
      this.element.append(node("p", "rvx-snapshot-intro", "Hostmon read-through shows current operational data, not historical snapshot replay."), this.hostmonNavigation());
    }
  }

  private renderSourceDetails(): void {
    const source = this.context.data.sources.find(source => source.id === this.context.tab.view.sourceId);
    if (!source) return;
    const table = denseTable(["Source metadata", "Value"]);
    for (const [name, value] of [
      ["Role / rank", `${source.role} / ${source.rank ?? "—"}`],
      ["State", source.state], ["Source / Attempt", `${source.id} / ${source.attempt_id}`],
      ["Node / PID", `${source.node_id ?? "—"} / ${source.descriptor?.pid ?? "—"}`],
      ["Session", source.source_session_id ?? "—"], ["Endpoint", source.endpoint],
      ["Interval / timeout", `${source.scrape_interval_ms} / ${source.timeout_ms} ms`],
      ["Last error", source.last_error ?? "None"],
    ]) appendRow(table, [name!, value!]);
    this.element.append(runSection("Source metadata", table));
    this.element.append(this.lifecycleControl("Source lifecycle", source.state,
      state => state === "ended" || state === "lost" ? [state]
        : state === "draining" ? ["draining", "ended", "lost"]
          : [state, "draining", "ended", "lost"],
      async value => {
        const updated = await this.context.api.updateSourceState(source.id, value as ExperimentSource["state"]);
        Object.assign(source, updated);
        table.tBodies[0]!.rows[1]!.cells[1]!.textContent = updated.state;
      }));
    const root = node("div", "rvx-snapshot-workspace");
    this.element.append(root);
    this.snapshot = new SnapshotView(root, this.context);
  }

  private renderLegacy(): void {
    this.element.append(node("p", "rvx-warning", "LEGACY · read-only numeric history. These records cannot reconstruct structured runtime state. New numeric projections belong in Field trends."));
    const form = node("form", "rvx-snapshot-toolbar");
    const metric = document.createElement("input");
    metric.ariaLabel = "Legacy metric name";
    metric.placeholder = "train/loss";
    const submit = button("Read legacy history", () => {});
    submit.type = "submit";
    const result = node("div", "rvx-legacy-results");
    form.append(metric, submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const runId = this.context.tab.view.runIds[0];
      if (!runId || !metric.value) return;
      submit.disabled = true;
      void this.context.queries.query({
        run_id: runId, metrics: [metric.value], axis: this.context.tab.state.axis, max_points: 1600,
      }, this.abort.signal).then(response => {
        if (this.abort.signal.aborted) return;
        const table = denseTable(["Legacy metric", "Source", "Points", "Last stored value"]);
        for (const series of response.series) appendRow(table, [
          series.metric, series.source_id, series.values.length, String(series.values.at(-1) ?? "—"),
        ]);
        result.replaceChildren(table);
        if (!response.series.length) result.append(node("p", "", "No legacy numeric observations for this name."));
        else {
          const entries = response.series.flatMap(series => series.values.map((value, index) => ({
            source: series.source_id, session: series.source_session_ids[index] ?? "—",
            sequence: series.sequences[index] ?? "—", observed: series.event_time_ns[index] ?? 0,
            axis: series.axes[index] ?? "—", value,
          })));
          let page = 0;
          const history = node("div", "rvx-legacy-history");
          const controls = node("div", "rvx-snapshot-toolbar");
          const draw = (): void => {
            const points = denseTable(["Source", "Session", "Sequence", "Legacy event time", response.axis, "Value"]);
            for (const point of entries.slice(page * 200, (page + 1) * 200)) appendRow(points, [
              point.source, point.session, point.sequence, formatNs(point.observed), point.axis, point.value,
            ]);
            history.replaceChildren(points);
            const previous = button("Previous legacy page", () => { page--; draw(); });
            const next = button("Next legacy page", () => { page++; draw(); });
            previous.disabled = page === 0;
            next.disabled = (page + 1) * 200 >= entries.length;
            controls.replaceChildren(previous, next, node("span", "", `Page ${page + 1} · ${entries.length} bounded query observations. Numeric history only.`));
          };
          draw();
          result.append(history, controls);
        }
      }).catch(error => { if (!this.abort.signal.aborted) result.textContent = String(error); })
        .finally(() => { submit.disabled = false; });
    });
    this.element.append(form, result);
  }

  private lifecycleControl(title: string, current: string, values: (state: string) => string[], save: (value: string) => Promise<void>): HTMLElement {
    const form = node("form", "rvx-snapshot-toolbar");
    const label = node("label", "", title);
    const select = document.createElement("select");
    select.ariaLabel = title;
    const options = (): void => {
      select.replaceChildren(...values(current).map(value => {
        const option = node("option", "", value);
        option.value = value;
        return option;
      }));
      select.value = current;
      select.disabled = values(current).length === 1;
    };
    options();
    label.append(select);
    const apply = button("Apply lifecycle", () => {});
    apply.type = "submit";
    apply.disabled = true;
    select.addEventListener("change", () => { apply.disabled = select.value === current; });
    const output = node("output", "rvx-read-status");
    form.append(label, apply, output, node("span", "rvx-snapshot-intro", "RVX metadata / collection only. Does not kill or restart remote processes."));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const requested = select.value;
      apply.disabled = true;
      select.disabled = true;
      output.textContent = "Updating metadata…";
      void save(requested).then(async () => {
        current = requested;
        options();
        output.textContent = "Lifecycle updated. Stored snapshots are retained.";
        await this.context.refreshCatalog();
      }).catch(error => {
        output.classList.add("rvx-warning");
        output.textContent = `Lifecycle update failed: ${String(error)}`;
      }).finally(() => {
        select.disabled = values(current).length === 1;
        apply.disabled = select.value === current;
      });
    });
    return form;
  }

  private hostmonNavigation(): HTMLElement {
    const nav = node("nav", "rvx-section-navigation");
    for (const [section, title] of HOSTMON_SECTIONS) {
      nav.append(button(title, () => this.context.store.open({
        kind: "hostmon-section", title: `Hostmon · ${title}`, section,
        runIds: this.context.tab.view.runIds,
      }, {preview: true})));
    }
    return nav;
  }

  private async renderHostmon(): Promise<void> {
    const section = this.context.tab.view.section;
    const result = node("div", "rvx-hostmon-result");
    this.element.append(node("p", "rvx-snapshot-intro", "LIVE HOSTMON READ-THROUGH · not stored snapshot state"), this.hostmonNavigation(), result);
    try {
      let table: HTMLTableElement;
      if (section === "collectors" || section === "kubernetes") {
        table = denseTable(["Collector", "State", "Duration", "Failures", "Last error"]);
        for (const collector of await this.context.api.collectors()) {
          if (section === "kubernetes" && !/kubernetes|cluster_gpu/.test(collector.name)) continue;
          appendRow(table, [collector.name, collector.state, collector.duration ?? "—", collector.failures, collector.last_error ?? "—"]);
        }
      } else if (section === "metrics") {
        table = denseTable(["Live metric", "Current", "Minimum", "Mean", "Maximum", "Samples"]);
        for (const metric of (await this.context.api.catalog(21_600, this.abort.signal)).metrics) {
          appendRow(table, [metric.name, metric.current, metric.minimum, metric.average, metric.maximum, metric.samples]);
        }
      } else if (section === "alerts") {
        table = denseTable(["Enabled", "Rule", "Level", "Expression"]);
        for (const rule of await this.context.api.rules()) appendRow(table, [String(rule.enabled), rule.alert, rule.level, rule.expr]);
      } else if (section === "gpu-fleet" || section === "workloads") {
        const report = (await this.context.api.plugin<ClusterGPUReport>("cluster_gpu_usage", this.abort.signal)).document;
        if (section === "gpu-fleet") {
          table = denseTable(["Queue", "GPU allocation", "Utilization", "Pending", "Free CPU"]);
          for (const row of report.capacity) appendRow(table, [row.queue, row.gpu_allocation, row.utilization_percent, row.pending_gpus, row.free_cpus]);
        } else {
          table = denseTable(["Queue", "Workload", "State", "Submitter", "Running GPU", "Pending GPU", "Nodes"]);
          for (const row of report.workloads) appendRow(table, [row.queue, row.name, row.status, row.submitter, row.running_gpus, row.pending_gpus, row.running_nodes.join(", ")]);
        }
      } else if (section === "tasks" || section === "system") {
        const status = await this.context.api.status(this.abort.signal);
        table = denseTable(["Field", "Current value"]);
        const fields = section === "tasks" ? status.fields : status;
        for (const [name, value] of Object.entries(fields)) appendRow(table, [name, typeof value === "object" ? JSON.stringify(value) : String(value)]);
      } else {
        const link = node("a", "rvx-legacy-link", `Open hostmon ${section ?? "overview"}`);
        link.href = `/hostmon?page=${encodeURIComponent(section ?? "overview")}`;
        result.append(link);
        return;
      }
      if (!this.abort.signal.aborted) result.append(table);
    } catch (error) {
      if (!this.abort.signal.aborted) result.textContent = `Hostmon read-through unavailable: ${String(error)}`;
    }
  }
}

export function pipelineHealth(sources: ExperimentSource[]): string {
  const operational = sources.filter(source => source.state !== "ended");
  if (!operational.length) return sources.length ? "ENDED" : "WAITING";
  if (operational.every(source => source.state === "lost")) return "DOWN";
  if (operational.some(source => source.last_error || source.state === "stale" || source.state === "lost")) return "WARN";
  if (operational.some(source => source.state === "active")) return "OK";
  return "WAITING";
}
