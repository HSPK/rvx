import {uiIdentifier} from "../core/identifiers";
import {el} from "./ui";

export interface HoverLabel {label: string; color: string; dashed?: boolean}
interface HoverRow {element: HTMLElement; value: HTMLElement; time: HTMLElement; index: number; selected: boolean; context: number}

/** Keep a pointer-adjacent readout in the native top layer, including inside modal previews. */
export class ChartHover {
  readonly element = el("div", "chart-tooltip");
  private labels: HoverLabel[] = [];
  private rows = new Map<number, HoverRow>();
  private indices: number[] = [];
  private start = 0;
  private dirty = true;
  private width = 0;
  private height = 0;
  private heading = el("span", "chart-tooltip-heading");
  private count = el("span", "chart-tooltip-count");
  private coordinate = NaN;
  private context = 0;

  /** Allocate one owned top-layer surface without attaching it outside the chart's lifetime. */
  constructor() {
    this.element.id = uiIdentifier("chart-hover");
    this.element.popover = "manual";
    this.element.setAttribute("role", "tooltip");
    this.element.setAttribute("aria-label", "Chart values");
  }
  /** Retain trace metadata while mounting only the bounded row window. */
  setRows(labels: HoverLabel[]): void {
    this.hide();
    this.labels = labels;
    const count = this.capacity();
    this.rebuild(Math.min(this.start, Math.max(0, labels.length - count)), count);
  }
  /** Keep the selected trace visible while fitting short screens and avoiding an unscrollable wall of rows. */
  focus(index: number): void {
    const count = this.capacity();
    let start = Math.min(this.start, Math.max(0, this.labels.length - count));
    if (index >= 0 && (index < start || index >= start + count)) start = Math.max(0, Math.min(index - Math.floor(count / 2), this.labels.length - count));
    if (start !== this.start || count !== this.rows.size) this.rebuild(start, count);
  }
  /** Expose only rendered rows so pointer movement does not format hidden traces. */
  get visibleIndices(): readonly number[] {return this.indices;}
  /** Report visibility independently of the last selected snapshot. */
  get visible(): boolean {return this.element.matches(":popover-open");}
  /** A shared actual X label only invalidates differing row annotations when that coordinate changes. */
  setCoordinate(text: string, coordinate: number): void {
    if (coordinate !== this.coordinate) {this.coordinate = coordinate; this.context++;}
    if (this.heading.textContent !== text) {this.heading.textContent = text; this.dirty = true;}
  }
  /** Reserve space for wrapped names, observation times and the explicit overflow count. */
  private capacity(): number {
    return Math.min(this.labels.length, Math.max(1, Math.min(12, Math.floor(((window.visualViewport?.height ?? innerHeight) - 60) / 72))));
  }
  /** Replace a small row window only when labels or the selected trace leave its existing bounds. */
  private rebuild(start: number, count: number): void {
    this.start = start; this.rows.clear(); this.indices = [];
    for (let index = start; index < start + count; index++) {
      const label = this.labels[index]!;
      const element = el("div", `chart-tooltip-row${label.dashed ? " dashed" : ""}`);
      element.setAttribute("role", "group");
      element.dataset.traceIndex = String(index);
      element.style.setProperty("--run-color", label.color);
      const name = el("span", "chart-tooltip-label", label.label);
      const value = el("strong", "chart-tooltip-value"), time = el("span", "chart-tooltip-time");
      element.append(el("i", "legend-swatch"), name, value, time);
      this.rows.set(index, {element, value, time, index: -2, selected: false, context: -1}); this.indices.push(index);
    }
    this.count.textContent = count < this.labels.length ? `${start + 1}–${start + count}/${this.labels.length} · ↑↓` : "";
    this.count.hidden = count >= this.labels.length;
    this.count.setAttribute("aria-label", `Traces ${start + 1} through ${start + count} of ${this.labels.length}. Use up/down for other traces.`);
    const header = el("div", "chart-tooltip-header"); header.append(this.heading, this.count);
    this.element.replaceChildren(header, ...[...this.rows.values()].map(row => row.element));
    this.dirty = true;
  }
  /** Call only when the actual coordinate changes; pointer-only moves do not rewrite content. */
  update(rowIndex: number, index: number, selected: boolean, content: () => {value: string; time: string; id?: string}): void {
    const row = this.rows.get(rowIndex);
    if (!row) return;
    if (row.index !== index || row.context !== this.context) {
      const text = content();
      if (row.value.textContent !== text.value) {row.value.textContent = text.value; this.dirty = true;}
      if (row.time.textContent !== text.time) {row.time.textContent = text.time; this.dirty = true;}
      if (text.id) {
        if (row.element.dataset.snapshotId !== text.id) row.element.dataset.snapshotId = text.id;
      } else delete row.element.dataset.snapshotId;
      row.index = index; row.context = this.context;
    }
    if (row.selected !== selected) {
      row.element.classList.toggle("is-selected", selected);
      row.element.setAttribute("aria-label", selected ? "Selected trace" : "Trace");
      row.selected = selected;
    }
  }
  /** Move a measured readout beside the cursor and flip it before crossing viewport edges. */
  show(x: number, y: number): void {
    if (!this.element.isConnected) return;
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width ?? innerWidth, viewportHeight = viewport?.height ?? innerHeight;
    const maximumWidth = `${Math.max(0, Math.min(380, viewportWidth - 16))}px`, maximumHeight = `${Math.max(0, viewportHeight - 16)}px`;
    if (this.element.style.maxWidth !== maximumWidth || this.element.style.maxHeight !== maximumHeight) {
      this.element.style.maxWidth = maximumWidth; this.element.style.maxHeight = maximumHeight; this.dirty = true;
    }
    if (!this.element.matches(":popover-open")) {this.element.showPopover(); this.dirty = true;}
    if (this.dirty) {
      const box = this.element.getBoundingClientRect();
      this.width = box.width; this.height = box.height; this.dirty = false;
    }
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const right = left + viewportWidth, bottom = top + viewportHeight;
    const px = x + 16 + this.width <= right - 8 ? x + 16 : x - this.width - 16;
    const py = y + 16 + this.height <= bottom - 8 ? y + 16 : y - this.height - 16;
    this.element.style.transform = `translate(${Math.max(left + 8, Math.min(px, right - this.width - 8))}px, ${Math.max(top + 8, Math.min(py, bottom - this.height - 8))}px)`;
  }
  /** Announce the selected trace and its visible neighbors rather than thousands of hidden rows. */
  get text(): string {
    return `${this.heading.textContent}. ` + [...this.rows.values()].map(row => `${row.selected ? "Selected. " : ""}${row.element.querySelector(".chart-tooltip-label")?.textContent}: ${row.value.textContent}${row.time.textContent ? `, ${row.time.textContent}` : ""}.`).join(" ");
  }
  /** Dismiss transient UI without changing selected observation ownership. */
  hide(): void {if (this.element.matches(":popover-open")) this.element.hidePopover();}
  /** Release retained labels and top-layer DOM with the chart. */
  destroy(): void {this.hide(); this.element.remove(); this.rows.clear(); this.labels = []; this.indices = [];}
}
