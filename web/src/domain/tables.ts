export interface SummaryRequest {run_ids: string[]; paths: string[]; source_ids?: string[]; axis?: string; from?: number; to?: number}
export interface SummaryRow {
  run_id: string; source_id: string; path: string;
  observations: number; count: number; missing: number;
  current: number | null; minimum: number | null; average: number | null; p95: number | null; maximum: number | null;
  snapshot_id: string | null; observed_at_ns: number | null;
}
export interface SummaryResponse {axis: string; rows: SummaryRow[]}
export interface TableCatalogRequest {run_ids: string[]; source_ids?: string[]}
export interface TableColumn {path: string; name: string; kinds?: CellKind[]}
export interface TableSource {
  run_id: string; source_id: string; label: string; role: string; rank: number | null; node_id: string | null;
  snapshot_id: string; observed_at_ns: number; row_count: number;
}
export interface TableDefinition {path: string; name: string; columns: TableColumn[]; sources: TableSource[]; collection_kinds?: ("object" | "array")[]}
export interface TableCatalogResponse {tables: TableDefinition[]; truncated: boolean}
export type CellKind = "missing" | "null" | "number" | "string" | "boolean" | "object" | "array";
export interface TableCell {kind: CellKind; text: string; truncated: boolean}
export interface TableFilter {path: string; op: "contains" | "eq" | "gt" | "lt"; value: string}
export interface TableRowsRequest {
  run_ids: string[]; source_ids?: string[]; path: string; columns?: string[]; snapshot_ids?: string[];
  search?: string; filters?: TableFilter[]; sort?: {path: string; direction: "asc" | "desc"}; offset?: number; limit?: number;
}
export interface TableDataRow {run_id: string; source_id: string; snapshot_id: string; row_key: string; cells: Record<string, TableCell>}
export interface TableRowsResponse {columns: TableColumn[]; rows: TableDataRow[]; total: number; offset: number; limit: number; snapshots: TableSource[]}
