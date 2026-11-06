import type {TableCell, TableDefinition} from "../domain/tables";
import {activeTableFilters, type TableQueryPreference} from "./panels";

export interface ViewColumn {id: string; label: string; numeric?: boolean; sortable?: boolean; filterable?: boolean; width?: number}
export interface ViewRow {key: string; cells: Record<string, TableCell>; snapshotId: string | null; title: string; cellTitles?: Record<string, string>}
export interface TableViewState extends TableQueryPreference {search: string; filters: NonNullable<TableQueryPreference["filters"]>; offset: number; limit: number}
export const tablePageSize = 75;
export const missingCell: TableCell = {kind: "missing", text: "missing", truncated: false};
const naturalOrder = new Intl.Collator(undefined, {numeric: true});
const stableOrder = new Intl.Collator();
interface CellKey {absent: boolean; text: string; numeric?: bigint | number}
function cellKey(cell: TableCell): CellKey {
  return {absent: cell.kind === "null" || cell.kind === "missing", text: cell.text,
    ...(cell.kind === "number" ? {numeric: /^-?\d+$/.test(cell.text) ? BigInt(cell.text) : Number(cell.text)} : {})};
}
function compareKeys(a: CellKey, b: CellKey): number {
  if (a.absent || b.absent) return Number(a.absent) - Number(b.absent);
  if (a.numeric !== undefined && b.numeric !== undefined) return a.numeric < b.numeric ? -1 : a.numeric > b.numeric ? 1 : 0;
  return naturalOrder.compare(a.text, b.text);
}

export function collectionLabel(table: Pick<TableDefinition, "name" | "path">): string {
  if (table.path && table.name === table.path.replace(/^\//, "")) {
    const leaf = table.path.split("/").at(-1)!.replaceAll("~1", "/").replaceAll("~0", "~").replaceAll("_", " ");
    return leaf.charAt(0).toUpperCase() + leaf.slice(1);
  }
  return table.name;
}

/** Integer cells must never pass through Number, including filter operands and sorting. */
export function compareCells(a: TableCell, b: TableCell): number {
  return compareKeys(cellKey(a), cellKey(b));
}

export function filterSummaryRows(rows: ViewRow[], query: TableQueryPreference | TableViewState): ViewRow[] {
  const search = (query.search ?? "").toLocaleLowerCase(), filters = activeTableFilters(query).map(filter => ({
    ...filter, folded: filter.value.toLocaleLowerCase(), numeric: Number.isFinite(Number(filter.value)),
    operand: cellKey({kind: "number", text: filter.value, truncated: false}),
  }));
  const filtered = rows.filter(row => (!search || Object.values(row.cells).some(cell => cell.text.toLocaleLowerCase().includes(search)))
    && filters.every(filter => {
      const cell = row.cells[filter.path] ?? missingCell;
      if (filter.op === "contains") return cell.text.toLocaleLowerCase().includes(filter.folded);
      if (filter.op === "eq" && !(cell.kind === "number" && filter.numeric)) return cell.text === filter.value;
      if (cell.kind !== "number" || !filter.numeric) return false;
      const difference = compareKeys(cellKey(cell), filter.operand);
      return filter.op === "eq" ? difference === 0 : filter.op === "gt" ? difference > 0 : difference < 0;
    }));
  const sort = query.sort;
  if (sort) {
    const keys = new Map(filtered.map(row => [row, cellKey(row.cells[sort.path] ?? missingCell)]));
    filtered.sort((a, b) => (sort.direction === "asc" ? 1 : -1) * compareKeys(keys.get(a)!, keys.get(b)!) || stableOrder.compare(a.key, b.key));
  }
  return filtered;
}

/** CSV exports exact bounded cells, not rounded display text, with formula protection. */
export function pageCsv(columns: ViewColumn[], rows: ViewRow[]): string {
  const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;
  return [columns.map(column => quote(column.label)).join(","), ...rows.map(row => columns.map(column => {
    const cell = row.cells[column.id] ?? missingCell;
    const value = cell.kind === "string" && /^[=+@-]/.test(cell.text) ? `'${cell.text}` : cell.text;
    return quote(value + (cell.truncated ? " [preview]" : ""));
  }).join(","))].join("\r\n");
}
