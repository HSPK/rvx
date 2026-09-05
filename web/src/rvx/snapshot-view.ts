import type {
  SnapshotHistoryPage, SnapshotLatestResponse,
  StoredSnapshot,
} from "../domain/snapshots";
import type {WorkspaceData, WorkspaceTab} from "./domain";
import {ChartController, type ChartSeries} from "./chart-controller";
import type {SnapshotStore} from "./query-store";
import type {WorkspaceStore} from "./workspace-store";
import {chronological, diffValue, jsonPreview, numericFields, validPointer} from "./snapshot-utils";
import {appendRow, denseTable, formatNs} from "./ui";
import {exactProperty, stringifyExact} from "../core/exact-json";
import {logicalBound} from "./snapshot-range";

interface SnapshotContext {
  snapshots: SnapshotStore;
  data: WorkspaceData;
  tab: WorkspaceTab;
  store: WorkspaceStore;
  registerAxes(axes: string[]): void;
}

const PAGE_SIZE = 40;
const CONSISTENCY = "Each Source is a local consistency boundary. Time alignment is not a globally atomic snapshot.";

export class SnapshotView {
  private readonly abort = new AbortController();
  private readonly charts = new ChartController();
  private readonly notice = node("div", "rvx-read-status");
  private readonly body = node("div", "rvx-snapshot-body");
  private readonly inspector = node("section", "rvx-state-inspector");
  private readonly rows = node("div", "rvx-snapshot-rows");
  private readonly pageControls = node("div", "rvx-snapshot-toolbar");
  private readonly trendBody = node("div", "rvx-trend-body");
  private records: StoredSnapshot[] = [];
  private selected: StoredSnapshot | null = null;
  private selectedSource = "";
  private latestPages: Array<{cursor: string | null; page: SnapshotLatestResponse}> = [];
  private historyPage: SnapshotHistoryPage | null = null;
  private historyCursors: Array<number | null> = [null];
  private historyIndex = 0;
  private historyRun: string;
  private sourceFilter = "";
  private live = true;
  private loading = false;
  private readAbort: AbortController | null = null;
  private replayTimer: number | null = null;
  private paths: string[] = [];
  private pathInput: HTMLInputElement | null = null;
  private pathOptions: HTMLDataListElement | null = null;
  private fieldHint: HTMLElement | null = null;
  private projectionRangeControls: HTMLElement | null = null;
  private rangeInputs: HTMLInputElement[] = [];
  private chartCreated = false;
  private queryGeneration = 0;
  private diffGeneration = 0;
  private beforeId: number | null = null;
  private afterId: number | null = null;
  private diffControls: HTMLElement | null = null;
  private diffBody: HTMLElement | null = null;
  private comparePages = new Map<string, SnapshotHistoryPage>();
  private compareHistory = new Map<string, StoredSnapshot[]>();
  private from: number | undefined;
  private to: number | undefined;

  constructor(readonly element: HTMLElement, private context: SnapshotContext) {
    this.historyRun = context.tab.view.runIds[0] ?? "";
    this.sourceFilter = context.tab.view.sourceId ?? String(context.tab.state.filters.snapshotSource ?? "");
    try {
      const paths: unknown = JSON.parse(String(context.tab.state.filters.snapshotPaths ?? "[]"));
      if (Array.isArray(paths)) this.paths = paths.filter((path): path is string => typeof path === "string" && validPointer(path)).slice(0, 64);
    } catch { /* Ignore obsolete local preferences. */ }
    const cursor = context.tab.state.filters.historyCursor;
    if (typeof cursor === "number") this.historyCursors = [cursor];
    const filters = context.tab.state.filters;
    const storedAxis = filters.rangeAxis ?? "wall_time";
    const axis = this.isProjection() ? context.tab.state.axis : "wall_time";
    if (storedAxis === axis) {
      const from = filters.rangeFrom ?? filters.observedFrom;
      const to = filters.rangeTo ?? filters.observedTo;
      if (typeof from === "number" && Number.isFinite(from) && (axis === "wall_time" || Number.isSafeInteger(from))) this.from = from;
      if (typeof to === "number" && Number.isFinite(to) && (axis === "wall_time" || Number.isSafeInteger(to))) this.to = to;
    }
    const intro = node("div", "rvx-snapshot-intro", CONSISTENCY);
    element.append(intro, this.notice, this.body);
    this.build();
    this.renderPathChips();
    void this.load();
  }

  destroy(): void {
    this.abort.abort();
    this.readAbort?.abort();
    this.stopReplay();
    this.charts.destroy();
  }

  refresh(data: WorkspaceData): void {
    this.context.data = data;
    const kind = this.context.tab.view.kind;
    if (this.live && ["run-overview", "source-detail"].includes(kind)) void this.loadLatest(false);
    if (kind === "metric" || kind === "compare") void this.queryFields();
  }

  setAxis(axis: string): void {
    const changed = this.context.tab.state.axis !== axis;
    this.context.tab.state.axis = axis;
    if (!this.isProjection()) return;
    if (changed) {
      this.from = undefined;
      this.to = undefined;
      this.renderProjectionRange();
      this.remember();
    }
    void this.queryFields();
  }

  private isProjection(): boolean {
    return this.context.tab.view.kind === "metric" || this.context.tab.view.kind === "compare";
  }

  private remember(): void {
    const {observedFrom: _oldFrom, observedTo: _oldTo, ...filters} = this.context.tab.state.filters;
    this.context.tab.state.filters = {
      ...filters,
      snapshotPaths: JSON.stringify(this.paths),
      snapshotSource: this.sourceFilter,
      historyCursor: this.historyCursors[this.historyIndex] ?? null,
      rangeAxis: this.isProjection() ? this.context.tab.state.axis : "wall_time",
      rangeFrom: this.from ?? null,
      rangeTo: this.to ?? null,
    };
    this.context.tab.state.selectedId = this.selected ? String(this.selected.id) : null;
    this.context.store.rememberState(this.context.tab.id, {
      filters: this.context.tab.state.filters, selectedId: this.context.tab.state.selectedId,
    });
  }

  private build(): void {
    const kind = this.context.tab.view.kind;
    if (kind === "metric") {
      this.buildTrends();
      return;
    }
    if (kind === "snapshot-diff" || kind === "compare") {
      const title = node("h2", "", kind === "compare" ? "Compare stored state · across Runs / Experiments" : "Changes between stored snapshots");
      this.diffControls = node("div", "rvx-snapshot-toolbar");
      this.diffBody = node("div", "rvx-diff-body");
      this.body.append(title, this.diffControls, this.diffBody);
      if (kind === "compare") this.buildTrends();
      return;
    }
    const toolbar = node("div", "rvx-snapshot-toolbar");
    const filter = document.createElement("select");
    filter.ariaLabel = "Snapshot Source";
    filter.append(option("", "All Sources"));
    for (const source of this.context.data.sources.filter(source => source.run_id === this.historyRun)) {
      filter.append(option(source.id, `${source.role} · ${source.id}`));
    }
    filter.value = this.sourceFilter;
    filter.addEventListener("change", () => {
      this.sourceFilter = filter.value;
      this.cancelRead();
      this.latestPages = [];
      this.selectedSource = "";
      this.selected = null;
      this.inspector.replaceChildren();
      this.historyCursors = [null];
      this.historyIndex = 0;
      this.stopReplay();
      this.remember();
      void this.load();
    });
    toolbar.append(labelled("Source", filter));
    if (kind === "snapshot-history") {
      toolbar.append(this.timeControl("Observed from", value => this.from = value));
      toolbar.append(this.timeControl("Observed to", value => this.to = value));
      toolbar.append(button("Apply time range", () => {
        if (this.from !== undefined && this.to !== undefined && this.from > this.to) {
          this.notice.textContent = "Observed from must not be later than Observed to.";
          return;
        }
        this.cancelRead();
        this.historyIndex = 0;
        this.historyCursors = [null];
        void this.loadHistory();
      }));
    } else {
      const liveButton = button("Pause latest", () => {
        this.live = !this.live;
        liveButton.textContent = this.live ? "Pause latest" : "Resume latest";
        if (this.live) void this.loadLatest(false);
      });
      toolbar.append(liveButton);
    }
    toolbar.append(button("Refresh", () => void this.load()));
    const split = node("div", "rvx-snapshot-split");
    const list = node("section", "rvx-snapshot-list");
    list.append(this.rows, this.pageControls);
    split.append(list, this.inspector);
    this.body.append(toolbar, split);
  }

  private async load(): Promise<void> {
    const kind = this.context.tab.view.kind;
    if (kind === "snapshot-history") await this.loadHistory();
    else if (kind === "snapshot-diff" || kind === "compare") await this.loadComparison();
    else await this.loadLatest(false);
  }

  private async loadLatest(more: boolean): Promise<void> {
    if (this.loading || this.abort.signal.aborted) return;
    this.loading = true;
    const controller = this.beginRead();
    try {
      const runId = this.context.tab.view.runIds[0];
      if (!runId) return;
      const cursors = more
        ? [this.latestPages.at(-1)?.page.next_source_id ?? null]
        : this.latestPages.length ? this.latestPages.map(page => page.cursor) : [null];
      const pages = await Promise.all(cursors.map(async cursor => ({
        cursor,
        page: await this.context.snapshots.latest.query({
          run_id: runId, limit: PAGE_SIZE, after_source_id: cursor,
          ...(this.sourceFilter ? {source_ids: [this.sourceFilter]} : {}),
        }, controller.signal),
      })));
      if (controller.signal.aborted) return;
      this.latestPages = more ? [...this.latestPages, ...pages] : pages;
      this.records = [...new Map(this.latestPages.flatMap(page => page.page.snapshots).map(snapshot => [snapshot.source_id, snapshot])).values()];
      this.context.registerAxes(this.records.flatMap(snapshot => Object.keys(snapshot.axes)));
      this.notice.textContent = `${this.records.length} latest Source states · observed time (not ingestion time)`;
      if (this.context.tab.view.kind === "metric") {
        this.updateFields();
        await this.queryFields();
      } else {
        this.renderRows(false);
        const current = this.records.find(record => record.source_id === this.selectedSource) ?? this.records[0];
        if (current && (!this.selected || exactProperty(current, "id") !== exactProperty(this.selected, "id"))) this.select(current);
        if (!current) this.empty();
      }
      const next = this.latestPages.at(-1)?.page.next_source_id;
      this.pageControls.replaceChildren();
      if (next) this.pageControls.append(button("Load more Sources", () => void this.loadLatest(true)));
      if (this.context.tab.view.kind === "metric" && next) {
        this.fieldHint!.append(node("span", "", "More Sources available."));
        this.fieldHint!.append(button("Load more Sources", () => void this.loadLatest(true)));
      }
    } catch (error) { if (!controller.signal.aborted) this.error(error); }
    finally { if (this.readAbort === controller) this.loading = false; }
  }

  private async loadHistory(): Promise<void> {
    if (this.loading || this.abort.signal.aborted) return;
    this.stopReplay();
    this.loading = true;
    const controller = this.beginRead();
    try {
      const page = await this.context.snapshots.history.query({
        run_id: this.historyRun, limit: PAGE_SIZE,
        before_id: this.historyCursors[this.historyIndex] ?? null,
        ...(this.sourceFilter ? {source_ids: [this.sourceFilter]} : {}),
        ...(this.from !== undefined ? {from: this.from} : {}),
        ...(this.to !== undefined ? {to: this.to} : {}),
      }, controller.signal);
      if (controller.signal.aborted) return;
      this.historyPage = page;
      this.records = page.snapshots;
      this.context.registerAxes(this.records.flatMap(snapshot => Object.keys(snapshot.axes)));
      this.notice.textContent = `Page ${this.historyIndex + 1} · ${page.snapshots.length} snapshots · newest global storage IDs first. Replay sorts this bounded page by observation time.`;
      if (this.selected && !this.records.some(record => record.id === this.selected!.id)) {
        this.notice.textContent += ` Selected #${this.selected.id} is retained from another page.`;
      }
      this.renderRows(true);
      if (!this.selected && this.records[0]) this.select(this.records.find(record => String(record.id) === this.context.tab.state.selectedId) ?? this.records[0]);
      if (!this.records.length && !this.selected) this.empty();
      this.renderHistoryControls();
    } catch (error) { if (!controller.signal.aborted) this.error(error); }
    finally { if (this.readAbort === controller) this.loading = false; }
  }

  private cancelRead(): void {
    this.readAbort?.abort();
    this.loading = false;
  }

  private beginRead(): AbortController {
    this.readAbort?.abort();
    const controller = new AbortController();
    this.readAbort = controller;
    return controller;
  }

  private renderHistoryControls(): void {
    this.pageControls.replaceChildren();
    const newer = button("Newer page", () => {
      this.historyIndex--;
      void this.loadHistory();
    });
    newer.disabled = this.historyIndex === 0;
    const older = button("Fetch older", () => {
      const cursor = this.historyPage?.next_before_id;
      if (cursor === null || cursor === undefined) return;
      this.historyCursors[++this.historyIndex] = cursor;
      void this.loadHistory();
    });
    older.disabled = this.historyPage?.next_before_id == null;
    const previous = button("Previous state", () => this.step(-1));
    const next = button("Next state", () => this.step(1));
    const play = button(this.replayTimer === null ? "Replay page" : "Pause replay", () => {
      if (this.replayTimer !== null) this.stopReplay();
      else {
        const first = chronological(this.records)[0];
        if (first) this.select(first);
        this.replayTimer = window.setInterval(() => this.step(1, true), 900);
      }
      this.renderHistoryControls();
    });
    previous.disabled = next.disabled = play.disabled = !this.records.length;
    this.pageControls.append(newer, older, previous, next, play);
  }

  private step(direction: number, playing = false): void {
    const ordered = chronological(this.records);
    const current = ordered.findIndex(record => record.id === this.selected?.id);
    const index = current < 0 ? 0 : current + direction;
    const record = ordered[index];
    if (record) this.select(record);
    else if (playing) {
      this.stopReplay();
      this.renderHistoryControls();
    }
  }

  private stopReplay(): void {
    if (this.replayTimer !== null) window.clearInterval(this.replayTimer);
    this.replayTimer = null;
  }

  private renderRows(history: boolean): void {
    const signature = JSON.stringify(this.records.map(snapshot => exactProperty(snapshot, "id")));
    if (this.rows.dataset.signature === signature) return;
    this.rows.dataset.signature = signature;
    const table = denseTable(["Stored ID", "Source / version", "Observed"]);
    table.classList.add("rvx-snapshot-table");
    for (const snapshot of this.records) {
      const source = this.context.data.sources.find(source => source.id === snapshot.source_id);
      const id = exactProperty(snapshot, "id");
      const pick = button(`#${id}`, () => this.select(snapshot));
      pick.ariaLabel = `Inspect snapshot ${id}`;
      const row = appendRow(table, ["", `${source?.role ?? snapshot.source_id} · v${exactProperty(snapshot, "sequence")}`, formatNs(snapshot.observed_at_ns)]);
      row.cells[0]!.append(pick);
      row.dataset.snapshotId = id;
      row.classList.toggle("selected", snapshot.id === this.selected?.id);
      row.addEventListener("click", () => this.select(snapshot));
    }
    this.rows.replaceChildren(node("h2", "", history ? "Stored history" : "Latest by Source"), table);
  }

  private select(snapshot: StoredSnapshot): void {
    this.selected = snapshot;
    this.selectedSource = snapshot.source_id;
    for (const row of this.rows.querySelectorAll<HTMLElement>("[data-snapshot-id]")) {
      row.classList.toggle("selected", row.dataset.snapshotId === exactProperty(snapshot, "id"));
    }
    const existing = this.inspector.querySelector<HTMLElement>(".rvx-raw-inspector");
    if (existing) updateRawInspector(existing, snapshot);
    else this.inspector.replaceChildren(rawInspector(snapshot));
    this.remember();
  }

  private empty(): void {
    this.inspector.replaceChildren(node("div", "rvx-empty-state",
      "No structured snapshots retained for this selection. This Run may contain legacy numeric history only. Legacy values cannot reconstruct runtime state; use the Legacy history View to read them separately."));
  }

  private buildTrends(): void {
    const section = node("section", "rvx-projections");
    section.append(node("h2", "", "Numeric field projections"));
    const filters = node("div", "rvx-snapshot-toolbar");
    const source = document.createElement("select");
    source.ariaLabel = "Projection Source";
    source.append(option("", "All Sources"));
    for (const item of this.context.data.sources.filter(item => this.context.tab.view.runIds.includes(item.run_id))) {
      source.append(option(item.id, `${item.run_id} / ${item.role} · ${item.id}`));
    }
    source.value = this.sourceFilter;
    source.addEventListener("change", () => {
      this.sourceFilter = source.value;
      this.remember();
      void this.queryFields();
    });
    this.projectionRangeControls = node("div", "rvx-projection-range");
    this.renderProjectionRange();
    filters.append(
      labelled("Source", source),
      this.projectionRangeControls,
      button("Apply projection range", () => void this.queryFields()),
    );
    const controls = node("form", "rvx-snapshot-toolbar");
    this.pathInput = document.createElement("input");
    this.pathInput.placeholder = "/progress/loss";
    this.pathInput.ariaLabel = "State JSON pointer";
    this.pathOptions = document.createElement("datalist");
    this.pathOptions.id = `snapshot-paths-${this.context.tab.id}`;
    this.pathInput.setAttribute("list", this.pathOptions.id);
    const add = button("Add field", () => {});
    add.type = "submit";
    controls.addEventListener("submit", event => {
      event.preventDefault();
      const path = this.pathInput!.value;
      if (!validPointer(path) || !path) {
        this.notice.textContent = "Enter an RFC 6901 state pointer, e.g. /metrics/cpu~1percent.";
        return;
      }
      if (!this.addPath(path)) return;
      this.renderPathChips();
      void this.queryFields();
    });
    controls.append(labelled("JSON pointer", this.pathInput), add, this.pathOptions);
    const chips = node("div", "rvx-field-chips");
    this.fieldHint = node("div", "rvx-field-hint");
    section.append(filters, controls, this.fieldHint, chips, this.trendBody);
    this.body.append(section);
    this.trendBody.append(node("p", "rvx-empty-state", "Choose a recorded numeric field or enter any state pointer. Missing, null and nonnumeric observations remain gaps."));
  }

  private renderPathChips(): void {
    const chips = this.body.querySelector(".rvx-field-chips");
    chips?.replaceChildren(...this.paths.map(path => button(`${path} ×`, () => {
      this.paths = this.paths.filter(item => item !== path);
      this.renderPathChips();
      void this.queryFields();
    })));
    if (chips) this.remember();
  }

  private updateFields(): void {
    if (!this.pathOptions) return;
    const fields = this.records.map(record => numericFields(record.state));
    const paths = [...new Set(fields.flatMap(field => field.paths))].slice(0, 300);
    this.pathOptions.replaceChildren(...paths.map(path => option(path, path)));
    const picker = document.createElement("select");
    picker.ariaLabel = "Recorded numeric fields";
    picker.append(option("", "Select a recorded numeric field…"), ...paths.map(path => option(path, path)));
    picker.addEventListener("change", () => {
      if (picker.value) {
        this.pathInput!.value = picker.value;
        if (!this.addPath(picker.value)) return;
        this.renderPathChips();
        void this.queryFields();
      }
    });
    this.fieldHint!.replaceChildren(picker, node("span", "", `${paths.length} recorded numeric fields${fields.some(field => field.truncated) || paths.length === 300 ? " · discovery truncated; enter a pointer for any other field" : ""}. No metric registry.`));
  }

  private async queryFields(): Promise<void> {
    if (!this.paths.length || this.abort.signal.aborted) {
      if (!this.paths.length && this.chartCreated) this.trendBody.hidden = true;
      return;
    }
    if (this.context.tab.view.runIds.length > 64) {
      this.notice.textContent = "A projection supports up to 64 Runs. Narrow the comparison selection.";
      return;
    }
    if (this.rangeInputs.some(input => !input.checkValidity())) {
      this.notice.textContent = this.context.tab.state.axis === "wall_time"
        ? "Enter valid observation-time bounds."
        : "Logical bounds must be signed safe integers between -9007199254740991 and 9007199254740991.";
      return;
    }
    if (this.from !== undefined && this.to !== undefined && this.from > this.to) {
      this.notice.textContent = "Range start must not exceed range end in the selected axis.";
      return;
    }
    this.trendBody.hidden = false;
    const generation = ++this.queryGeneration;
    this.remember();
    try {
      const response = await this.context.snapshots.query.query({
        run_ids: this.context.tab.view.runIds, paths: [...this.paths],
        axis: this.context.tab.state.axis, max_points: 1600,
        ...(this.sourceFilter ? {source_ids: [this.sourceFilter]} : {}),
        ...(this.from !== undefined ? {from: this.from} : {}),
        ...(this.to !== undefined ? {to: this.to} : {}),
      }, this.abort.signal);
      if (this.abort.signal.aborted || generation !== this.queryGeneration) return;
      this.notice.classList.remove("rvx-warning");
      this.notice.textContent = "Projection reads are bounded. Narrow Source or observation time when the engine requests smaller scans.";
      const series: ChartSeries[] = response.series.map(item => ({
        source_id: item.source_id, axes: item.axes, values: item.values,
        label: `${this.context.data.runs.find(run => run.id === item.run_id)?.name ?? item.run_id} · ${item.source_id} · ${item.path}`,
      }));
      if (!this.chartCreated) {
        this.trendBody.replaceChildren(this.charts.create("State field projection", response.axis, series, "large", "projection"));
        this.trendBody.append(node("div", "rvx-projection-summary"), node("div", "rvx-projection-values"));
        this.chartCreated = true;
      }

      this.charts.update("projection", series, response.axis);
      const gaps = response.series.reduce((count, item) => count + item.values.filter(value => value === null).length, 0);
      this.trendBody.querySelector(".rvx-projection-summary")!.textContent =
        `${response.series.length} series · ${gaps} gaps · bounded to 1,600 points · ${response.axis === "wall_time" ? "observation time" : response.axis} · f64 numeric projections · no carry-forward`;
      const values = denseTable(["Run / Source", "State pointer", "Observations", "Last value"]);
      for (const series of response.series) appendRow(values, [
        `${series.run_id} / ${series.source_id}`, series.path, series.values.length,
        series.values.at(-1) == null ? "gap (null / absent / nonnumeric)" : String(series.values.at(-1)),
      ]);
      this.trendBody.querySelector(".rvx-projection-values")!.replaceChildren(values);
    } catch (error) { this.error(error); }
  }

  private addPath(path: string): boolean {
    if (this.paths.includes(path)) return true;
    if (this.paths.length >= 64) {
      this.notice.textContent = "A projection supports up to 64 fields. Remove a field before adding another.";
      return false;
    }
    this.paths.push(path);
    return true;
  }

  private async loadComparison(runId?: string): Promise<void> {
    if (this.loading) return;
    if (this.context.tab.view.runIds.length > 64) {
      this.notice.textContent = "A comparison supports up to 64 Runs. Narrow the Run selection.";
      return;
    }
    this.loading = true;
    try {
      await Promise.all((runId ? [runId] : this.context.tab.view.runIds).map(async id => {
        const previous = this.comparePages.get(id);
        const page = await this.context.snapshots.history.query({
          run_id: id, limit: PAGE_SIZE, before_id: runId ? previous?.next_before_id ?? null : null,
        }, this.abort.signal);
        this.comparePages.set(id, page);
        this.compareHistory.set(id, page.snapshots);
      }));
      if (this.abort.signal.aborted) return;
      const selected = this.records.filter(record => record.id === this.beforeId || record.id === this.afterId);
      this.records = [...new Map([...this.compareHistory.values()].flat().concat(selected).map(record => [record.id, record])).values()];
      this.context.registerAxes(this.records.flatMap(snapshot => Object.keys(snapshot.axes)));
      if (this.beforeId === null || this.afterId === null) {
        const firstRun = this.context.tab.view.runIds[0];
        const first = this.context.tab.view.runIds.length === 1
          ? this.records.find(record => this.records.some(other => other.source_id === record.source_id && other.id !== record.id)) ?? this.records[0]
          : this.records.find(record => record.run_id === firstRun);
        const second = this.context.tab.view.runIds.length > 1
          ? this.records.find(record => record.run_id !== firstRun)
          : this.records.find(record => record.source_id === first?.source_id && record.id !== first.id);
        this.beforeId = second?.id ?? first?.id ?? null;
        this.afterId = first?.id ?? null;
      }
      this.renderDiffControls();
      await this.loadDiff();
      if (this.context.tab.view.kind === "compare") this.updateFields();
    } catch (error) { this.error(error); }
    finally { this.loading = false; }
  }

  private renderDiffControls(): void {
    if (!this.diffControls) return;
    this.diffControls.replaceChildren();
    for (const side of ["Before", "After"] as const) {
      const select = document.createElement("select");
      select.ariaLabel = `${side} snapshot`;
      for (const record of this.records) {
        const run = this.context.data.runs.find(run => run.id === record.run_id);
        select.append(option(String(record.id), `${run?.name ?? record.run_id} / ${record.source_id} · #${exactProperty(record, "id")} · v${exactProperty(record, "sequence")}`));
      }
      select.value = String(side === "Before" ? this.beforeId : this.afterId);
      select.addEventListener("change", () => {
        if (side === "Before") this.beforeId = Number(select.value);
        else this.afterId = Number(select.value);
        void this.loadDiff();
      });
      this.diffControls.append(labelled(side, select));
    }
    for (const [runId, page] of this.comparePages) {
      if (page.next_before_id !== null) this.diffControls.append(button(`Older: ${this.context.data.runs.find(run => run.id === runId)?.name ?? runId}`, () => void this.loadComparison(runId)));
    }
  }

  private async loadDiff(): Promise<void> {
    if (!this.diffBody) return;
    if (this.beforeId === null || this.afterId === null) {
      this.diffBody.textContent = "No stored snapshots available. Legacy metric history is not reconstructed as state.";
      return;
    }
    const generation = ++this.diffGeneration;
    try {
      const result = await this.context.snapshots.diff.query({
        before_id: this.beforeId, after_id: this.afterId,
      }, this.abort.signal);
      if (this.abort.signal.aborted || generation !== this.diffGeneration) return;
      const table = denseTable(["Change", "JSON pointer", "Before", "After"]);
      for (const change of result.changes) {
        const row = appendRow(table, [
          change.kind, change.path || "(root)",
          bounded(diffValue(change, "before")), bounded(diffValue(change, "after")),
        ]);
        row.dataset.change = change.kind;
      }
      const summary = node("p", result.truncated ? "rvx-warning" : "rvx-diff-summary",
        `${result.changes.length} changes · #${exactProperty(result, "before_id")} → #${exactProperty(result, "after_id")}${result.truncated ? " · DIFF TRUNCATED by server. This is not the complete change set." : ""} · (absent) is distinct from null. Cell previews over 2,000 characters are truncated; inspect raw states below.`);
      this.diffBody.replaceChildren(summary, table);
      if (!result.changes.length) this.diffBody.append(node("p", "", "No state differences in this result."));
      const raw = node("div", "rvx-diff-raw");
      for (const [label, id] of [["Before", result.before_id], ["After", result.after_id]] as const) {
        const record = this.records.find(record => record.id === id);
        if (!record) continue;
        const details = document.createElement("details");
        details.append(node("summary", "", `${label} · raw state #${id}`), rawInspector(record));
        raw.append(details);
      }
      this.diffBody.append(raw);
    } catch (error) { this.error(error); }
  }

  private renderProjectionRange(): void {
    if (!this.projectionRangeControls) return;
    this.rangeInputs = [];
    const axis = this.context.tab.state.axis;
    this.projectionRangeControls.replaceChildren(...(["from", "to"] as const).map(side => {
      const save = (value: number | undefined): void => {
        if (side === "from") this.from = value;
        else this.to = value;
      };
      if (axis === "wall_time") {
        const control = this.timeControl(`Observed ${side}`, save);
        this.rangeInputs.push(control.querySelector("input")!);
        return control;
      }
      const input = document.createElement("input");
      input.type = "number";
      input.step = "1";
      input.min = String(Number.MIN_SAFE_INTEGER);
      input.max = String(Number.MAX_SAFE_INTEGER);
      input.ariaLabel = `${axis} ${side}`;
      input.placeholder = "Signed integer";
      const value = side === "from" ? this.from : this.to;
      input.value = value === undefined ? "" : String(value);
      input.addEventListener("input", () => {
        input.setCustomValidity("");
        try {
          if (input.validity.badInput) throw new Error("Invalid integer");
          save(logicalBound(input.value));
        } catch {
          input.setCustomValidity("Enter a signed safe integer.");
        }
      });
      this.rangeInputs.push(input);
      return labelled(`${axis} ${side}`, input);
    }));
  }

  private timeControl(label: string, save: (value: number | undefined) => void): HTMLElement {
    const input = document.createElement("input");
    input.type = "datetime-local";
    input.step = "1";
    input.ariaLabel = label;
    const initial = label === "Observed from" ? this.from : this.to;
    if (initial !== undefined) {
      const date = new Date(initial / 1e6);
      input.value = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    }
    input.addEventListener("change", () => save(input.value ? new Date(input.value).getTime() * 1e6 : undefined));
    return labelled(`${label} (local time)`, input);
  }

  private error(error: unknown): void {
    if (this.abort.signal.aborted) return;
    this.notice.textContent = `Snapshot read failed: ${error instanceof Error ? error.message : String(error)}. Last successful data is retained.`;
    this.notice.classList.add("rvx-warning");
  }
}

const inspectedRecords = new WeakMap<HTMLElement, StoredSnapshot>();

export function rawInspector(snapshot: StoredSnapshot): HTMLElement {
  const root = node("div", "rvx-raw-inspector");
  root.dataset.storedId = exactProperty(snapshot, "id");
  inspectedRecords.set(root, snapshot);
  const heading = node("h2", "", `Structured state · stored #${exactProperty(snapshot, "id")}`);
  const details = node("details", "rvx-state-metadata");
  const summary = node("summary");
  const metadata = denseTable(["Identity", "Value"]);
  for (const [name, value] of metadataValues(snapshot)) appendRow(metadata, [name, value]);
  details.append(summary, metadata);
  const pre = node("pre", "rvx-state-json");
  const tools = node("div", "rvx-snapshot-toolbar");
  const download = button("Download full snapshot JSON", () => {
    const current = inspectedRecords.get(root)!;
    const url = URL.createObjectURL(new Blob([stringifyExact(current, 2)], {type: "application/json"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = `snapshot-${exactProperty(current, "id")}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  });
  const notice = node("span", "rvx-warning rvx-json-truncation");
  const full = button("Show full state", () => {
    root.dataset.full = "true";
    updateRawInspector(root, inspectedRecords.get(root)!);
  });
  full.className = "rvx-full-state";
  tools.append(download, notice, full);
  root.append(heading, details, tools, pre);
  updateRawInspector(root, snapshot);
  return root;
}

function metadataValues(snapshot: StoredSnapshot): Array<[string, string | number]> {
  return [
    ["Run / Source", `${snapshot.run_id} / ${snapshot.source_id}`],
    ["Session / version", `${snapshot.source_session_id} / ${exactProperty(snapshot, "sequence")}`],
    ["Schema version", snapshot.schema_version],
    ["Observed", `${formatNs(snapshot.observed_at_ns)} · ${exactProperty(snapshot, "observed_at_ns")} ns`],
    ["Ingested (not time axis)", `${formatNs(snapshot.ingested_at_ns)} · ${exactProperty(snapshot, "ingested_at_ns")} ns`],
    ["Logical axes", stringifyExact(snapshot.axes)],
  ];
}

function updateRawInspector(root: HTMLElement, snapshot: StoredSnapshot): void {
  inspectedRecords.set(root, snapshot);
  root.dataset.storedId = exactProperty(snapshot, "id");
  root.querySelector("h2")!.textContent = `Structured state · stored #${exactProperty(snapshot, "id")}`;
  root.querySelector("summary")!.textContent = `${snapshot.source_id} / ${snapshot.source_session_id} · version ${exactProperty(snapshot, "sequence")} · Schema version ${exactProperty(snapshot, "schema_version")} · observed ${formatNs(snapshot.observed_at_ns)}`;
  const rows = root.querySelectorAll("tbody tr");
  for (const [index, [, value]] of metadataValues(snapshot).entries()) {
    rows[index]!.children[1]!.textContent = String(value);
  }
  const preview = jsonPreview(snapshot.state);
  const pre = root.querySelector<HTMLElement>(".rvx-state-json")!;
  const scrollTop = pre.scrollTop;
  const full = root.dataset.full === "true";
  pre.textContent = full ? stringifyExact(snapshot.state, 2) : preview.text;
  pre.scrollTop = scrollTop;
  const notice = root.querySelector<HTMLElement>(".rvx-json-truncation")!;
  notice.hidden = !preview.truncated;
  notice.textContent = full ? "Full state shown" : "JSON PREVIEW TRUNCATED · first 32,000 characters";
  root.querySelector<HTMLElement>(".rvx-full-state")!.hidden = !preview.truncated || full;
}

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

export function button(text: string, action: () => void): HTMLButtonElement {
  const element = node("button", "", text);
  element.type = "button";
  element.addEventListener("click", action);
  return element;
}

function option(value: string, text: string): HTMLOptionElement {
  const element = node("option", "", text);
  element.value = value;
  return element;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = node("label", "", text);
  label.append(control);
  return label;
}

function bounded(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}… [truncated]` : value;
}
