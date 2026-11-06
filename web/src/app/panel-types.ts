import type {ReactNode, Ref} from "react";
import type {ChartCatalog, ChartMetric, SnapshotQuerySeries} from "../domain/snapshots";
import type {ExperimentRun} from "../domain/types";
import type {MetricCatalogQueryCoordinator} from "./coordinator";
import type {RangeState} from "./model";
import type {ChartPanel, PanelSpec, TablePanelSpec, WorkspaceLayout} from "./panels";

export type PanelAction = "edit" | "expand" | "remove";

export interface PanelProps<T extends PanelSpec = PanelSpec> {
  spec: T;
  catalog: ChartCatalog;
  runs: ExperimentRun[];
  range: RangeState;
  reads: MetricCatalogQueryCoordinator;
  colorFor: (id: string) => string;
  labelFor: (run: ExperimentRun) => string;
  active: boolean;
  refreshRevision: number;
  onChange: (spec: T) => void;
  onAction: (action: PanelAction) => void;
}

export interface ChartData {
  metrics: ChartMetric[];
  series: SnapshotQuerySeries[];
  axis: string;
  pending: boolean;
  error: string | null;
  unavailable: boolean;
  truncated: boolean;
}

export interface ChartPanelProps extends PanelProps<ChartPanel> {
  data: ChartData;
  onRetry: () => void;
  ref?: Ref<ChartHandle>;
  viewSettings?: ChartViewSettings | undefined;
  onExportReady?: (ready: boolean) => void;
}
export interface ChartViewSettings {smoothing: number; logarithmic: boolean}
export interface ChartHandle {exportPng: () => Promise<void>}

export type RecordPanelProps = PanelProps<TablePanelSpec>;

export interface PanelFrameProps {
  spec: PanelSpec;
  title: string;
  unit?: string | null;
  refreshing?: boolean;
  status?: string;
  path?: string;
  loaded?: boolean;
  view?: string;
  menuActions?: {label: string; onSelect: () => void; disabled?: boolean}[];
  className?: string;
  actions?: ReactNode;
  children: ReactNode;
  onAction: (action: PanelAction) => void;
}

export interface PanelEditorProps {
  catalog: ChartCatalog;
  runs: ExperimentRun[];
  range: RangeState;
  layout: WorkspaceLayout;
  reads: MetricCatalogQueryCoordinator;
  colorFor: (id: string) => string;
  labelFor: (run: ExperimentRun) => string;
  existing?: PanelSpec;
  targetSection: string;
  chartView?: ChartViewSettings | undefined;
  previewData?: ChartData | undefined;
  onCommit: (result: {kind: "section"; name: string} | {kind: "panels"; panels: PanelSpec[]; chartView?: ChartViewSettings}) => void;
  onClose: () => void;
}
