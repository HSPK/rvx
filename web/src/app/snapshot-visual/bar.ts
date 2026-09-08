import type {SnapshotAggregateGroup, SnapshotAggregateResponse, SnapshotAggregateSeries, SnapshotAggregateValue, SnapshotBarView} from "../../domain/snapshot-views";
import type {TableSource} from "../../domain/tables";
import {el} from "../ui";
import {cellText, finiteNumber, provenance, type Readout, type VisualNames, type VisualTooltip} from "./details";

interface Segment {start: number; end: number; value: number | null}
export interface BarGeometry {minimum: number; maximum: number; segments: Map<string, Segment>}
interface Owner {key: string; run: string; source: string; snapshot: TableSource | undefined; tone: number}
interface Mark {title: string; rows: Readout}
const maximumTraces = 64, maximumMarks = 2400;

/** Map count to its pathless native measure, retaining explicit field order for other aggregations. */
export function barMeasures(view: SnapshotBarView): {id: string; path?: string}[] {
  return view.aggregation === "count" ? [{id: "count"}] : view.valuePaths.map((path, index) => ({id: `m${index}`, path}));
}

/** Key geometry by category, publisher and field rather than merging Run observations. */
function segmentKey(group: string, series: Pick<SnapshotAggregateSeries, "run_id" | "source_id">, measure: string): string {
  return JSON.stringify([group, series.run_id, series.source_id, measure]);
}

/** Normalize before stacking to prevent finite large numbers from overflowing their chart domain. */
export function barGeometry(groups: SnapshotAggregateGroup[], view: SnapshotBarView): BarGeometry {
  const measures = barMeasures(view), segments = new Map<string, Segment>();
  let magnitude = 0, minimum = 0, maximum = 0;
  for (const group of groups) for (const series of group.series) for (const measure of measures) {
    const value = finiteNumber(series.measures[measure.id]?.value);
    if (value !== null) magnitude = Math.max(magnitude, Math.abs(value));
  }
  for (const group of groups) for (const series of group.series) {
    let positive = 0, negative = 0;
    for (const measure of measures) {
      const value = finiteNumber(series.measures[measure.id]?.value), scaled = value === null || !magnitude ? 0 : value / magnitude;
      const start = view.layout !== "stacked" ? 0 : scaled < 0 ? negative : positive;
      const end = start + scaled;
      if (view.layout === "stacked" && value !== null) {if (scaled < 0) negative = end; else positive = end;}
      minimum = Math.min(minimum, end); maximum = Math.max(maximum, end);
      segments.set(segmentKey(group.key, series, measure.id), {start, end, value});
    }
  }
  return {minimum, maximum: maximum === minimum ? maximum + 1 : maximum, segments};
}

/** Keep a run's base color while distinguishing reporter/field traces with tone and texture. */
export function tracePaint(color: string, tone: number): string {
  return tone % 8 === 0 ? color : `color-mix(in srgb, ${color} ${100 - tone % 8 * 6}%, var(--surface))`;
}

/** Render global native category tuples as bounded, exact-labelled bars with separate publisher lanes. */
export class SnapshotBars {
  readonly element = el("div", "sv-bars");
  private legend = el("div", "sv-bar-legend");
  private viewport = el("div", "sv-bar-viewport");
  private chart = el("div", "sv-bar-chart");
  private marks = new Map<string, Mark>();
  private lifetime = new AbortController();
  private data: SnapshotAggregateResponse | null = null;
  private view: SnapshotBarView | null = null;

  /** Delegate hover/touch/keyboard readouts instead of registering one listener per rectangle. */
  constructor(private names: VisualNames, private tooltip: VisualTooltip) {
    this.legend.setAttribute("aria-label", "Run, Source and value fields");
    this.viewport.setAttribute("role", "region"); this.viewport.setAttribute("aria-label", "Current snapshot bars"); this.viewport.tabIndex = 0;
    this.viewport.append(this.chart); this.element.append(this.legend, this.viewport);
    const signal = this.lifetime.signal;
    this.element.addEventListener("pointerover", event => this.readout(event.target), {signal});
    this.element.addEventListener("focusin", event => this.readout(event.target), {signal});
    this.element.addEventListener("click", event => this.readout(event.target), {signal});
    this.element.addEventListener("pointerleave", () => this.tooltip.hide(), {signal});
    this.element.addEventListener("focusout", event => {if (!(event.relatedTarget instanceof Node) || !this.element.contains(event.relatedTarget)) this.tooltip.hide();}, {signal});
    this.element.addEventListener("keydown", event => this.navigate(event), {signal});
  }

  /** Reject overwhelming scopes explicitly instead of silently dropping sources or value fields. */
  setData(data: SnapshotAggregateResponse, view: SnapshotBarView): void {
    const sources = new Set(data.groups.flatMap(group => group.series.map(series => JSON.stringify([series.run_id, series.source_id]))));
    const traces = sources.size * barMeasures(view).length, marks = data.groups.length * traces;
    if (traces > maximumTraces || marks > maximumMarks) {
      throw new Error(`${sources.size} Sources × ${barMeasures(view).length} fields × ${data.groups.length} categories exceeds this bar view's ${maximumTraces}-trace / ${maximumMarks}-mark limit. Select fewer Runs, Sources, fields or categories.`);
    }
    this.data = data; this.view = view; this.render();
  }

  /** Repaint presentation-only changes without replacing successful aggregate data. */
  applyView(view: SnapshotBarView): void {this.view = view; if (this.data) this.render();}

  /** Resolve unique publisher lanes and deterministic tones independent of response iteration order. */
  private owners(data: SnapshotAggregateResponse): Owner[] {
    const owners = new Map<string, Owner>(), snapshots = new Map(data.snapshots.map(source => [source.snapshot_id, source]));
    for (const group of data.groups) for (const series of group.series) {
      const key = JSON.stringify([series.run_id, series.source_id]);
      owners.set(key, {key, run: series.run_id, source: series.source_id, snapshot: snapshots.get(series.snapshot_id), tone: 0});
    }
    const result = [...owners.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), perRun = new Map<string, number>();
    for (const owner of result) {owner.tone = perRun.get(owner.run) ?? 0; perRun.set(owner.run, owner.tone + 1);}
    return result;
  }

  /** Rebuild only bounded categorical marks, restoring the selected exact-value control after refresh. */
  private render(): void {
    const data = this.data, view = this.view; if (!data || !view) return;
    const selected = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.svMark : undefined;
    const top = this.viewport.scrollTop, left = this.viewport.scrollLeft;
    this.tooltip.hide(); this.marks.clear();
    this.element.dataset.orientation = view.orientation; this.element.dataset.layout = view.layout;
    const owners = this.owners(data), measures = barMeasures(view), geometry = barGeometry(data.groups, view);
    this.element.classList.toggle("sv-single-owner", owners.length === 1);
    const legend = document.createDocumentFragment();
    for (const owner of owners) for (const [index, measure] of measures.entries()) {
      const item = el("span", "sv-trace-legend"), swatch = el("i", "sv-trace-swatch");
      this.paint(swatch, owner, index);
      const field = measure.path !== undefined ? this.names.fieldName(measure.path) : "Count";
      item.append(swatch, el("span", "", owners.length === 1 ? field : `${this.names.runName(owner.run)} · ${owner.snapshot?.label ?? owner.source} · ${field}`));
      item.title = `Source ${owner.source}${measure.path !== undefined ? ` · ${measure.path || "(root)"}` : ""}`; legend.append(item);
    }
    this.legend.replaceChildren(legend);
    const fragment = document.createDocumentFragment();
    for (const group of data.groups) {
      const category = el("section", "sv-bar-category");
      const categoryText = group.cells.map(cell => cellText(cell)).join(" · ");
      const heading = el("h3", "sv-category-label", categoryText); heading.title = categoryText;
      category.append(heading);
      const lanes = el("div", "sv-bar-lanes");
      for (const owner of owners) {
        const series = group.series.find(series => series.run_id === owner.run && series.source_id === owner.source);
        const rows = view.layout === "stacked" ? [measures] : measures.map(measure => [measure]);
        for (const rowMeasures of rows) {
          const lane = el("div", "sv-bar-lane"), values = el("div", "sv-bar-values");
          const label = el("span", "sv-bar-source", `${this.names.runName(owner.run)} · ${owner.snapshot?.label ?? owner.source}`);
          label.title = `Source ${owner.source}`;
          const svg = this.svg("svg"); svg.classList.add("sv-bar-track");
          svg.setAttribute("viewBox", "0 0 1000 200"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
          const zero = (0 - geometry.minimum) / (geometry.maximum - geometry.minimum);
          const baseline = this.svg("line");
          const vertical = view.orientation === "vertical";
          baseline.setAttribute("x1", String(vertical ? 0 : zero * 1000)); baseline.setAttribute("x2", String(vertical ? 1000 : zero * 1000));
          baseline.setAttribute("y1", String(vertical ? (1 - zero) * 200 : 0)); baseline.setAttribute("y2", String(vertical ? (1 - zero) * 200 : 200));
          baseline.classList.add("sv-bar-zero"); svg.append(baseline);
          for (const measure of rowMeasures) {
            const index = measures.findIndex(item => item.id === measure.id), aggregate = series?.measures[measure.id];
            const key = JSON.stringify([group.key, owner.key, measure.id]), name = measure.path !== undefined ? this.names.fieldName(measure.path) : "Count";
            const value = aggregate ? cellText(aggregate.value, view.decimals) : series ? "missing" : "not recorded";
            const unit = view.unit ? ` ${view.unit}` : "";
            const button = el("button", "sv-bar-value"); button.type = "button"; button.dataset.svMark = key;
            button.dataset.kind = aggregate?.value.kind ?? (series ? "missing" : "not-recorded");
            const swatch = el("i", "sv-trace-swatch"); this.paint(swatch, owner, index);
            const readout = el("span", "");
            if (measures.length > 1) readout.append(el("span", "sv-bar-value-label", `${name}: `));
            readout.append(`${value}${unit}`);
            button.append(swatch, readout);
            button.setAttribute("aria-label", `${categoryText} · ${this.names.runName(owner.run)} · Source ${owner.snapshot?.label ?? owner.source} · ${name}: ${value}${unit}`);
            values.append(button);
            this.marks.set(key, {title: categoryText, rows: this.markRows(owner, name, aggregate, series, view)});
            const segment = series ? geometry.segments.get(segmentKey(group.key, series, measure.id)) : undefined;
            if (!segment || segment.value === null) continue;
            const start = (Math.min(segment.start, segment.end) - geometry.minimum) / (geometry.maximum - geometry.minimum);
            const length = Math.abs(segment.end - segment.start) / (geometry.maximum - geometry.minimum);
            const rect = this.svg("rect"); rect.dataset.svMark = key; rect.dataset.run = owner.run; rect.dataset.source = owner.source; rect.dataset.field = measure.id;
            rect.dataset.value = aggregate!.value.text; rect.dataset.start = String(segment.start); rect.dataset.end = String(segment.end);
            rect.setAttribute("x", String(vertical ? 100 : Math.min(999, start * 1000))); rect.setAttribute("y", String(vertical ? Math.min(199, Math.max(0, 1 - start - length) * 200) : 35));
            rect.setAttribute("width", String(vertical ? 800 : Math.max(1, length * 1000))); rect.setAttribute("height", String(vertical ? Math.max(1, length * 200) : 130));
            const trace = owner.tone * measures.length + index, pattern = Math.floor(trace / 8);
            rect.setAttribute("fill", tracePaint(this.names.colorFor(owner.run), trace));
            if (pattern) {rect.setAttribute("stroke", this.names.colorFor(owner.run)); rect.setAttribute("stroke-dasharray", `${pattern + 1} 2`); rect.setAttribute("stroke-width", "2");}
            svg.append(rect);
          }
          lane.append(label, svg, values); lanes.append(lane);
        }
      }
      category.append(lanes); fragment.append(category);
    }
    if (!data.groups.length) fragment.append(el("p", "sv-empty muted", "No categories match this snapshot query."));
    this.chart.replaceChildren(fragment); this.viewport.scrollTop = top; this.viewport.scrollLeft = left;
    if (selected) [...this.chart.querySelectorAll<HTMLButtonElement>("button[data-sv-mark]")].find(node => node.dataset.svMark === selected)?.focus({preventScroll: true});
  }

  /** Keep exact aggregate values and compact accounting beside immutable Source provenance. */
  private markRows(owner: Owner, field: string, aggregate: SnapshotAggregateValue | undefined, series: SnapshotAggregateSeries | undefined, view: SnapshotBarView): Readout {
    const numeric = aggregate ? finiteNumber(aggregate.value) : null;
    return [[field, aggregate ? cellText(aggregate.value) + (view.unit ? ` ${view.unit}` : "") : series ? "missing" : "not recorded"],
      ...provenance(owner.run, owner.source, owner.snapshot, this.names),
      ["Aggregation", view.aggregation],
      ...(aggregate ? [["Accounting", `${aggregate.count} counted · ${aggregate.missing} missing · ${aggregate.non_numeric} nonnumeric${aggregate.approximate ? " · approximate" : ""}`] as [string, string]] : []),
      ...(aggregate?.value.kind === "number" && numeric === null ? [["Geometry", "Outside finite numeric range; exact value retained"] as [string, string]] : [])];
  }

  /** Paint reusable legend/value swatches with the same Run/Source/field encoding as their bars. */
  private paint(swatch: HTMLElement, owner: Owner, fieldIndex: number): void {
    const trace = owner.tone * (this.view?.aggregation === "count" ? 1 : this.view?.valuePaths.length ?? 1) + fieldIndex, pattern = Math.floor(trace / 8);
    swatch.style.setProperty("--sv-color", tracePaint(this.names.colorFor(owner.run), trace));
    swatch.classList.toggle("sv-pattern", pattern > 0);
    if (pattern) swatch.style.backgroundImage = `repeating-linear-gradient(${pattern * 22.5}deg, transparent 0 2px, #ffffffa0 2px 3px)`;
  }

  /** Construct local SVG elements without interpolating publisher strings into markup. */
  private svg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
    return document.createElementNS("http://www.w3.org/2000/svg", tag);
  }

  /** Look up only one hovered mark; no dataset traversal occurs on pointer movement. */
  private readout(target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLElement>("[data-sv-mark]"), mark = anchor ? this.marks.get(anchor.dataset.svMark ?? "") : undefined;
    if (anchor && mark) this.tooltip.show(anchor, mark.title, mark.rows);
  }

  /** Offer arrow-key traversal through exact value buttons as well as ordinary native Tab navigation. */
  private navigate(event: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key) || !(event.target instanceof HTMLButtonElement)) return;
    const buttons = [...this.chart.querySelectorAll<HTMLButtonElement>("button[data-sv-mark]")], index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1)))]?.focus();
  }

  /** Recolor existing data without issuing any metadata or aggregate requests. */
  refreshColors(): void {if (this.data) this.render();}

  /** Empty stale scope data before a replacement collection is requested. */
  clear(): void {this.data = null; this.marks.clear(); this.tooltip.hide(); this.chart.replaceChildren(); this.legend.replaceChildren();}

  /** Release delegated listeners, aggregate references and hover state with the panel. */
  destroy(): void {this.lifetime.abort(); this.clear();}
}
