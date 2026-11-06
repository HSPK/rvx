import {uiIdentifier} from "../core/identifiers";
import type {ChartCatalog, ChartMetric} from "../domain/snapshots";
import type {SnapshotView} from "../domain/snapshot-views";
import type {TableDefinition} from "../domain/tables";
import {compatibleMetrics, humanize, metricName, validPanelSize, type ChartPresentation, type PanelSize} from "./model";
import {copyPanel, panelLimit, sectionLimit, validPanel, type ColumnPreference, type PanelSpec, type TableQueryPreference, type WorkspaceLayout} from "./panels";
import {snapshotBindingError} from "./snapshot-config";

export interface PanelEditorDraft {
  kind: PanelSpec["kind"] | "section";
  paths: string[];
  combined: boolean;
  sectionId: string;
  size: PanelSize;
  title: string;
  style: "line" | "area";
  lineWidth: string;
  points: "auto" | "show" | "hide";
  legend: "auto" | "show" | "hide";
  yMin: string;
  yMax: string;
  smoothing: string;
  logarithmic: boolean;
  collectionPath: string | null;
  sourceIds: string[] | null;
  columns?: ColumnPreference[];
  query?: TableQueryPreference;
  view?: SnapshotView;
}

export function editorMetrics(catalog: ChartCatalog, paths: string[]): ChartMetric[] {
  return paths.map(path => catalog.metrics.find(metric => metric.path === path) ?? {
    path, name: humanize(path.split("/").at(-1) ?? "Metric"), group: "Saved field", unit: null, sources: [], run_ids: [],
  });
}

export function editorPresentation(draft: PanelEditorDraft): ChartPresentation {
  return {
    ...(draft.title.trim() ? {title: draft.title.trim()} : {}),
    ...(draft.style === "area" ? {style: "area" as const} : {}),
    ...(Number(draft.lineWidth) !== 1.8 ? {lineWidth: Number(draft.lineWidth)} : {}),
    ...(draft.points === "auto" ? {} : {points: draft.points === "show"}),
    ...(draft.legend === "auto" ? {} : {legend: draft.legend}),
    ...(draft.yMin.trim() ? {yMin: Number(draft.yMin)} : {}),
    ...(draft.yMax.trim() ? {yMax: Number(draft.yMax)} : {}),
  };
}

/** Validate the isolated transaction independently of preview requests and rendering. */
export function panelEditorError(draft: PanelEditorDraft, catalog: ChartCatalog, layout: WorkspaceLayout, existing?: PanelSpec, table: TableDefinition | null = null): string {
  if (existing && existing.kind !== draft.kind) return "An existing panel's type cannot be changed.";
  if (draft.kind === "section") {
    if (layout.sections.length >= sectionLimit) return `This workspace supports ${sectionLimit} sections. Rename or remove an existing section first.`;
    if (!draft.title.trim()) return "";
    return draft.title.trim().length > 100 ? "Section names must fit 100 characters." : "";
  }
  if (!layout.sections.some(section => section.id === draft.sectionId)) return "Choose an available destination section.";
  if (!validPanelSize(draft.size)) return "Choose a valid panel width.";
  if (draft.title.trim().length > 120) return "Panel titles must fit 120 characters.";
  if (draft.kind !== "snapshot-table" && draft.paths.length > 64) return "Select at most 64 metrics for one query.";
  const count = draft.kind === "chart" && !draft.combined ? draft.paths.length : 1;
  if (layout.panels.length - Number(Boolean(existing)) + count > panelLimit) return `This workspace supports ${panelLimit} panels. Remove a panel or combine compatible fields.`;
  if (draft.kind === "chart") {
    const width = Number(draft.lineWidth);
    if (!draft.lineWidth.trim() || !Number.isFinite(width) || width < .5 || width > 6) return "Line width must be between 0.5 and 6.";
    const display = editorPresentation(draft);
    const smoothing = Number(draft.smoothing);
    if (!draft.smoothing.trim() || !Number.isFinite(smoothing) || smoothing < 0 || smoothing > .99) return "EMA smoothing must be between 0 and 0.99.";
    if ([draft.yMin, draft.yMax].some(text => text.trim() && !Number.isFinite(Number(text)))) return "Y bounds must be finite numbers.";
    if (display.yMin !== undefined && display.yMax !== undefined && display.yMin >= display.yMax) return "Y minimum must be less than Y maximum.";
    if (display.yMin === Number.MAX_VALUE || display.yMax === -Number.MAX_VALUE || draft.logarithmic && display.yMax === Number.MIN_VALUE) return "Y bounds leave no representable range.";
    if (draft.logarithmic && [display.yMin, display.yMax].some(value => value !== undefined && value <= 0)) return "Logarithmic bounds must be greater than zero.";
    const metrics = editorMetrics(catalog, draft.paths);
    if (draft.combined && !compatibleMetrics(metrics.filter(metric => metric.sources.length))) return "Different units cannot share one scale. Choose Separate charts.";
    if (!draft.combined && draft.paths.length > 1 && display.title && metrics.some(metric => `${display.title} · ${metricName(metric)}`.length > 120)) {
      return "Shorten the title prefix so each chart title fits 120 characters.";
    }
  } else {
    if (draft.sourceIds?.length === 0) return "Select at least one reporter.";
    if (draft.sourceIds && draft.sourceIds.length > 256) return "Select at most 256 reporters.";
    if (draft.kind === "snapshot-table") return snapshotBindingError(draft.view, table);
  }
  return "";
}

export function panelEditorReady(draft: PanelEditorDraft): boolean {
  return draft.kind === "section" ? Boolean(draft.title.trim()) : draft.kind === "snapshot-table" ? draft.collectionPath !== null : draft.paths.length > 0;
}

export function panelsFromEditor(draft: PanelEditorDraft, catalog: ChartCatalog, existing?: PanelSpec): PanelSpec[] {
  const base = {sectionId: draft.sectionId, size: draft.size};
  if (draft.kind === "chart") {
    const groups = draft.combined ? [draft.paths] : draft.paths.map(path => [path]);
    return groups.map((paths, index) => {
      const presentation = editorPresentation(draft);
      if (groups.length > 1 && presentation.title) presentation.title = `${presentation.title} · ${metricName(editorMetrics(catalog, paths)[0]!)}`;
      return {...base, kind: "chart", id: index === 0 ? existing?.id ?? uiIdentifier("panel") : uiIdentifier("panel"),
        path: paths[0] ?? "", ...(paths.length > 1 ? {paths: [...paths]} : {}), ...(Object.keys(presentation).length ? {presentation} : {})};
    });
  }
  if (draft.kind === "section") return [];
  const panel: PanelSpec = {
    ...base, id: existing?.id ?? uiIdentifier("panel"),
    ...(draft.title.trim() ? {title: draft.title.trim()} : {}),
    ...(draft.sourceIds ? {sourceIds: [...draft.sourceIds]} : {}),
    ...(draft.columns ? {columns: draft.columns} : {}), ...(draft.query ? {query: draft.query} : {}),
    ...(draft.kind === "metric-table" ? {kind: "metric-table", paths: [...draft.paths]}
      : {kind: "snapshot-table", path: draft.collectionPath ?? "", ...(draft.view ? {view: draft.view} : {})}),
  };
  return [copyPanel(panel)];
}

export function validEditorPanels(panels: PanelSpec[]): boolean {
  return panels.length > 0 && panels.every(validPanel);
}
