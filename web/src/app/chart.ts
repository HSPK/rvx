import uPlot from "uplot";
import type {ChartMetric, SnapshotQuerySeries} from "../domain/snapshots";
import type {ExperimentRun} from "../domain/types";
import {axisLabel, compatibleMetrics, copyChart, duration, formatNumber, formatTime, metricName, pointId, reporters, type ChartSpec} from "./model";
import {button, el} from "./ui";
import {elapsedIncrements, elapsedTick} from "./time";
import {PanelChrome, type PanelAction} from "./panel-chrome";
import {ChartHover} from "./chart-hover";

/** Align sparse traces without turning absent alignment slots into observed null gaps. */
export function alignedData(series: SnapshotQuerySeries[], axis: string): uPlot.AlignedData {
  const axes = [...new Set(series.flatMap(item => item.axes))].sort((a, b) => a - b);
  return [
    axes.map(value => axis === "wall_time" || axis === "elapsed" ? value / 1e9 : value),
    ...series.map(item => {
      const values = new Map(item.axes.map((x, index) => [x, item.values[index] ?? null]));
      // Interleaved reporters have no observation at these slots. Only real nulls break curves.
      return axes.map(x => values.get(x));
    }),
  ];
}
/** Find the closest sorted coordinate without scanning every point during pointer movement. */
export function nearestIndex(values: number[], target: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return 0;
  if (lo === values.length) return lo - 1;
  return target - values[lo - 1]! <= values[lo]! - target ? lo - 1 : lo;
}
/** Map sorted display coordinates to the last actual observation when logical axes repeat. */
export function cursorCoordinates(axes: number[]): {axes: number[]; indices: number[]} {
  const last = new Map(axes.map((axis, index) => [axis, index]));
  const sorted = [...last.keys()].sort((a, b) => a - b);
  return {axes: sorted, indices: sorted.map(axis => last.get(axis)!)};
}
interface Trace {series: SnapshotQuerySeries; metric: ChartMetric; runName: string; label: string; color: string; dash: number[]; coordinates: ReturnType<typeof cursorCoordinates>}
interface HoverTrace {runId: string; trace?: Trace | undefined; label: string; color: string; state: string; index: number}
interface SelectedPoint {id: string; series: SnapshotQuerySeries; index: number}
type ObservationKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
type HoverMode = "pointer" | "keyboard" | null;
const chartKeys = "Use left/right for observations and up/down for Run or reporter traces. Fullscreen is in chart options. Drag the plot to zoom; double-click to reset.";
const shortDate = new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric", year: "numeric"});
const shortClock = new Intl.DateTimeFormat(undefined, {hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"});
const preciseClock = new Intl.DateTimeFormat(undefined, {hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23"});
const axisFont = "11px system-ui, sans-serif";
export type ChartAction = PanelAction;

export class ChartRenderer {
  readonly element = el("article", "chart-card");
  readonly chrome: PanelChrome;
  private metrics: ChartMetric[];
  private host = el("div", "chart-host");
  private legend = el("div", "chart-legend");
  private hover = new ChartHover();
  private hoverTraces: HoverTrace[] = [];
  private empty = el("div", "chart-empty");
  private plot: uPlot | null = null;
  private traces: Trace[] = [];
  private selected: SelectedPoint | null = null;
  private interacted = false;
  private signature = "";
  private axis = "wall_time";
  private zoomed = false;
  private reset: HTMLButtonElement;
  private zoomState = el("span", "chart-zoom-state", "Zoomed");
  private retry = button("Retry", () => this.onRetry(), "text-button");
  private feedback = el("div", "chart-feedback");
  private errorMessage = el("span");
  private lifetime = new AbortController();
  private resize: ResizeObserver;
  private frame = 0;
  private lastSuccess = 0;
  private pending = true;
  private announcement = el("span", "chart-announcement");
  private autoHideLegend = false;
  private hoverFrame = 0;
  private hoverMode: HoverMode = null;
  private pointerX = 0;
  private pointerY = 0;
  private plotBox: DOMRect | null = null;
  private touch: {x: number; y: number; moved: boolean} | null = null;
  private axisRightPadding = 10;

  /** Own one chart's controls, gestures, and resizing independently of query scheduling. */
  constructor(readonly spec: ChartSpec, private metric: ChartMetric, onAction: (action: ChartAction) => void, private colorFor: (runId: string) => string, private labelFor: (run: ExperimentRun) => string, private onRetry: () => void, private mode: "workspace" | "preview" = "workspace") {
    this.metrics = [metric];
    this.chrome = new PanelChrome("chart", onAction, mode === "preview", () => this.hideHover());
    this.reset = this.chrome.addAction("Reset zoom", () => this.resetZoom());
    this.element.dataset.path = spec.path;
    this.element.classList.toggle("wide", spec.size === "wide");
    const name = this.displayTitle();
    this.chrome.update(name, metric.unit, spec.size);
    this.host.tabIndex = 0;
    this.host.setAttribute("role", "img");
    this.host.setAttribute("aria-label", `${name} chart. ${this.keyboardHelp()}`);
    this.host.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown");
    this.host.addEventListener("keydown", event => {
      switch (event.key) {
        case "ArrowLeft": case "ArrowRight": case "ArrowUp": case "ArrowDown":
          event.preventDefault(); this.moveObservation(event.key);
          break;
        case "Escape": this.hideHover(); break;
      }
    });
    this.host.addEventListener("dblclick", () => this.resetZoom());
    this.reset.hidden = true; this.retry.hidden = true;
    this.zoomState.hidden = true;
    this.zoomState.title = mode === "preview" ? "Local zoom · double-click the plot to reset" : "Local zoom · double-click the plot or choose Reset zoom in options";
    this.chrome.status.before(this.zoomState);
    this.feedback.hidden = true; this.feedback.setAttribute("role", "status");
    this.feedback.append(this.errorMessage, this.retry);
    this.empty.textContent = "Loading recorded observations…";
    this.announcement.setAttribute("role", "status"); this.announcement.setAttribute("aria-atomic", "true");
    this.element.append(this.chrome.element, this.legend, this.host, this.empty, this.feedback, this.announcement, this.hover.element);
    this.wireHover();
    this.resize = new ResizeObserver(() => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.resizePlot();
      });
    });
    this.resize.observe(this.host);
    window.addEventListener("rvx:theme", () => this.plot?.redraw(true, true), {signal: this.lifetime.signal});
  }
  /** Move through actually plotted coordinates and traces, never hidden duplicate versions. */
  private moveObservation(key: ObservationKey): void {
    let traceIndex = Math.max(0, this.traces.findIndex(trace => trace.series === this.selected?.series));
    let trace = this.traces[traceIndex];
    if (!trace) return;
    const x = this.selected ? this.selected.series.axes[this.selected.index]! : trace.coordinates.axes.at(-1)!;
    let position: number;
    if (key === "ArrowUp" || key === "ArrowDown") {
      traceIndex = Math.max(0, Math.min(this.traces.length - 1, traceIndex + (key === "ArrowDown" ? 1 : -1)));
      trace = this.traces[traceIndex]!;
      position = nearestIndex(trace.coordinates.axes, x);
    } else {
      position = Math.max(0, Math.min(trace.coordinates.axes.length - 1,
        nearestIndex(trace.coordinates.axes, x) + (key === "ArrowRight" ? 1 : -1)));
    }
    this.choose(trace.series, trace.coordinates.indices[position]!);
    this.showKeyboardHover();
  }
  /** Restore keyboard readouts at the selected actual coordinate without taking another navigation step. */
  private showKeyboardHover(): void {
    if (!this.plot || !this.selected) return;
    const trace = this.traces.find(trace => trace.series === this.selected!.series);
    if (!trace) return;
    this.hideHover();
    const axis = trace.series.axes[this.selected.index]!;
    const box = this.plot.over.getBoundingClientRect();
    const px = Math.max(0, Math.min(box.width, this.plot.valToPos(axis / this.axisFactor(), "x")));
    const value = trace.series.values[this.selected.index];
    const y = value == null ? box.height / 2 : Math.max(0, Math.min(box.height, this.plot.valToPos(value, "y")));
    this.renderHover(axis, box.left + px, box.top + y, false);
    this.hoverMode = "keyboard";
    const announcement = this.hover.text;
    if (this.announcement.textContent !== announcement) this.announcement.textContent = announcement;
  }
  /** Restore a nearby editing target after an adjacent chart is removed. */
  focusOptions(): void {this.chrome.trigger.focus();}
  get hasFailure(): boolean {return this.element.classList.contains("chart-failed");}
  /** Route existing feedback through the shared header. */
  private get status(): HTMLElement {return this.chrome.status;}
  /** Keep presentation names separate from immutable metric identities in observations. */
  private displayTitle(): string {return this.spec.presentation?.title ?? this.metrics.map(metricName).join(" / ");}
  /** Preview charts share value navigation without advertising workspace actions. */
  private keyboardHelp(): string {return this.mode === "preview" ? "Use arrow keys to read observations and Run or reporter traces." : chartKeys;}
  /** Apply copied display options in place without changing query data or the user's X zoom. */
  applySpec(spec: ChartSpec): void {
    const before = JSON.stringify(this.spec.presentation);
    const copy = copyChart(spec);
    if (JSON.stringify(copyChart(this.spec)) !== JSON.stringify(copy)) this.hideHover();
    this.spec.path = copy.path; this.spec.size = copy.size;
    if (copy.paths) this.spec.paths = copy.paths; else delete this.spec.paths;
    if (copy.presentation) this.spec.presentation = copy.presentation; else delete this.spec.presentation;
    this.element.dataset.path = copy.path;
    this.setSize(); this.updateLabels(); this.updateLegend();
    if (before !== JSON.stringify(copy.presentation) && this.traces.length) this.draw();
  }
  /** Clear a previous metric's evidence while keeping the preview canvas ready for its next read. */
  prepareMetric(metric: ChartMetric, spec: ChartSpec, runs: ExperimentRun[]): void {
    this.setScope([]); this.metric = metric; this.applySpec(spec);
    this.update(metric, [], runs, this.axis, true); this.showPending();
  }
  /** Refresh accessible and visible titles after metric or presentation changes. */
  private updateLabels(): void {
    const title = this.displayTitle();
    const unit = this.metrics.find(metric => metric.sources.length)?.unit ?? this.metric.unit;
    this.chrome.update(title, unit ?? (this.metrics.length > 1 ? "unit not declared" : null), this.spec.size);
    this.host.setAttribute("aria-label", `${title} chart. ${this.keyboardHelp()}`);
  }
  /** Preserve automatic single-trace decluttering unless the user explicitly chooses legend visibility. */
  private updateLegend(): void {
    const setting = this.spec.presentation?.legend ?? "auto";
    this.legend.hidden = setting === "hide" || setting === "auto" && this.autoHideLegend;
  }
  /** Reflect the chosen width while letting the existing resize observer preserve the plot. */
  setSize(): void {
    const changed = this.element.classList.contains("wide") !== (this.spec.size === "wide");
    this.element.classList.toggle("wide", this.spec.size === "wide");
    this.updateLabels();
    if (changed) this.resizePlot();
  }
  /** Refresh recorded traces in place while preserving explicit observation and zoom choices. */
  update(metric: ChartMetric, series: SnapshotQuerySeries[], runs: ExperimentRun[], axis: string, pending = false): void {
    this.updateCombined([metric], series, runs, axis, pending);
  }
  /** Overlay explicitly compatible fields as individually labelled traces with immutable point provenance. */
  updateCombined(metrics: ChartMetric[], series: SnapshotQuerySeries[], runs: ExperimentRun[], axis: string, pending = false): void {
    const resume = !pending && this.axis === axis && this.hover.visible ? this.hoverMode : null;
    this.hideHover();
    if (!metrics.length) return;
    if (!compatibleMetrics(metrics.filter(metric => metric.sources.length))) {this.fail("These metrics use different units. Edit this panel to separate them."); return;}
    this.pending = pending;
    this.metrics = metrics; this.metric = metrics[0]!;
    this.updateLabels();
    const previous = this.selected;
    this.traces = [];
    this.hoverTraces = [];
    this.legend.replaceChildren();
    for (const [metricIndex, metric] of metrics.entries()) for (const run of runs) {
      const runName = this.labelFor(run);
      const sources = reporters(metric, run.id);
      const items = series.filter(item => item.path === metric.path && item.run_id === run.id && sources.some(source => source.source_id === item.source_id));
      if (!metric.run_ids.includes(run.id) || !sources.length) {
        const label = `${metrics.length > 1 ? `${metricName(metric)} · ` : ""}${runName}`;
        this.addLegend(label, this.colorFor(run.id), pending ? "loading" : "not recorded");
        this.hoverTraces.push({runId: run.id, label, color: this.colorFor(run.id), state: pending ? "loading" : "not recorded", index: -1});
      } else {
        for (const [index, source] of sources.entries()) {
          const trace = items.find(item => item.source_id === source.source_id);
          const reporter = sources.length > 1 ? `${runs.length > 1 || metrics.length > 1 ? `${runName} · ` : ""}${source.label}${sources.filter(s => s.label === source.label).length > 1 ? ` (${source.role} ${index + 1})` : ""}` : runName;
          const label = `${metrics.length > 1 ? `${metricName(metric)} · ` : ""}${reporter}`;
          this.addLegend(label, this.colorFor(run.id), pending && !trace ? "loading" : trace?.values.some(value => value !== null) ? "" : "no numeric values", metricIndex > 0 || index > 0);
          const dash = metricIndex ? [6 + metricIndex * 2, 3, ...(index ? [2, 3] : [])] : index ? [3, 3] : [];
          const item = trace?.axes.length ? {series: trace, metric, runName, label, color: this.colorFor(run.id), dash, coordinates: cursorCoordinates(trace.axes)} : undefined;
          if (item) this.traces.push(item);
          this.hoverTraces.push({runId: run.id, trace: item, label, color: this.colorFor(run.id), state: pending ? "loading" : "no observations in range", index: -1});
        }
      }
    }
    this.status.classList.remove("error-text");
    this.feedback.hidden = true;
    this.element.classList.remove("chart-failed");
    this.hover.setRows(this.hoverTraces.map(item => ({...item, dashed: Boolean(item.trace?.dash.length)})));
    this.retry.hidden = true;
    this.status.textContent = pending ? "Updating…" : "";
    this.status.hidden = !pending;
    this.status.title = "";
    this.autoHideLegend = metrics.length === 1 && runs.length === 1 && reporters(this.metric, runs[0]!.id).length === 1;
    this.updateLegend();
    const unrecorded = metrics.reduce((count, metric) => count + runs.filter(run => !metric.run_ids.includes(run.id)).length, 0);
    if (!pending && this.spec.presentation?.legend === "hide" && unrecorded) {this.status.hidden = false; this.status.textContent = `${unrecorded} not recorded`;}
    if (!pending) this.lastSuccess = Date.now();
    if (pending) delete this.element.dataset.loaded;
    else this.element.dataset.loaded = "true";
    this.empty.hidden = this.traces.some(trace => trace.series.values.some(value => value !== null));
    this.empty.textContent = this.traces.length ? "No numeric values in this range" : "No observations in this range";
    if (this.axis !== axis) {this.plot?.destroy(); this.plot = null; this.zoomed = false;}
    this.axis = axis;
    this.host.hidden = !this.traces.length;
    if (this.traces.length) this.draw();
    this.updateZoom();
    if (previous && this.interacted) {
      const series = this.traces.find(trace => trace.series.path === previous.series.path && trace.series.run_id === previous.series.run_id && trace.series.source_id === previous.series.source_id)?.series;
      // The arithmetic ID is a fast filter; only matching values need exact sidecar comparison.
      const index = series?.snapshot_ids.findIndex((id, index) => id === Number(previous.id) && pointId(series, index) === previous.id) ?? -1;
      if (series && index >= 0) this.choose(series, index, false);
      else {this.selected = null; this.interacted = false;}
    }
    if (!this.interacted) {
      const first = this.traces[0]?.series;
      if (first?.axes.length) this.choose(first, first.axes.length - 1, false);
      else this.selected = null;
    }
    this.restoreHover(resume);
  }
  /** Remove deselected traces immediately while retaining the plot, zoom, and any surviving point. */
  setScope(runs: ExperimentRun[]): void {
    const retained = this.traces.filter(trace => runs.some(run => run.id === trace.series.run_id)).map(trace => trace.series);
    this.updateCombined(this.metrics, retained, runs, this.axis, true);
    if (!retained.length) {
      this.empty.hidden = false;
      this.empty.textContent = runs.length ? "Loading selected runs…" : "Select runs to show observations.";
      this.selected = null;
    }
  }
  /** Show progress for initial, scope-change, or retry reads without flashing every live refresh. */
  beginRead(): void {
    if (this.pending || !this.retry.hidden) {
      this.pending = true;
      this.showPending();
    }
  }
  /** Initial/retry progress never interrupts successfully displayed periodic updates. */
  private showPending(): void {
    if (this.pending) this.hideHover();
    if (!this.pending) return;
    this.status.hidden = false;
    this.status.classList.remove("error-text");
    this.status.textContent = this.traces.length ? "Retrying…" : "Loading…";
    this.retry.hidden = true;
    for (const hint of this.legend.querySelectorAll<HTMLElement>("[data-pending]")) hint.textContent = "loading";
    if (!this.traces.length) {
      this.empty.hidden = false;
      this.empty.textContent = "Loading observations…";
      this.selected = null;
    }
  }
  /** Clear stale evidence for an unindexed field without treating absence as a failed request. */
  unavailable(runs: ExperimentRun[], truncated: boolean): void {
    this.hideHover();
    this.pending = false;
    this.host.hidden = true;
    this.traces = []; this.selected = null; this.interacted = false; this.lastSuccess = 0;
    this.hoverTraces = []; this.hover.setRows([]);
    this.zoomed = false; this.updateZoom(); this.retry.hidden = true; this.feedback.hidden = true;
    this.status.classList.remove("error-text"); this.status.title = "";
    this.status.hidden = false; this.legend.hidden = false;
    this.status.textContent = truncated ? "Unavailable" : "Not recorded";
    this.empty.hidden = false;
    this.empty.textContent = truncated ? "This field is unavailable in the partial catalog." : "No numeric observations recorded for this field.";
    this.legend.replaceChildren();
    for (const run of runs) this.addLegend(this.labelFor(run), this.colorFor(run.id), truncated ? "unavailable" : "not recorded");
    this.autoHideLegend = false; this.updateLegend();
    this.element.dataset.loaded = "true";
  }
  /** Keep the last successful curve visible and expose its age when a refresh fails. */
  fail(message: string): void {
    this.hideHover();
    this.pending = false;
    this.retry.hidden = false;
    this.status.hidden = false;
    this.status.textContent = this.lastSuccess ? "Refresh failed" : "Request failed";
    this.status.classList.add("error-text");
    this.status.title = message;
    this.element.classList.add("chart-failed");
    this.feedback.hidden = false;
    this.errorMessage.textContent = this.lastSuccess ? `Last loaded ${new Date(this.lastSuccess).toLocaleTimeString()} · ${message}` : message;
    if (!this.lastSuccess) {this.empty.hidden = false; this.empty.textContent = message;}
  }
  /** Pair stable run hues with explicit reporter or availability labels. */
  private addLegend(name: string, color: string, state: string, dashed = false): void {
    const item = el("span", `legend-item${dashed ? " dashed" : ""}`);
    item.style.setProperty("--run-color", color);
    item.append(el("i", "legend-swatch"), el("span", "", name));
    if (state) {
      const hint = el("span", "muted", state);
      if (state === "loading") hint.dataset.pending = "true";
      item.append(hint);
    }
    this.legend.append(item);
  }
  /** Keep keyboard and pointer selection tied to a real stored point. */
  private choose(series: SnapshotQuerySeries, index: number, interacted = true): void {
    if (index < 0 || !series.snapshot_ids[index]) return;
    if (interacted) this.interacted = true;
    if (interacted && this.selected?.series === series && this.selected.index === index) return;
    this.selected = {id: pointId(series, index), series, index};
  }
  /** Only differing coordinates need a row annotation; equal elapsed positions are not wall-time claims. */
  private pointText(trace: Trace, index: number, reference: number): {value: string; time: string; id: string} {
    const {series, metric} = trace, value = series.values[index];
    const coordinate = series.axes[index]!;
    let time = "";
    if (coordinate !== reference) {
      const label = this.coordinateText(coordinate, reference);
      // Repeated local clocks or sub-millisecond coordinates still must not look simultaneous.
      time = this.axis === "wall_time" && label === this.coordinateText(reference, reference)
        ? `${coordinate > reference ? "+" : "−"}${elapsedTick(Math.abs(coordinate - reference) / 1e9)}`
        : `at ${label}`;
    }
    return {
      value: `${value === null ? "null" : value === undefined ? "missing" : formatNumber(value)}${typeof value === "number" && metric.unit ? ` ${metric.unit}` : ""}`,
      time,
      id: pointId(series, index),
    };
  }
  /** Share one readable X coordinate and shorten per-row clocks only within that same local date. */
  private coordinateText(value: number, reference?: number): string {
    if (this.axis === "elapsed") return elapsedTick(value / 1e9);
    if (this.axis !== "wall_time") return String(value);
    const ms = value / 1e6, date = new Date(ms);
    const sameDay = reference !== undefined && date.toDateString() === new Date(reference / 1e6).toDateString();
    return `${sameDay ? "" : `${shortDate.format(ms)} · `}${date.getMilliseconds() ? preciseClock.format(ms) : shortClock.format(ms)}`;
  }
  /** Convert plotted seconds back to native nanoseconds only for time-based axes. */
  private axisFactor(): number {return this.axis === "wall_time" || this.axis === "elapsed" ? 1e9 : 1;}
  /** Cancel pending pointer work and release transient readout state independently of selection. */
  private hideHover(): void {
    cancelAnimationFrame(this.hoverFrame); this.hoverFrame = 0; this.plotBox = null;
    this.hoverMode = null;
    this.hover.hide(); this.host.removeAttribute("aria-describedby");
  }
  /** Restore a still-active readout after data or geometry changes without requiring another pointer move. */
  private restoreHover(mode: HoverMode): void {
    if (mode === "pointer") this.queueHover(this.pointerX, this.pointerY);
    else if (mode === "keyboard" && document.activeElement === this.host) this.showKeyboardHover();
  }
  /** Native scrolling and plot zoom keep their gestures; touch only pins a completed tap. */
  private wireHover(): void {
    const signal = this.lifetime.signal;
    this.host.addEventListener("pointerdown", event => {
      this.hideHover();
      if (event.pointerType === "touch") this.touch = {x: event.clientX, y: event.clientY, moved: false};
    }, {signal});
    this.host.addEventListener("pointermove", event => {
      if (event.pointerType === "touch") {
        if (this.touch && Math.hypot(event.clientX - this.touch.x, event.clientY - this.touch.y) > 8) this.touch.moved = true;
        return;
      }
      if (!event.buttons) this.queueHover(event.clientX, event.clientY);
    }, {signal});
    this.host.addEventListener("pointerup", event => {
      if (event.pointerType !== "touch" || this.touch && !this.touch.moved) this.queueHover(event.clientX, event.clientY);
      this.touch = null;
    }, {signal});
    this.host.addEventListener("pointercancel", () => {this.touch = null; this.hideHover();}, {signal});
    this.host.addEventListener("pointerleave", event => {
      if (event.pointerType !== "touch" && this.hoverMode !== "keyboard") this.hideHover();
    }, {signal});
    this.host.addEventListener("blur", () => this.hideHover(), {signal});
    document.addEventListener("pointerdown", event => {
      if (event.target instanceof Node && !this.host.contains(event.target)) this.hideHover();
    }, {capture: true, signal});
    document.addEventListener("visibilitychange", () => this.hideHover(), {signal});
    window.addEventListener("scroll", () => this.hideHover(), {capture: true, signal});
    window.addEventListener("resize", () => {
      const resume = this.hover.visible ? this.hoverMode : null;
      this.hideHover(); this.restoreHover(resume);
    }, {signal});
  }
  /** Batch all traces into one animation frame and cache plot geometry until it can change. */
  private queueHover(x: number, y: number): void {
    if (!this.plot || this.chrome.menuOpen || this.host.hidden) return;
    this.pointerX = x; this.pointerY = y;
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const plot = this.plot;
      if (!plot || this.chrome.menuOpen) return;
      const box = this.plotBox ??= plot.over.getBoundingClientRect();
      const left = this.pointerX - box.left, top = this.pointerY - box.top;
      if (left < 0 || left > box.width || top < 0 || top > box.height) {this.hideHover(); return;}
      this.renderHover(plot.posToVal(left, "x") * this.axisFactor(), this.pointerX, this.pointerY, true, left, top);
      this.hoverMode = "pointer";
    });
  }
  /** Sample actual per-trace coordinates, keeping null observations separate from absent series. */
  private renderHover(x: number, pointerX: number, pointerY: number, choose: boolean, left = 0, top = 0): void {
    const plot = this.plot; if (!plot) return;
    let nearest: HoverTrace | undefined, missing: HoverTrace | undefined;
    let distance = Infinity, missingDistance = Infinity;
    const width = plot.over.clientWidth, height = plot.over.clientHeight;
    for (const item of this.hoverTraces) {
      const trace = item.trace; if (!trace) continue;
      if (x < trace.coordinates.axes[0]! || x > trace.coordinates.axes.at(-1)!) {item.index = -1; continue;}
      const index = trace.coordinates.indices[nearestIndex(trace.coordinates.axes, x)]!;
      item.index = index;
      if (!choose) continue;
      const value = trace.series.values[index];
      const px = plot.valToPos(trace.series.axes[index]! / this.axisFactor(), "x");
      if (px < 0 || px > width) continue;
      const horizontal = Math.abs(px - left);
      if (value == null) {
        if (horizontal < missingDistance) {missing = item; missingDistance = horizontal;}
      } else {
        const py = plot.valToPos(value, "y");
        if (py < 0 || py > height) continue;
        const next = horizontal + Math.abs(py - top) * .25;
        if (next < distance) {nearest = item; distance = next;}
      }
    }
    const candidate = nearest ?? missing;
    if (candidate?.trace) this.choose(candidate.trace.series, candidate.index);
    const selectedRow = this.hoverTraces.findIndex(item => item.trace?.series === this.selected?.series && item.index === this.selected?.index);
    const referenceTrace = selectedRow >= 0 ? this.hoverTraces[selectedRow] : this.hoverTraces.find(item => item.trace && item.index >= 0);
    const reference = referenceTrace?.trace ? referenceTrace.trace.series.axes[referenceTrace.index]! : x;
    this.hover.focus(selectedRow);
    const axisTitle = this.axis === "elapsed" ? "Elapsed" : this.axis === "wall_time" ? "" : axisLabel(this.axis);
    this.hover.setCoordinate(`${axisTitle ? `${axisTitle} · ` : ""}${this.coordinateText(reference)}`, reference);
    for (const row of this.hover.visibleIndices) {
      const item = this.hoverTraces[row]!, trace = item.trace;
      const selected = Boolean(trace && this.selected?.series === trace.series && this.selected.index === item.index);
      this.hover.update(row, item.index, selected, () => {
        if (!trace) return {value: item.state === "no observations in range" ? "no data" : item.state, time: ""};
        if (item.index < 0) return {value: "outside span", time: ""};
        return this.pointText(trace, item.index, reference);
      });
    }
    this.hover.show(pointerX, pointerY);
    this.host.setAttribute("aria-describedby", this.hover.element.id);
  }
  /** Keep the contextual reset action and compact zoom indicator in agreement. */
  private updateZoom(): void {
    this.reset.hidden = this.zoomState.hidden = !this.zoomed || !this.traces.length;
  }
  /** Reuse uPlot across refreshes and trace changes, restoring an explicit zoom after updates. */
  private draw(): void {
    const data = alignedData(this.traces.map(trace => trace.series), this.axis);
    const signature = JSON.stringify([this.traces.map(trace => [trace.series.path, trace.series.run_id, trace.series.source_id, trace.color]), this.spec.presentation?.style, this.spec.presentation?.lineWidth, this.spec.presentation?.points]);
    if (!this.plot) {
      const color = (name: string): string => getComputedStyle(this.element).getPropertyValue(name).trim();
      this.host.replaceChildren();
      this.plot = new uPlot({
        width: Math.max(180, this.host.clientWidth), height: this.height(),
        padding: [8, () => this.axisRightPadding, 0, 0],
        legend: {show: false},
        cursor: {drag: {x: true, y: false, dist: 6}, points: {size: 6}},
        scales: {x: {time: this.axis === "wall_time"}, y: {range: (_plot, min, max) => this.yRange(min, max)}},
        axes: [
          {font: axisFont, size: (plot, values) => this.xAxisSize(plot, values), gap: 5, space: 80, lineGap: 1.5, stroke: () => color("--muted"), grid: {show: false}, ticks: {show: false},
            ...(this.axis === "elapsed" ? {incrs: elapsedIncrements, values: (_u: uPlot, splits: number[]) => splits.map(elapsedTick)} : {})},
          {font: axisFont, size: (plot, values) => {
            plot.ctx.save(); plot.ctx.font = axisFont;
            let width = 46;
            for (const label of values ?? []) width = Math.max(width, plot.ctx.measureText(label ?? "").width + 10);
            plot.ctx.restore(); return Math.ceil(width);
          }, gap: 6, space: 36, stroke: () => color("--muted"),
            values: (_u, values) => values.map(formatNumber), grid: {stroke: () => color("--chart-line"), width: 1}, ticks: {show: false}},
        ],
        series: [{}, ...this.traces.map(trace => this.plotSeries(trace))],
        hooks: {setSelect: [plot => {
          // uPlot commits valid selections even when mouseup occurs outside this chart.
          if (plot.select.width >= 6) {this.zoomed = true; this.updateZoom(); this.hideHover();}
        }], setScale: [(plot, scale) => {
          if (scale !== "x") return;
          const {min, max} = plot.scales.x!;
          if (min === undefined || max === undefined) return;
          const label = (value: number): string => this.axis === "elapsed" ? duration(value * 1e9) : this.axis === "wall_time" ? formatTime(value * 1e9) : formatNumber(value);
          this.host.setAttribute("aria-description", `${axisLabel(this.axis)}: ${label(min)} to ${label(max)}.`);
        }]},
      }, data, this.host);
      this.signature = signature;
    } else {
      const plot = this.plot, min = plot.scales.x!.min, max = plot.scales.x!.max;
      plot.batch(() => {
        if (this.signature !== signature) {
          while (plot.series.length > 1) plot.delSeries(1);
          this.traces.forEach(trace => plot.addSeries(this.plotSeries(trace)));
          this.signature = signature;
        }
        plot.setData(data);
        if (this.zoomed && min !== undefined && max !== undefined) plot.setScale("x", {min, max});
      });
    }
  }
  /** Apply display-color changes to curves, legends and hover rows without changing data freshness. */
  refreshColors(): void {
    const resume = this.hover.visible ? this.hoverMode : null;
    this.hideHover();
    for (const trace of this.traces) trace.color = this.colorFor(trace.series.run_id);
    this.hoverTraces.forEach((item, index) => {
      item.color = this.colorFor(item.runId);
      const legend = this.legend.children[index];
      if (legend instanceof HTMLElement) legend.style.setProperty("--run-color", item.color);
    });
    this.hover.setRows(this.hoverTraces.map(item => ({...item, dashed: Boolean(item.trace?.dash.length)})));
    if (this.traces.length) this.draw();
    this.restoreHover(resume);
  }
  /** Native wall-time ticks contain extra date lines; reserve their paint and keep the plot height. */
  private xAxisSize(plot: uPlot, values: string[] | null): number {
    let lines = 1;
    this.axisRightPadding = 10;
    if (this.axis === "wall_time" && values) {
      let last: string | undefined;
      for (const value of values) if (value != null) {
        last = String(value); lines = Math.max(lines, last.split("\n").length);
      }
      if (last != null) {
        plot.ctx.save(); plot.ctx.font = axisFont;
        for (const line of String(last).split("\n")) this.axisRightPadding = Math.max(this.axisRightPadding, Math.ceil(plot.ctx.measureText(line).width / 2 + 4));
        plot.ctx.restore();
      }
    }
    const size = Math.max(28, Math.ceil(5 + 11 + (lines - 1) * 11 * 1.5 + 6));
    const extra = `${size - 28}px`;
    if (this.host.style.getPropertyValue("--chart-axis-extra") !== extra) this.host.style.setProperty("--chart-axis-extra", extra);
    return size;
  }
  /** Keep reporters visually distinct without implying aggregation or connecting null gaps. */
  private plotSeries(trace: Trace): uPlot.Series {
    const display = this.spec.presentation;
    return {label: trace.label, stroke: trace.color, width: display?.lineWidth ?? 1.8, dash: trace.dash,
      ...(display?.style === "area" ? {fill: `${trace.color}24`, fillTo: 0} : {}),
      points: {show: display?.points ?? this.traces.every(item => item.series.axes.length <= 2), size: 5}, spanGaps: false};
  }
  /** Apply explicit finite Y bounds without transforming or discarding any stored values. */
  private yRange(min: number, max: number): [number, number] {
    const auto = Number.isFinite(min) && Number.isFinite(max) ? uPlot.rangeNum(min, max, .1, true) : [0, 1];
    let lower = this.spec.presentation?.yMin ?? auto[0] ?? 0, upper = this.spec.presentation?.yMax ?? auto[1] ?? 1;
    if (lower >= upper) {
      if (this.spec.presentation?.yMin === undefined) lower = upper - Math.max(Math.abs(upper) * .1, 1);
      else upper = lower + Math.max(Math.abs(lower) * .1, 1);
    }
    return [lower, upper];
  }
  /** Restore the queried range after the user finishes a local zoom investigation. */
  resetZoom(): void {
    this.hideHover(); this.zoomed = false; this.updateZoom();
    if (this.plot) this.plot.setData(alignedData(this.traces.map(trace => trace.series), this.axis));
  }
  /** Reconcile explicit size actions immediately and skip redundant observer redraws. */
  private resizePlot(): void {
    if (!this.plot || this.host.hidden || this.host.clientWidth === 0) return;
    const width = Math.max(180, this.host.clientWidth), height = this.height();
    if (this.plot.width !== width || this.plot.height !== height) {
      const resume = this.hover.visible ? this.hoverMode : null;
      this.hideHover(); this.plot.setSize({width, height}); this.restoreHover(resume);
    }
  }
  /** Use the CSS-owned plot height at every breakpoint, including hidden-but-mounted charts. */
  private height(): number {return Number.parseFloat(getComputedStyle(this.host).height);}
  /** Release canvas, observer, listener, and observation references when a card is removed. */
  destroy(): void {
    this.hideHover(); this.hover.destroy();
    this.chrome.destroy();
    this.lifetime.abort(); this.resize.disconnect(); cancelAnimationFrame(this.frame); this.plot?.destroy();
    this.traces = []; this.hoverTraces = []; this.selected = null;
  }
}
