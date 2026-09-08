import type {SnapshotAggregateResponse, SnapshotRecordsResponse, SnapshotStatusView} from "../../domain/snapshot-views";
import type {TableCell, TableDataRow, TableSource} from "../../domain/tables";
import {missingCell} from "../table-view";
import {el} from "../ui";
import {cellText, provenance, type VisualNames, type VisualTooltip} from "./details";
import {statusShade, statusShadeDomain, type ShadeDomain} from "./shading";

export interface StatusTask {
  key: string; identity: string; record: TableDataRow; state: TableCell; label: string; group: string; groupLabel: string;
}
interface Placement {task: StatusTask; x: number; y: number; size: number; index: number}
interface GroupHeading {key: string; label: string; y: number; run: string}
interface LegendEntry {element: HTMLElement; label: HTMLElement; count: HTMLElement; color: HTMLInputElement | null}
const normalBudget = 800, expandedBudget = 1800, headingHeight = 30;
const stateColors: Readonly<Record<string, string>> = {
  running: "#427fc4", pending: "#bd942d", mixed: "#926bb6", finished: "#39926a", succeeded: "#39926a",
  completed: "#39926a", failed: "#c75454", cancelled: "#7d8391", canceled: "#7d8391",
};

/** Keep raw string states distinct from explicit missing/null typed states. */
export function statusKey(cell: TableCell): string {return JSON.stringify([cell.kind, cell.text]);}

/** Recognize common task states case-insensitively without rewriting the publisher's actual label. */
export function statusColor(cell: TableCell, colors?: Record<string, string>): string {
  const custom = colors && Object.hasOwn(colors, cell.text) ? colors[cell.text] : undefined;
  if (cell.kind !== "missing" && cell.kind !== "null" && custom && /^#[0-9a-f]{6}$/i.test(custom)) return custom;
  if (cell.kind === "missing") return "#a4aebb";
  if (cell.kind === "null") return "#9298a2";
  const raw = cell.text.toLowerCase();
  return Object.hasOwn(stateColors, raw) ? stateColors[raw]! : "#75889b";
}

/** Validate complete state totals before painting any part of a new records/counts frame. */
export function statusTotals(response: SnapshotAggregateResponse): Map<string, string> {
  if (!Number.isSafeInteger(response.matched_rows) || response.matched_rows < 0 || response.offset !== 0
    || response.groups.length !== response.total_groups || response.total_groups > 128) throw new Error("Task status counts are incomplete.");
  const totals = new Map<string, string>();
  let all = 0n;
  for (const group of response.groups) {
    if (totals.has(group.key)) throw new Error("Task status groups are duplicated.");
    let count = 0n;
    for (const series of group.series) {
      const value = series.measures.count?.value;
      if (!value || value.kind !== "number" || value.truncated || !/^\d+$/.test(value.text)) throw new Error("Task status counts are invalid.");
      count += BigInt(value.text);
    }
    totals.set(group.key, count.toString()); all += count;
  }
  if (all !== BigInt(response.matched_rows)) throw new Error("Task status counts do not cover the full filtered dataset.");
  return totals;
}

/** Preserve native full-dataset ordering inside each publisher/group without sorting truncated previews. */
export function statusTasks(response: SnapshotRecordsResponse, view: SnapshotStatusView): StatusTask[] {
  if (response.identities.length !== response.rows.length) throw new Error("Task identities are not aligned with the record page.");
  const seen = new Set<string>();
  return response.rows.map((record, index) => {
    const identity = response.identities[index];
    if (typeof identity !== "string" || !identity) throw new Error("The record page has an invalid task identity.");
    const key = JSON.stringify([record.run_id, record.source_id, identity]);
    if (seen.has(key)) throw new Error("Task identities are not unique in the record page.");
    seen.add(key);
    const group = view.groupPath !== undefined ? record.cells[view.groupPath] ?? missingCell : undefined;
    return {key, identity, record, state: record.cells[view.statusPath] ?? missingCell,
      label: view.labelPath !== undefined ? cellText(record.cells[view.labelPath]) : view.idPaths.map(path => cellText(record.cells[path])).join(" · "),
      group: JSON.stringify([record.run_id, record.source_id, group ? statusKey(group) : ""]),
      groupLabel: group ? cellText(group) : ""};
  }).sort((a, b) => a.group < b.group ? -1 : a.group > b.group ? 1 : 0);
}

/** Fit requested geometry to the viewport and rendering budget without rewriting saved preferences. */
export function gridGeometry(width: number, height: number, view: SnapshotStatusView, expanded: boolean, count = Infinity): {pitch: number; size: number; columns: number} {
  const budget = expanded ? expandedBudget : normalBudget;
  const gap = view.gap ?? 5, available = Math.max(1, width);
  let pitch = (view.cellSize ?? (view.density === "compact" ? 15 : 23)) + gap;
  const columns = (): number => Math.max(1, Math.min(view.columns ?? Infinity, Math.floor((available + gap) / pitch)));
  while (Math.min(count, columns() * (Math.ceil(height / pitch) + 5)) > budget - 1) pitch++;
  return {pitch, columns: columns(), size: Math.min(available, pitch - gap)};
}

/** Render a page of stable task identities with full-dataset state counts and bounded scroll-window DOM. */
export class SnapshotStatusGrid {
  readonly element = el("div", "sv-status");
  private legend = el("div", "sv-status-legend");
  private viewport = el("div", "sv-status-viewport");
  private canvas = el("div", "sv-status-canvas");
  private cells = new Map<string, HTMLButtonElement>();
  private headers = new Map<string, HTMLElement>();
  private legends = new Map<string, LegendEntry>();
  private shadeLegend = el("span", "sv-shade-key");
  private shades = new Map<string, number | null>();
  private shadeDomain: ShadeDomain | null = null;
  private shadePath: string | undefined;
  private tasks: StatusTask[] = [];
  private byKey = new Map<string, StatusTask>();
  private placements: Placement[] = [];
  private positions = new Map<string, Placement>();
  private groups: GroupHeading[] = [];
  private snapshots = new Map<string, TableSource>();
  private data: SnapshotRecordsResponse | null = null;
  private counts: SnapshotAggregateResponse | null = null;
  private totals = new Map<string, string>();
  private view: SnapshotStatusView | null = null;
  private selected: string | null = null;
  private columns = 1;
  private pitch = 28;
  private frame = 0;
  private dirtyLayout = false;
  private active = true;
  private lifetime = new AbortController();
  private resize: ResizeObserver;

  /** Own one observer and delegated input listeners, never a polling interval or per-task handler. */
  constructor(private names: VisualNames, private tooltip: VisualTooltip,
    private openTask: (task: StatusTask, source: TableSource | undefined) => void,
    private colorChanged: (raw: string, color: string) => void) {
    this.legend.setAttribute("aria-label", "Full filtered task status counts");
    this.viewport.tabIndex = 0; this.viewport.setAttribute("role", "group"); this.viewport.setAttribute("aria-label", "Task status grid");
    this.viewport.setAttribute("aria-description", "Each cell is one task. Arrow keys move between tasks. Home and End move to page edges. Enter opens task details.");
    this.viewport.append(this.canvas); this.element.append(this.legend, this.viewport);
    const signal = this.lifetime.signal;
    this.viewport.addEventListener("scroll", () => this.schedule(false), {passive: true, signal});
    this.viewport.addEventListener("keydown", event => this.navigate(event), {signal});
    this.viewport.addEventListener("pointerover", event => this.hover(event.target), {signal});
    this.viewport.addEventListener("pointerleave", () => this.tooltip.hide(), {signal});
    this.viewport.addEventListener("focusin", event => {
      const button = this.target(event.target);
      if (button) {this.select(button.dataset.taskKey!); this.hover(button);}
    }, {signal});
    this.viewport.addEventListener("focusout", event => {if (!(event.relatedTarget instanceof Node) || !this.viewport.contains(event.relatedTarget)) this.tooltip.hide();}, {signal});
    this.viewport.addEventListener("click", event => {
      const button = this.target(event.target), task = button ? this.byKey.get(button.dataset.taskKey!) : undefined;
      if (task) {this.select(task.key); this.tooltip.hide(); this.openTask(task, this.snapshots.get(task.record.snapshot_id));}
    }, {signal});
    this.resize = new ResizeObserver(() => this.schedule(true)); this.resize.observe(this.viewport);
  }

  /** Commit records and their pinned counts together; retain DOM identity for surviving visible tasks. */
  setData(data: SnapshotRecordsResponse, counts: SnapshotAggregateResponse, view: SnapshotStatusView): void {
    if (counts.total_groups > 128) throw new Error("More than 128 task states. Choose a categorical status field.");
    const tasks = statusTasks(data, view);
    const totals = statusTotals(counts);
    const shadeDomain = view.shadePath !== undefined ? statusShadeDomain(counts, view.shadeScale ?? "log") : null;
    const shades = new Map<string, number | null>();
    if (shadeDomain && view.shadePath !== undefined) for (const task of tasks) shades.set(task.key, statusShade(task.record.cells[view.shadePath], shadeDomain));
    this.data = data; this.counts = counts; this.view = view; this.tasks = tasks;
    this.totals = totals;
    this.shadeDomain = shadeDomain; this.shades = shades; this.shadePath = view.shadePath;
    this.byKey = new Map(tasks.map(task => [task.key, task]));
    this.snapshots = new Map(data.snapshots.map(source => [source.snapshot_id, source]));
    if (!this.selected || !this.byKey.has(this.selected)) this.selected = tasks[0]?.key ?? null;
    this.tooltip.hide(); this.renderLegend(); this.layout(); this.paint();
  }

  /** Apply geometry and raw-state colors to cached data without any native read. */
  applyView(view: SnapshotStatusView): void {
    if (this.counts && this.shadePath !== undefined && (view.shadeScale ?? "log") !== this.shadeDomain?.scale) {
      const domain = statusShadeDomain(this.counts, view.shadeScale ?? "log"), shades = new Map<string, number | null>();
      for (const task of this.tasks) shades.set(task.key, statusShade(task.record.cells[this.shadePath], domain));
      this.shadeDomain = domain; this.shades = shades;
    }
    this.view = view;
    if (this.data && this.counts) {this.renderLegend(); this.layout(); this.paint();}
  }

  /** Update keyed full-scope count controls without replacing a focused native color input. */
  private renderLegend(): void {
    if (!this.counts || !this.view) return;
    const keep = new Set<string>();
    for (const group of this.counts.groups) {
      const state = group.cells[0] ?? missingCell, key = group.key; keep.add(key);
      let entry = this.legends.get(key);
      if (!entry) {
        const element = el("label", "sv-state-key"), label = el("span", "sv-state-name"), count = el("span", "sv-state-count");
        let color: HTMLInputElement | null = null;
        if (state.kind !== "missing" && state.kind !== "null" && !state.truncated && !state.text.includes("\0") && new TextEncoder().encode(state.text).length <= 256) {
          color = el("input", "sv-state-color"); color.type = "color";
          color.setAttribute("aria-label", `Color for ${cellText(state)}`); color.title = `Color for ${cellText(state)}`;
          color.addEventListener("change", () => {if (color) this.colorChanged(state.text, color.value);}, {signal: this.lifetime.signal});
          element.append(color);
        } else element.append(el("i", "sv-state-swatch"));
        element.append(label, count); entry = {element, label, count, color}; this.legends.set(key, entry);
      }
      const total = this.totals.get(key)!;
      entry.label.textContent = cellText(state); entry.count.textContent = total;
      entry.element.dataset.kind = state.kind;
      entry.element.style.setProperty("--sv-state", statusColor(state, this.view.colors));
      if (entry.color && document.activeElement !== entry.color) entry.color.value = statusColor(state, this.view.colors);
      entry.element.title = `${cellText(state)} · ${total} tasks across the full filtered dataset\n` + group.series.map(series =>
        `${this.names.runName(series.run_id)} · Source ${series.source_id}: ${series.measures.count?.value.text ?? "missing"}`).join("\n");
      if (!entry.element.isConnected) this.legend.append(entry.element);
    }
    for (const [key, entry] of this.legends) if (!keep.has(key)) {entry.element.remove(); this.legends.delete(key);}
    this.renderShadeLegend();
  }

  /** Keep the shared numeric scale beside state counts, with exact range and unavailable-value context. */
  private renderShadeLegend(): void {
    if (!this.shadeDomain || this.shadePath === undefined) {this.shadeLegend.remove(); return;}
    const {bounds, unavailable} = this.shadeDomain;
    const range = bounds ? bounds.span === 0n ? bounds.minimum.text : `${bounds.minimum.text} – ${bounds.maximum.text}` : "No numeric values";
    const scale = this.shadeDomain.scale === "log" ? "Log" : "Linear";
    const label = `${this.names.fieldName(this.shadePath)} · ${range} · ${scale}${unavailable ? ` · ${unavailable} unavailable` : ""}`;
    const ramp = el("span", "sv-shade-ramp");
    for (const intensity of [24, 42, 60, 78, 96]) {
      const step = el("i"); step.style.setProperty("--sv-shade-step", `${intensity}%`); ramp.append(step);
    }
    this.shadeLegend.replaceChildren(ramp, el("span", "sv-shade-label", label));
    this.shadeLegend.dataset.scale = this.shadeDomain.scale;
    this.shadeLegend.title = `${label}\n${scale === "Log" ? "Signed logarithmic" : "Linear"} range across all filtered tasks and Sources. A corner dot marks unavailable shading.`;
    this.shadeLegend.setAttribute("aria-label", this.shadeLegend.title);
    this.legend.append(this.shadeLegend);
  }

  /** Lay out native-ordered tasks in responsive rows while keeping publisher/group boundaries intact. */
  private layout(): void {
    if (!this.view) return;
    const width = Math.max(1, this.viewport.clientWidth), height = this.viewport.clientHeight || 320;
    const geometry = gridGeometry(width, height, this.view, Boolean(this.element.closest(".is-expanded")), this.tasks.length);
    this.pitch = geometry.pitch; this.columns = geometry.columns;
    this.canvas.dataset.columns = String(this.columns);
    this.placements = []; this.positions.clear(); this.groups = [];
    const sourceCounts = new Map<string, number>();
    for (const source of this.snapshots.values()) sourceCounts.set(source.run_id, (sourceCounts.get(source.run_id) ?? 0) + 1);
    let current = "", y = 0, local = 0;
    for (const [index, task] of this.tasks.entries()) {
      if (task.group !== current) {
        if (current) y += Math.ceil(local / this.columns) * this.pitch + 10;
        current = task.group; local = 0;
        const snapshot = this.snapshots.get(task.record.snapshot_id);
        const peers = sourceCounts.get(task.record.run_id) ?? 0;
        const owner = this.names.runName(task.record.run_id) + (peers > 1 ? ` · ${snapshot?.label ?? task.record.source_id}` : "");
        this.groups.push({key: task.group, label: `${this.view.groupPath !== undefined ? `${this.names.fieldName(this.view.groupPath)}: ${task.groupLabel} · ` : ""}${owner}`,
          y, run: task.record.run_id});
        y += headingHeight;
      }
      const placement = {task, x: local % this.columns * this.pitch, y: y + Math.floor(local / this.columns) * this.pitch, size: geometry.size, index};
      this.placements.push(placement); this.positions.set(task.key, placement); local++;
    }
    const heightNeeded = y + Math.ceil(local / this.columns) * this.pitch;
    this.canvas.style.height = `${Math.max(heightNeeded, this.tasks.length ? 60 : 90)}px`;
    this.viewport.style.setProperty("--sv-content-height", `${Math.max(100, Math.min(360, heightNeeded))}px`);
    this.viewport.scrollTop = Math.min(this.viewport.scrollTop, Math.max(0, heightNeeded - this.viewport.clientHeight));
    this.canvas.dataset.total = String(this.data?.total ?? 0);
    this.viewport.setAttribute("aria-label", `Task status grid · ${this.tasks.length} tasks on this page · ${this.data?.total ?? 0} total`);
  }

  /** Binary-search the first visible row instead of traversing every record during scroll. */
  private firstVisible(y: number): number {
    let low = 0, high = this.placements.length;
    while (low < high) {const mid = (low + high) >>> 1; if (this.placements[mid]!.y < y) low = mid + 1; else high = mid;}
    return low;
  }

  /** Mount only the visible rows plus overscan, retaining the focused task as one extra bounded cell. */
  private paint(): void {
    if (!this.active || !this.view) return;
    const top = Math.max(0, this.viewport.scrollTop - this.pitch * 2), bottom = this.viewport.scrollTop + this.viewport.clientHeight + this.pitch * 2;
    const wanted = new Map<string, Placement>(), keepHeaders = new Set<string>();
    const budget = this.element.closest(".is-expanded") ? expandedBudget : normalBudget;
    for (let index = this.firstVisible(top); index < this.placements.length && this.placements[index]!.y <= bottom && wanted.size < budget - 1; index++) {
      const placement = this.placements[index]!; wanted.set(placement.task.key, placement);
    }
    const focused = this.target(document.activeElement), selected = focused ? this.positions.get(focused.dataset.taskKey!) : undefined;
    if (selected) wanted.set(selected.task.key, selected);
    for (const [key, button] of this.cells) if (!wanted.has(key)) {button.remove(); this.cells.delete(key);}
    for (const [key, placement] of wanted) {
      let button = this.cells.get(key);
      if (!button) {
        button = el("button", "sv-task-cell"); button.type = "button"; button.dataset.taskKey = key;
        this.cells.set(key, button); this.canvas.append(button);
      }
      const task = placement.task;
      button.dataset.identity = task.identity; button.dataset.status = task.state.text; button.dataset.kind = task.state.kind;
      button.dataset.run = task.record.run_id; button.dataset.source = task.record.source_id;
      button.dataset.snapshotId = task.record.snapshot_id; button.dataset.rowKey = task.record.row_key;
      button.setAttribute("aria-label", `${task.label} · ${cellText(task.state)} · ${this.names.runName(task.record.run_id)} · Source ${this.snapshots.get(task.record.snapshot_id)?.label ?? task.record.source_id}`);
      button.tabIndex = key === this.selected ? 0 : -1;
      button.style.transform = `translate(${placement.x}px, ${placement.y}px)`;
      button.style.width = `${placement.size}px`; button.style.height = `${placement.size}px`;
      button.style.setProperty("--sv-state", statusColor(task.state, this.view.colors));
      const shade = this.shades.get(key);
      button.dataset.shade = shade === undefined ? "none" : shade === null ? "unavailable" : "numeric";
      if (shade === undefined) button.style.removeProperty("--sv-shade");
      else button.style.setProperty("--sv-shade", `${shade === null ? 55 : 24 + shade * 72}%`);
    }
    for (const group of this.groups) {
      if (group.y + headingHeight < top || group.y > bottom) continue;
      keepHeaders.add(group.key);
      let heading = this.headers.get(group.key);
      if (!heading) {heading = el("h3", "sv-task-group"); this.headers.set(group.key, heading); this.canvas.append(heading);}
      heading.textContent = group.label; heading.title = group.label; heading.style.top = `${group.y}px`;
      heading.style.setProperty("--run-color", this.names.colorFor(group.run));
    }
    for (const [key, heading] of this.headers) if (!keepHeaders.has(key)) {heading.remove(); this.headers.delete(key);}
    let empty = this.canvas.querySelector<HTMLElement>(".sv-empty");
    if (!this.tasks.length && !empty) {empty = el("p", "sv-empty muted", "No tasks match this snapshot query."); this.canvas.append(empty);}
    else if (this.tasks.length) empty?.remove();
    if (!this.cells.has(this.selected ?? "") && !focused) {
      const first = this.cells.values().next().value;
      if (first) this.select(first.dataset.taskKey!);
    }
    this.viewport.tabIndex = this.cells.size ? -1 : 0;
    this.canvas.dataset.mounted = String(this.cells.size);
  }

  /** Coalesce scroll/resize work into one owned animation frame. */
  private schedule(layout: boolean): void {
    this.dirtyLayout ||= layout;
    if (!this.active || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.dirtyLayout) {this.dirtyLayout = false; this.layout();}
      this.paint();
    });
  }

  /** Resolve one delegated cell without confusing legend controls or empty viewport clicks. */
  private target(target: EventTarget | null): HTMLButtonElement | null {
    return target instanceof Element ? target.closest<HTMLButtonElement>(".sv-task-cell") : null;
  }

  /** Maintain one roving tab stop without rewriting every task button on focus changes. */
  private select(key: string): void {
    if (this.selected !== key) {const old = this.cells.get(this.selected ?? ""); if (old) old.tabIndex = -1;}
    this.selected = key;
    const button = this.cells.get(key); if (button) button.tabIndex = 0;
  }

  /** Show one task's exact mapped fields and immutable Source observation on hover or focus. */
  private hover(target: EventTarget | null): void {
    const button = this.target(target), task = button ? this.byKey.get(button.dataset.taskKey!) : undefined;
    if (!button || !task || !this.view) return;
    this.tooltip.show(button, task.label, [
      [this.names.fieldName(this.view.statusPath), cellText(task.state)],
      ...this.view.idPaths.filter(path => path !== this.view!.labelPath && path !== this.view!.statusPath)
        .map((path): [string, string] => [this.names.fieldName(path), cellText(task.record.cells[path])]),
      ...(this.view.valuePath !== undefined ? [[this.names.fieldName(this.view.valuePath), cellText(task.record.cells[this.view.valuePath])] as [string, string]] : []),
      ...(this.shadePath !== undefined && ![this.view.valuePath, this.view.statusPath, ...this.view.idPaths].includes(this.shadePath)
        ? [[this.names.fieldName(this.shadePath), cellText(task.record.cells[this.shadePath])] as [string, string]] : []),
      ...(this.shades.get(task.key) === null ? [["Shade", "Unavailable"] as [string, string]] : []),
      ...provenance(task.record.run_id, task.record.source_id, this.snapshots.get(task.record.snapshot_id), this.names),
    ]);
  }

  /** Move in canonical visual order, scrolling unmounted targets into the bounded render window. */
  private navigate(event: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !this.tasks.length) return;
    event.preventDefault();
    const current = this.positions.get(this.selected ?? "")?.index ?? 0;
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -this.columns : this.columns;
    const index = event.key === "Home" ? 0 : event.key === "End" ? this.tasks.length - 1 : Math.max(0, Math.min(this.tasks.length - 1, current + delta));
    const placement = this.placements[index]!;
    this.select(placement.task.key);
    if (placement.y < this.viewport.scrollTop) this.viewport.scrollTop = placement.y;
    else if (placement.y + this.pitch > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = placement.y + this.pitch - this.viewport.clientHeight;
    this.paint(); this.cells.get(placement.task.key)?.focus({preventScroll: true});
  }

  /** Stop pending layout work while hidden, then adapt the same DOM when reactivated. */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) {cancelAnimationFrame(this.frame); this.frame = 0; this.tooltip.hide();}
    else this.schedule(true);
  }

  /** Repaint group Run accents without reloading task data or changing status colors. */
  refreshColors(): void {this.paint();}

  /** Clear previous scope identities and counts before replacement data can arrive. */
  clear(): void {
    this.tooltip.hide(); this.data = null; this.counts = null; this.totals.clear(); this.tasks = []; this.byKey.clear(); this.snapshots.clear();
    this.placements = []; this.positions.clear(); this.groups = []; this.selected = null;
    this.cells.clear(); this.headers.clear(); this.legends.clear(); this.canvas.replaceChildren(); this.legend.replaceChildren();
    this.shades.clear(); this.shadeDomain = null; this.shadePath = undefined;
    this.canvas.style.height = "90px"; this.viewport.scrollTop = 0;
  }

  /** Release observer, animation frames, delegated listeners and all cached task references. */
  destroy(): void {this.resize.disconnect(); cancelAnimationFrame(this.frame); this.lifetime.abort(); this.clear();}
}
