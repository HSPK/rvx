import type {TableCell, TableDefinition} from "../domain/tables";
import type {ColumnPreference, TableFilterPreference, TableQueryPreference} from "./panels";
import {button, dialog, el, field, iconButton, select} from "./ui";
import {decimalDisplay} from "./decimal-display";
import {openTableFilters} from "./table-filters";

export interface ViewColumn {id: string; label: string; numeric?: boolean; sortable?: boolean; filterable?: boolean; width?: number}
export interface ViewRow {key: string; cells: Record<string, TableCell>; snapshotId: string | null; title: string; cellTitles?: Record<string, string>}
export interface TableViewState {search: string; filters: TableFilterPreference[]; sort?: {path: string; direction: "asc" | "desc"}; offset: number; limit: number}
export const tablePageSize = 75;
export const missingCell: TableCell = {kind: "missing", text: "missing", truncated: false};
const naturalOrder = new Intl.Collator(undefined, {numeric: true});
const stableOrder = new Intl.Collator();
interface CellKey {absent: boolean; text: string; numeric?: bigint | number}

/** Decode each numeric sort key once rather than reparsing it in every comparison. */
function cellKey(cell: TableCell): CellKey {
  return {absent: cell.kind === "null" || cell.kind === "missing", text: cell.text,
    ...(cell.kind === "number" ? {numeric: /^-?\d+$/.test(cell.text) ? BigInt(cell.text) : Number(cell.text)} : {})};
}
/** Reuse collation and exact integer keys while preserving missing-value ordering. */
function compareKeys(a: CellKey, b: CellKey): number {
  if (a.absent || b.absent) return Number(a.absent) - Number(b.absent);
  if (a.numeric !== undefined && b.numeric !== undefined) return a.numeric < b.numeric ? -1 : a.numeric > b.numeric ? 1 : 0;
  return naturalOrder.compare(a.text, b.text);
}

/** Use a readable leaf when the catalog supplies only a raw path, keeping that path as identity. */
export function collectionLabel(table: Pick<TableDefinition, "name" | "path">): string {
  if (table.path && table.name === table.path.replace(/^\//, "")) {
    const leaf = table.path.split("/").at(-1)!.replaceAll("~1", "/").replaceAll("~0", "~").replaceAll("_", " ");
    return leaf.charAt(0).toUpperCase() + leaf.slice(1);
  }
  return table.name;
}

/** Compare numeric text without rounding 64-bit integer cells through JavaScript Number. */
export function compareCells(a: TableCell, b: TableCell): number {
  return compareKeys(cellKey(a), cellKey(b));
}
/** Filter already-authoritative summary rows; no statistics are calculated from projected samples. */
export function filterSummaryRows(rows: ViewRow[], state: TableViewState): ViewRow[] {
  const query = state.search.toLocaleLowerCase();
  const filters = state.filters.filter(filter => filter.enabled !== false).map(filter => ({
    ...filter, folded: filter.value.toLocaleLowerCase(), numeric: Number.isFinite(Number(filter.value)),
    operand: cellKey({kind: "number", text: filter.value, truncated: false}),
  }));
  const filtered = rows.filter(row => (!query || Object.values(row.cells).some(cell => cell.text.toLocaleLowerCase().includes(query)))
    && filters.every(filter => {
      const cell = row.cells[filter.path] ?? missingCell;
      if (filter.op === "contains") return cell.text.toLocaleLowerCase().includes(filter.folded);
      if (filter.op === "eq") return cell.kind === "number" && filter.numeric
        ? compareKeys(cellKey(cell), filter.operand) === 0 : cell.text === filter.value;
      if (cell.kind !== "number" || !filter.numeric) return false;
      const difference = compareKeys(cellKey(cell), filter.operand);
      return filter.op === "gt" ? difference > 0 : difference < 0;
    }));
  if (state.sort) {
    const path = state.sort.path, direction = state.sort.direction === "asc" ? 1 : -1;
    const keys = new Map(filtered.map(row => [row, cellKey(row.cells[path] ?? missingCell)]));
    filtered.sort((a, b) => direction * compareKeys(keys.get(a)!, keys.get(b)!) || stableOrder.compare(a.key, b.key));
  }
  return filtered;
}
/** Export bounded displayed cells verbatim while preventing source strings from becoming spreadsheet formulas. */
export function pageCsv(columns: ViewColumn[], rows: ViewRow[]): string {
  const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;
  return [columns.map(column => quote(column.label)).join(","), ...rows.map(row => columns.map(column => {
    const cell = row.cells[column.id] ?? missingCell;
    const value = cell.kind === "string" && /^[=+@-]/.test(cell.text) ? `'${cell.text}` : cell.text;
    return quote(value + (cell.truncated ? " [preview]" : ""));
  }).join(","))].join("\r\n");
}

/** Shared bounded table DOM, column controls and keyboard/pointer resizing for both table kinds. */
export class TableView {
  readonly element = el("div", "data-grid");
  private viewport = el("div", "table-scroll");
  private table = el("table");
  private head = el("thead");
  private body = el("tbody");
  private colgroup = el("colgroup");
  private search = el("input", "text-input table-search");
  private filtersButton: HTMLButtonElement;
  private count = el("span", "muted");
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private columns: ViewColumn[] = [];
  private displayed: ViewColumn[] = [];
  private rows: ViewRow[] = [];
  private preferences: ColumnPreference[] = [];
  private total = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private modal: ReturnType<typeof dialog> | null = null;
  private lifetime = new AbortController();
  private headerSignature = "";
  private resizing = false;
  private deferred = false;
  readonly state: TableViewState = {search: "", filters: [], offset: 0, limit: tablePageSize};

  /** Keep table interaction state local while delegating server versus summary operations to the owner. */
  constructor(private changed: () => void, private columnsChanged: (columns: ColumnPreference[], refetch: boolean) => void) {
    const tools = el("div", "table-tools");
    this.search.type = "search"; this.search.placeholder = "Search…"; this.search.setAttribute("aria-label", "Search table rows");
    this.search.addEventListener("input", () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {this.state.search = this.search.value; this.state.offset = 0; this.changed();}, 180);
    });
    this.filtersButton = button("Filter", () => this.filterDialog(), "button quiet");
    tools.append(this.search, this.filtersButton, button("Columns", () => this.columnDialog(), "button quiet"),
      iconButton("Export page CSV", "download", () => this.exportPage()));
    this.table.append(this.colgroup, this.head, this.body);
    this.viewport.tabIndex = 0; this.viewport.setAttribute("role", "region"); this.viewport.setAttribute("aria-label", "Table rows");
    this.viewport.append(this.table);
    const footer = el("footer", "table-footer");
    this.previous = iconButton("Previous page", "left", () => {this.state.offset = Math.max(0, this.state.offset - this.state.limit); this.changed();});
    this.next = iconButton("Next page", "right", () => {this.state.offset += this.state.limit; this.changed();});
    footer.append(this.count, this.previous, this.next);
    this.element.append(tools, this.viewport, footer);
    document.addEventListener("selectionchange", () => {
      if (this.deferred && !this.hasSelectedText() && !this.resizing) {this.deferred = false; this.render();}
    }, {signal: this.lifetime.signal});
  }
  /** Refresh bounded rows while retaining search, widths, scroll and pinned header semantics. */
  setData(columns: ViewColumn[], rows: ViewRow[], total: number, preferences: ColumnPreference[] = []): void {
    this.columns = columns; this.rows = rows; this.total = total;
    if (!this.resizing) this.preferences = preferences.map(column => ({...column}));
    const ordered = [...preferences.flatMap(pref => columns.filter(column => column.id === pref.id)), ...columns.filter(column => !preferences.some(pref => pref.id === column.id))];
    const key = columns[0];
    this.displayed = [...(key ? [key] : []), ...ordered.filter(column => column.id !== key?.id && !preferences.find(pref => pref.id === column.id)?.hidden)];
    this.render();
  }
  /** Preserve browse state but clear data immediately when Run ownership changes. */
  clear(): void {this.rows = []; this.total = 0; this.state.offset = 0; this.body.replaceChildren(); this.count.textContent = "";}
  /** Restore named table view criteria without restoring an old page offset or snapshot pin. */
  setQuery(query?: TableQueryPreference): void {
    this.state.search = query?.search ?? ""; this.search.value = this.state.search;
    this.state.filters = query?.filters?.map(filter => ({...filter})) ?? [];
    if (query?.sort) this.state.sort = {...query.sort}; else delete this.state.sort;
    this.state.offset = 0;
  }
  /** Keep pagination disabled while a replacement page is in flight. */
  setBusy(busy: boolean): void {
    this.element.setAttribute("aria-busy", String(busy));
    this.previous.disabled = busy || this.state.offset === 0;
    this.next.disabled = busy || this.state.offset + this.state.limit >= this.total;
  }
  /** Render native rows and headers, with exact-cell kind and immutable evidence on each row. */
  private render(): void {
    if (this.resizing || this.hasSelectedText()) {this.deferred = true; return;}
    this.deferred = false;
    const left = this.viewport.scrollLeft, top = this.viewport.scrollTop;
    const signature = JSON.stringify([this.displayed, this.preferences, this.state.sort]);
    if (signature !== this.headerSignature) {
    this.headerSignature = signature;
    const header = el("tr");
    this.colgroup.replaceChildren();
    let width = 0;
    for (const [index, column] of this.displayed.entries()) {
      const pixels = this.preferences.find(pref => pref.id === column.id)?.width ?? column.width ?? (column.numeric ? 130 : 180);
      width += pixels;
      const col = el("col"); col.style.width = `${pixels}px`; this.colgroup.append(col);
      const th = el("th", index === 0 ? "pinned" : "");
      th.dataset.column = column.id; th.title = column.label;
      if (column.sortable !== false) {
        const sort = button(column.label, () => {
          this.state.sort = {path: column.id, direction: this.state.sort?.path === column.id && this.state.sort.direction === "asc" ? "desc" : "asc"};
          this.state.offset = 0; this.changed();
        }, "table-sort");
        sort.setAttribute("aria-label", column.label);
        th.setAttribute("aria-sort", this.state.sort?.path === column.id ? this.state.sort.direction === "asc" ? "ascending" : "descending" : "none");
        th.append(sort);
      } else th.append(el("span", "", column.label));
      const resize = el("span", "column-resizer"); resize.tabIndex = 0; resize.setAttribute("role", "separator");
      resize.setAttribute("aria-label", `Resize ${column.label} column`); resize.setAttribute("aria-orientation", "vertical");
      let start = 0, initial = pixels, current = pixels;
      const apply = (value: number): void => {
        current = Math.max(70, Math.min(800, value)); col.style.width = `${current}px`; this.table.style.width = `${width + current - pixels}px`;
      };
      const save = (): void => this.changeColumn(column.id, {width: current});
      resize.addEventListener("pointerdown", event => {event.preventDefault(); this.resizing = true; start = event.clientX; initial = current; resize.setPointerCapture(event.pointerId);});
      resize.addEventListener("pointermove", event => {if (resize.hasPointerCapture(event.pointerId)) apply(initial + event.clientX - start);});
      const end = (event: PointerEvent): void => {
        if (!this.resizing) return;
        this.resizing = false;
        if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId);
        save(); this.render();
      };
      resize.addEventListener("pointerup", end);
      resize.addEventListener("pointercancel", end);
      resize.addEventListener("lostpointercapture", end);
      resize.addEventListener("keydown", event => {if (event.key === "ArrowLeft" || event.key === "ArrowRight") {event.preventDefault(); apply(current + (event.key === "ArrowRight" ? 10 : -10)); save();}});
      th.append(resize); header.append(th);
    }
    this.head.replaceChildren(header); this.table.style.width = `${width}px`;
    }
    const existing = new Map([...this.body.rows].map(row => [row.dataset.rowKey, row]));
    const nextRows = this.rows.map(row => {
      const tr = existing.get(row.key) ?? el("tr"); tr.dataset.snapshotId = row.snapshotId ?? ""; tr.dataset.rowKey = row.key;
      tr.setAttribute("aria-label", row.title);
      const cells = new Map([...tr.cells].map(cell => [cell.dataset.column, cell]));
      const nextCells: HTMLTableCellElement[] = [];
      for (const [index, column] of this.displayed.entries()) {
        const value = row.cells[column.id] ?? missingCell;
        const td = cells.get(column.id) ?? el("td");
        td.className = `${index === 0 ? "pinned " : ""}${value.kind === "number" ? "numeric " : ""}${value.kind === "missing" || value.kind === "null" ? "muted" : ""}`;
        td.dataset.column = column.id;
        td.dataset.kind = value.kind; td.title = row.cellTitles?.[column.id] ?? `${value.kind}${value.truncated ? " · truncated preview" : ""}: ${value.text}`;
        const text = value.kind === "missing" ? "missing" : value.kind === "string" && !value.text ? '""' : value.text;
        const display = value.kind === "number" && !value.truncated
          ? decimalDisplay(text, this.preferences.find(preference => preference.id === column.id)?.decimals) : text;
        const content = `${display}${value.truncated ? " …" : ""}`;
        if (td.textContent !== content) td.textContent = content;
        nextCells.push(td);
      }
      if (nextCells.length !== tr.cells.length || nextCells.some((td, index) => tr.cells[index] !== td)) tr.replaceChildren(...nextCells);
      return tr;
    });
    if (nextRows.length !== this.body.rows.length || nextRows.some((row, index) => this.body.rows[index] !== row)) this.body.replaceChildren(...nextRows);
    if (!this.rows.length) {const tr = el("tr"), cell = el("td", "table-empty", "No matching rows"); cell.colSpan = this.displayed.length; tr.append(cell); this.body.append(tr);}
    this.count.textContent = this.total ? `${this.state.offset + 1}–${Math.min(this.total, this.state.offset + this.rows.length)} of ${this.total.toLocaleString()}` : "0 rows";
    const enabled = this.state.filters.filter(filter => filter.enabled !== false).length;
    this.filtersButton.querySelector("span")!.textContent = enabled ? `Filter (${enabled})` : "Filter";
    this.setBusy(false); this.viewport.scrollLeft = left; this.viewport.scrollTop = top;
  }
  private hasSelectedText(): boolean {
    const selection = document.getSelection();
    return Boolean(selection && !selection.isCollapsed && (this.body.contains(selection.anchorNode) || this.body.contains(selection.focusNode)));
  }
  /** Store column changes as copied preferences rather than mutating saved workspace objects. */
  private changeColumn(id: string, change: Partial<ColumnPreference>, clearDecimals = false): void {
    const preferences = this.columns.map(column => ({id: column.id, ...this.preferences.find(pref => pref.id === column.id)}));
    const order = [...this.preferences.map(pref => pref.id), ...preferences.map(pref => pref.id).filter(id => !this.preferences.some(pref => pref.id === id))];
    const result = order.flatMap(key => preferences.filter(pref => pref.id === key).map(pref => {
      const result = key === id ? {...pref, ...change} : pref;
      if (key === id && clearDecimals) delete result.decimals;
      return result;
    }));
    this.preferences = result;
    this.setData(this.columns, this.rows, this.total, result);
    this.columnsChanged(result.map(pref => ({...pref})), change.hidden !== undefined);
  }
  /** Let users choose, order and size columns without an unbounded hidden table DOM. */
  private columnDialog(): void {
    this.modal?.close();
    const modal = dialog("Columns", "table-columns-dialog", () => {this.modal = null;}); this.modal = modal;
    const key = this.columns[0];
    const ordered = [...(key ? [key] : []), ...this.preferences.flatMap(pref => this.columns.filter(column => column.id === pref.id && column.id !== key?.id)), ...this.columns.filter(column => column.id !== key?.id && !this.preferences.some(pref => pref.id === column.id))];
    const render = (): void => {
      modal.body.replaceChildren(...ordered.map((column, index) => {
        const row = el("div", "column-option"), label = el("label");
        const check = el("input"); check.type = "checkbox"; check.checked = !this.preferences.find(pref => pref.id === column.id)?.hidden;
        check.disabled = index === 0; check.setAttribute("aria-label", `Show ${column.label}`);
        check.addEventListener("change", () => this.changeColumn(column.id, {hidden: !check.checked}));
        label.append(check, el("span", "", column.label));
        const reorder = (delta: number): void => {
          const to = index + delta; if (to < 0 || to >= ordered.length) return;
          [ordered[index], ordered[to]] = [ordered[to]!, ordered[index]!];
          this.preferences = ordered.map(column => ({id: column.id, ...this.preferences.find(pref => pref.id === column.id)}));
          this.setData(this.columns, this.rows, this.total, this.preferences);
          this.columnsChanged(this.preferences.map(pref => ({...pref})), false); render();
        };
        const before = iconButton(`Move ${column.label} column left`, "left", () => reorder(-1));
        const after = iconButton(`Move ${column.label} column right`, "right", () => reorder(1));
        before.disabled = index <= 1; after.disabled = index === 0 || index === ordered.length - 1;
        row.append(label);
        if (column.numeric || this.rows.some(row => row.cells[column.id]?.kind === "number")
          || this.preferences.some(preference => preference.id === column.id && preference.decimals !== undefined)) {
          const decimals = select(`Decimal places for ${column.label}`,
            [["", "Auto"], ...Array.from({length: 21}, (_, places): [string, string] => [String(places), String(places)])],
            String(this.preferences.find(preference => preference.id === column.id)?.decimals ?? ""),
            value => this.changeColumn(column.id, value === "" ? {} : {decimals: Number(value)}, value === ""));
          decimals.classList.add("column-decimals");
          const setting = field("Decimals", decimals); setting.classList.add("column-precision");
          row.append(setting);
        }
        row.append(before, after); return row;
      }));
    };
    render();
  }
  /** Send explicit typed column filters to the owner before its pagination step. */
  private filterDialog(): void {
    this.modal?.close();
    this.modal = openTableFilters(this.columns, this.state.filters, filters => {
      this.state.filters = filters; this.state.offset = 0; this.changed();
    }, () => {this.modal = null;});
  }
  /** Export only the visible page and explicitly preserve bounded-preview markers. */
  private exportPage(): void {
    const url = URL.createObjectURL(new Blob([pageCsv(this.displayed, this.rows)], {type: "text/csv;charset=utf-8"}));
    const link = el("a"); link.href = url; link.download = "rvx-table-page.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  /** Cancel local timers and column/filter dialogs when the table is removed. */
  destroy(): void {this.lifetime.abort(); if (this.debounce) clearTimeout(this.debounce); this.modal?.close();}
}
