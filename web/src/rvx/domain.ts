import type {
  ExperimentRecord,
  ExperimentRun,
  ExperimentSource,
  ExperimentStats,
  ProjectRecord,
} from "../domain/types";

export type WorkspacePane = "primary" | "secondary";
export type ViewKind =
  | "run-overview"
  | "snapshot-history"
  | "snapshot-diff"
  | "legacy"
  | "metric"
  | "sources"
  | "pipeline"
  | "compare"
  | "experiment-runs"
  | "run-details"
  | "source-detail"
  | "hostmon-section"
  | "system";

export type MetricPanelType = "chart" | "table";

export interface MetricPanelDefinition {
  id: string;
  type: MetricPanelType;
  title: string;
  metrics: string[];
}

export interface MetricSectionDefinition {
  id: string;
  title: string;
  columns: 1 | 2 | 3;
  panelHeight: number;
  panels: MetricPanelDefinition[];
}

export interface ViewDefinition {
  kind: ViewKind;
  title: string;
  projectId?: string;
  experimentId?: string;
  runIds: string[];
  metric?: string;
  sourceId?: string;
  section?: string;
}

export interface ViewState {
  axis: string;
  metric: string;
  sourceIds: string[];
  filters: Record<string, string | number | boolean | null>;
  selectedId: string | null;
  metricSections: MetricSectionDefinition[];
  live: boolean;
  scrollTop: number;
}

export interface WorkspaceTab {
  id: string;
  title: string;
  view: ViewDefinition;
  state: ViewState;
  pane: WorkspacePane;
  pinned: boolean;
  preview: boolean;
}

export interface WorkspaceState {
  tabs: WorkspaceTab[];
  active: Record<WorkspacePane, string | null>;
  focusedPane: WorkspacePane;
  secondaryVisible: boolean;
  recentlyClosed: WorkspaceTab[];
}

export interface WorkspaceData {
  stats: ExperimentStats;
  projects: ProjectRecord[];
  experiments: ExperimentRecord[];
  runs: ExperimentRun[];
  sources: ExperimentSource[];
}

export const DEFAULT_VIEW_STATE: ViewState = {
  axis: "wall_time",
  metric: "train/loss",
  sourceIds: [],
  filters: {},
  selectedId: null,
  metricSections: [],
  live: true,
  scrollTop: 0,
};
