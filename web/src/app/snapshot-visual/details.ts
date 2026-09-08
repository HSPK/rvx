import type {TableCell, TableDataRow, TableSource} from "../../domain/tables";
import type {MetricCatalogQueryCoordinator} from "../coordinator";
import {decimalDisplay} from "../decimal-display";
import {formatTime, observedTime} from "../model";
import {missingCell} from "../table-view";
import {dialog, el, errorText} from "../ui";
import {uiIdentifier} from "../../core/identifiers";

export interface VisualNames {
  runName: (id: string) => string;
  fieldName: (path: string) => string;
  colorFor: (id: string) => string;
}
export type Readout = [label: string, value: string][];

/** Preserve typed absence and bounded-preview markers without rounding exact numeric text. */
export function cellText(cell: TableCell = missingCell, decimals?: number): string {
  const text = cell.kind === "missing" ? "missing" : cell.kind === "null" ? "null"
    : cell.kind === "number" && !cell.truncated ? decimalDisplay(cell.text, decimals)
    : cell.kind === "string" && !cell.text ? '""' : cell.text;
  return `${text}${cell.truncated ? " [preview]" : ""}`;
}

/** Separate geometry coercion from exact labels, including numbers outside finite browser range. */
export function finiteNumber(cell: TableCell | undefined): number | null {
  if (cell?.kind !== "number" || cell.truncated || !cell.text.trim()) return null;
  const number = Number(cell.text);
  return Number.isFinite(number) ? number : null;
}

/** Include immutable observation time and actual publisher identity in every evidence readout. */
export function provenance(run: string, sourceId: string, snapshot: TableSource | undefined, names: VisualNames): Readout {
  return [["Run", names.runName(run)], ["Reporter", snapshot?.label ?? sourceId],
    ["Observed", observedTime(snapshot?.observed_at_ns)]];
}

/** Own one bounded native-top-layer tooltip; pointer motion never rebuilds the full visualization. */
export class VisualTooltip {
  readonly element = el("div", "sv-tooltip");
  private anchor: Element | null = null;
  private lifetime = new AbortController();

  /** Dismiss detached readouts on scroll, resize and Escape without stealing task focus. */
  constructor() {
    this.element.id = uiIdentifier("snapshot-tooltip");
    this.element.popover = "manual";
    this.element.setAttribute("role", "tooltip");
    window.addEventListener("resize", () => this.hide(), {signal: this.lifetime.signal});
    window.addEventListener("scroll", () => this.hide(), {capture: true, signal: this.lifetime.signal});
    document.addEventListener("keydown", event => {if (event.key === "Escape") this.hide();}, {signal: this.lifetime.signal});
  }

  /** Format only the selected mark and clamp its readout to the visual viewport. */
  show(anchor: Element, title: string, rows: Readout): void {
    if (!anchor.isConnected || !this.element.isConnected) return;
    this.hide();
    this.anchor = anchor;
    const content = el("dl", "sv-readout");
    for (const [label, value] of rows) content.append(el("dt", "", label), el("dd", "", value));
    this.element.replaceChildren(el("strong", "sv-tooltip-title", title), content);
    anchor.setAttribute("aria-describedby", this.element.id);
    this.element.showPopover();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    this.element.style.maxWidth = `${Math.max(0, Math.min(380, width - 16))}px`;
    this.element.style.maxHeight = `${Math.max(0, height - 16)}px`;
    const target = anchor.getBoundingClientRect(), box = this.element.getBoundingClientRect();
    const x = target.left + box.width < left + width - 8 ? target.left : target.right - box.width;
    const y = target.bottom + box.height + 8 < top + height - 8 ? target.bottom + 8 : target.top - box.height - 8;
    this.element.style.left = `${Math.max(left + 8, Math.min(x, left + width - box.width - 8))}px`;
    this.element.style.top = `${Math.max(top + 8, Math.min(y, top + height - box.height - 8))}px`;
  }

  /** Clear tooltip ownership while leaving its keyboard or touch selection intact. */
  hide(): void {
    this.anchor?.removeAttribute("aria-describedby"); this.anchor = null;
    if (this.element.matches(":popover-open")) this.element.hidePopover();
  }

  /** Release viewport listeners and top-layer DOM with the owning panel. */
  destroy(): void {this.hide(); this.lifetime.abort(); this.element.remove();}
}

/** Show an immutable task observation, never the unbounded raw snapshot document. */
export class TaskDetails {
  private modal: ReturnType<typeof dialog> | null = null;
  private request: AbortController | null = null;

  /** Share the panel's read coordinator and human-readable field/Run ownership. */
  constructor(private reads: MetricCatalogQueryCoordinator, private names: VisualNames) {}

  /** Paint cached exact cells immediately, then request one bounded row from the same snapshot. */
  open(path: string, record: TableDataRow, snapshot: TableSource | undefined, title: string): void {
    this.close();
    const request = new AbortController(); this.request = request;
    const modal = dialog("Task details", "sv-task-drawer", () => {
      request.abort();
      if (this.request === request) {this.request = null; this.modal = null;}
    });
    this.modal = modal;
    const metadata = el("dl", "sv-readout sv-task-provenance");
    for (const [label, value] of provenance(record.run_id, record.source_id, snapshot, this.names)) {
      metadata.append(el("dt", "", label), el("dd", "", label === "Observed" ? formatTime(snapshot?.observed_at_ns) : value));
    }
    metadata.append(el("dt", "", "Source ID"), el("dd", "", record.source_id),
      el("dt", "", "Snapshot"), el("dd", "", record.snapshot_id));
    const fields = el("dl", "sv-task-fields"), state = el("span", "muted sv-detail-state", "Loading remaining fields…");
    state.setAttribute("role", "status");
    modal.body.append(el("h3", "sv-task-title", title), metadata, fields, state);
    this.paint(fields, record.cells);
    void this.load(path, record, fields, state, request);
  }

  /** Pin both ownership and row key, retaining cached fields if the bounded detail read fails. */
  private async load(path: string, record: TableDataRow, fields: HTMLElement, state: HTMLElement, request: AbortController): Promise<void> {
    try {
      const response = await this.reads.rows({run_ids: [record.run_id], source_ids: [record.source_id], path,
        snapshot_ids: [record.snapshot_id], filters: [{path: "$key", op: "eq", value: record.row_key}], limit: 1}, request.signal);
      if (request.signal.aborted) return;
      const row = response.rows.find(row => row.snapshot_id === record.snapshot_id && row.run_id === record.run_id
        && row.source_id === record.source_id && row.row_key === record.row_key);
      if (!row) {state.textContent = "This task is unavailable in the selected observation."; return;}
      this.paint(fields, row.cells); state.textContent = ""; state.hidden = true;
    } catch (error) {if (!request.signal.aborted) state.textContent = errorText(error);}
  }

  /** Reuse exact TableCell previews and expose typed missing/null values as selectable text. */
  private paint(target: HTMLElement, cells: Record<string, TableCell>): void {
    const fragment = document.createDocumentFragment();
    for (const [path, cell] of Object.entries(cells).slice(0, 131)) {
      const value = el("dd", "sv-task-value", cellText(cell));
      value.dataset.kind = cell.kind; value.title = `${cell.kind}${cell.truncated ? " · truncated preview" : ""}`;
      const label = el("dt", "", this.names.fieldName(path)); label.title = path;
      fragment.append(label, value);
    }
    target.replaceChildren(fragment);
  }

  /** Close and abort synchronously before scope changes or panel removal. */
  close(): void {this.request?.abort(); this.request = null; this.modal?.close(); this.modal = null;}
}
