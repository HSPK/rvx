import {uiIdentifier} from "../core/identifiers";
import {copyChart, isRecord, validChartSpec, type ChartSpec} from "./model";
import type {TableFilter} from "../domain/tables";
import type {SnapshotView} from "../domain/snapshot-views";
import {copySnapshotView, validSnapshotView} from "./snapshot-config";

export interface ColumnPreference {id: string; hidden?: boolean; width?: number; decimals?: number}
export interface TableFilterPreference extends TableFilter {enabled?: boolean}
export interface TableQueryPreference {search?: string; filters?: TableFilterPreference[]; sort?: {path: string; direction: "asc" | "desc"}}
interface BasePanel {id: string; sectionId: string; size: "normal" | "wide"}
export interface ChartPanel extends BasePanel, ChartSpec {kind: "chart"}
export interface MetricTablePanel extends BasePanel {kind: "metric-table"; paths: string[]; title?: string; sourceIds?: string[]; columns?: ColumnPreference[]; query?: TableQueryPreference}
export interface SnapshotTablePanel extends BasePanel {kind: "snapshot-table"; path: string; title?: string; sourceIds?: string[]; columns?: ColumnPreference[]; query?: TableQueryPreference; view?: SnapshotView}
export type SnapshotVisualPanelSpec = SnapshotTablePanel & {view: SnapshotView};
/** Distinguish collection visualizations without changing the stored identity of existing tables. */
export function isSnapshotVisual(panel: PanelSpec): panel is SnapshotVisualPanelSpec {return panel.kind === "snapshot-table" && panel.view !== undefined;}
export type TablePanelSpec = MetricTablePanel | SnapshotTablePanel;
export type PanelSpec = ChartPanel | TablePanelSpec;
export interface SectionSpec {id: string; name: string; collapsed: boolean}
export interface WorkspaceLayout {panels: PanelSpec[]; sections: SectionSpec[]}
export interface WorkspaceSet extends WorkspaceLayout {id: string; name: string; experimentId: string}
export const panelLimit = 24;
export const sectionLimit = 24;
export const tableColumnLimit = 128 + 3;

/** Start with one unheaded group, not a visible hierarchy users must configure. */
export function emptyLayout(): WorkspaceLayout {
  return {panels: [], sections: [{id: uiIdentifier("section"), name: "", collapsed: false}]};
}
/** Copy only UI configuration, retaining no raw snapshots or shared nested editing references. */
export function copyPanel(panel: PanelSpec): PanelSpec {
  if (panel.kind === "chart") return {id: panel.id, sectionId: panel.sectionId, kind: "chart", ...copyChart(panel)};
  return {...panel, ...(panel.kind === "metric-table" ? {paths: [...panel.paths]} : {}),
    ...(panel.kind === "snapshot-table" && panel.view ? {view: copySnapshotView(panel.view)} : {}),
    ...(panel.sourceIds ? {sourceIds: [...panel.sourceIds]} : {}), ...(panel.columns ? {columns: panel.columns.map(column => ({...column}))} : {}),
    ...(panel.query ? {query: {...panel.query, ...(panel.query.sort ? {sort: {...panel.query.sort}} : {}), ...(panel.query.filters ? {filters: panel.query.filters.map(filter => ({...filter}))} : {})}} : {})};
}
/** Preserve stable panel and section identities when saving or selecting named workspace sets. */
export function copyLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return {panels: layout.panels.map(copyPanel), sections: layout.sections.map(section => ({...section}))};
}
/** Allocate identity independently of metric paths so charts and tables may share fields. */
export function chartPanel(chart: ChartSpec, sectionId: string): ChartPanel {
  return {id: uiIdentifier("panel"), sectionId, kind: "chart", ...copyChart(chart)};
}
/** Validate current persistent layouts without accepting obsolete board or path-keyed formats. */
export function validLayout(value: unknown): value is WorkspaceLayout {
  if (!isRecord(value) || !Array.isArray(value.sections) || !value.sections.length || value.sections.length > sectionLimit || !Array.isArray(value.panels) || value.panels.length > panelLimit) return false;
  if (!value.sections.every(section => isRecord(section) && typeof section.id === "string" && typeof section.name === "string" && section.name.length <= 100 && typeof section.collapsed === "boolean")) return false;
  const sectionIds = new Set(value.sections.map(section => section.id));
  return sectionIds.size === value.sections.length && value.panels.every(panel => validPanel(panel) && sectionIds.has(panel.sectionId))
    && new Set(value.panels.map(panel => panel.id)).size === value.panels.length;
}
/** Reject unsupported presentation, malformed table columns, and empty metric selections explicitly. */
export function validPanel(value: unknown): value is PanelSpec {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.sectionId !== "string" || (value.size !== "normal" && value.size !== "wide")) return false;
  if (value.view !== undefined && (value.kind !== "snapshot-table" || !validSnapshotView(value.view))) return false;
  if (value.kind === "chart") return validChartSpec(value);
  if (value.kind !== "metric-table" && value.kind !== "snapshot-table") return false;
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 120)) return false;
  if (value.sourceIds !== undefined && (!Array.isArray(value.sourceIds) || value.sourceIds.length > 256 || !value.sourceIds.every(id => typeof id === "string") || new Set(value.sourceIds).size !== value.sourceIds.length)) return false;
  if (value.kind === "metric-table" && (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 64 || !value.paths.every(path => typeof path === "string" && path.startsWith("/")) || new Set(value.paths).size !== value.paths.length)) return false;
  if (value.kind === "snapshot-table" && (typeof value.path !== "string" || value.path !== "" && !value.path.startsWith("/"))) return false;
  if (value.query !== undefined) {
    const query = value.query;
    if (!isRecord(query) || query.search !== undefined && typeof query.search !== "string") return false;
    if (query.sort !== undefined && (!isRecord(query.sort) || typeof query.sort.path !== "string" || query.sort.direction !== "asc" && query.sort.direction !== "desc")) return false;
    if (query.filters !== undefined && (!Array.isArray(query.filters) || query.filters.length > 32 || !query.filters.every(filter => isRecord(filter) && typeof filter.path === "string" && typeof filter.value === "string" && typeof filter.op === "string" && ["contains", "eq", "gt", "lt"].includes(filter.op) && (filter.enabled === undefined || typeof filter.enabled === "boolean")))) return false;
  }
  if (value.columns !== undefined && (!Array.isArray(value.columns) || value.columns.length > tableColumnLimit || !value.columns.every(column => isRecord(column) && typeof column.id === "string"
    && (column.hidden === undefined || typeof column.hidden === "boolean")
    && (column.decimals === undefined || typeof column.decimals === "number" && Number.isInteger(column.decimals) && column.decimals >= 0 && column.decimals <= 20)
    && (column.width === undefined || typeof column.width === "number" && Number.isFinite(column.width) && column.width >= 70 && column.width <= 800))
    || new Set(value.columns.map(column => column.id)).size !== value.columns.length)) return false;
  return true;
}
/** Move panels between flat sections while keeping every other panel's relative order. */
export function movePanel(layout: WorkspaceLayout, id: string, sectionId: string, beforeId?: string): void {
  if (!layout.sections.some(section => section.id === sectionId) || id === beforeId) return;
  const panel = layout.panels.find(panel => panel.id === id);
  if (!panel) return;
  layout.panels = layout.panels.filter(panel => panel.id !== id);
  panel.sectionId = sectionId;
  const target = beforeId ? layout.panels.findIndex(panel => panel.id === beforeId && panel.sectionId === sectionId) : -1;
  if (target >= 0) layout.panels.splice(target, 0, panel);
  else {
    const last = layout.panels.map((panel, index) => panel.sectionId === sectionId ? index : -1).filter(index => index >= 0).at(-1) ?? -1;
    layout.panels.splice(last < 0 ? layout.panels.length : last + 1, 0, panel);
  }
}
/** Deleting a group preserves its contents in another group rather than silently deleting evidence views. */
export function removeSection(layout: WorkspaceLayout, id: string): void {
  const target = layout.sections.find(section => section.id !== id);
  if (!target) {const only = layout.sections[0]; if (only) {only.name = ""; only.collapsed = false;} return;}
  for (const panel of layout.panels) if (panel.sectionId === id) panel.sectionId = target.id;
  target.collapsed = false;
  layout.sections = layout.sections.filter(section => section.id !== id);
}
