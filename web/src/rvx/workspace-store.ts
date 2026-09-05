import {
  DEFAULT_VIEW_STATE,
  type ViewDefinition,
  type ViewState,
  type WorkspacePane,
  type WorkspaceState,
  type WorkspaceTab,
  type MetricSectionDefinition,
} from "./domain";
import {readBrowserStorage} from "./browser-storage";

export const WORKSPACE_STORAGE_KEY = "rvx.workspace.snapshots.v1";
const MAX_RECENTLY_CLOSED = 20;

export interface WorkspacePersistence {
  load(): WorkspaceState | null;
  save(state: WorkspaceState): void;
}

export class BrowserWorkspacePersistence implements WorkspacePersistence {
  load(): WorkspaceState | null {
    try {
      const raw = readBrowserStorage(WORKSPACE_STORAGE_KEY);
      return raw ? JSON.parse(raw) as WorkspaceState : null;
    } catch {
      return null;
    }
  }

  save(state: WorkspaceState): void {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify(state),
    );
  }
}

export class WorkspaceStore {
  private value: WorkspaceState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly persistence: WorkspacePersistence) {
    this.value = normalizeWorkspace(persistence.load());
  }

  snapshot(): WorkspaceState {
    return cloneWorkspace(this.value);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.value.tabs = [];
    this.value.active = {primary: null, secondary: null};
    this.value.focusedPane = "primary";
    this.value.secondaryVisible = false;
    this.commit();
  }

  open(
    view: ViewDefinition,
    options: {
      pane?: WorkspacePane;
      preview?: boolean;
      pinned?: boolean;
    } = {},
  ): WorkspaceTab {
    return this.insert(view, options);
  }

  /** Replaces all open tabs with one route-authoritative View in one commit. */
  replace(
    view: ViewDefinition,
    options: {
      pane?: WorkspacePane;
      preview?: boolean;
      pinned?: boolean;
    } = {},
  ): WorkspaceTab {
    this.value.tabs = [];
    this.value.active = {primary: null, secondary: null};
    this.value.focusedPane = options.pane ?? "primary";
    this.value.secondaryVisible = options.pane === "secondary";
    return this.insert(view, options);
  }

  /** Inserts one View and commits its resulting Workspace state. */
  private insert(
    view: ViewDefinition,
    options: {
      pane?: WorkspacePane;
      preview?: boolean;
      pinned?: boolean;
    },
  ): WorkspaceTab {
    const pane = options.pane ?? this.value.focusedPane;
    const preview = options.preview ?? false;
    if (preview) {
      const existing = this.value.tabs.find(
        tab => tab.pane === pane && tab.preview && !tab.pinned,
      );
      if (existing) {
        existing.title = view.title;
        existing.view = cloneView(view);
        existing.state = stateForView(view);
        this.value.active[pane] = existing.id;
        this.value.focusedPane = pane;
        this.commit();
        return cloneTab(existing);
      }
    }
    const tab: WorkspaceTab = {
      id: newTabId(),
      title: view.title,
      view: cloneView(view),
      state: stateForView(view),
      pane,
      pinned: options.pinned ?? false,
      preview: preview && !(options.pinned ?? false),
    };
    this.value.tabs.push(tab);
    this.value.active[pane] = tab.id;
    this.value.focusedPane = pane;
    if (pane === "secondary") this.value.secondaryVisible = true;
    this.commit();
    return cloneTab(tab);
  }

  activate(tabId: string): void {
    const tab = this.find(tabId);
    if (!tab) return;
    this.value.active[tab.pane] = tab.id;
    this.value.focusedPane = tab.pane;
    this.commit();
  }

  pin(tabId: string): void {
    const tab = this.find(tabId);
    if (!tab) return;
    tab.pinned = true;
    tab.preview = false;
    this.commit();
  }

  close(tabId: string): void {
    const index = this.value.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    const [closed] = this.value.tabs.splice(index, 1);
    if (!closed) return;
    this.value.recentlyClosed.unshift(cloneTab(closed));
    this.value.recentlyClosed.splice(MAX_RECENTLY_CLOSED);
    if (this.value.active[closed.pane] === tabId) {
      const candidates = this.value.tabs.filter(
        tab => tab.pane === closed.pane,
      );
      this.value.active[closed.pane] =
        candidates.at(Math.min(index, candidates.length - 1))?.id ?? null;
    }
    if (!this.value.tabs.some(tab => tab.pane === "secondary")) {
      this.value.secondaryVisible = false;
      this.value.active.secondary = null;
      this.value.focusedPane = "primary";
    }
    this.commit();
  }

  duplicate(tabId: string): WorkspaceTab | null {
    const source = this.find(tabId);
    if (!source) return null;
    const duplicate = {...cloneTab(source), id: newTabId(), pinned: true, preview: false};
    this.value.tabs.push(duplicate);
    this.value.active[duplicate.pane] = duplicate.id;
    this.value.focusedPane = duplicate.pane;
    this.commit();
    return cloneTab(duplicate);
  }

  move(tabId: string, pane: WorkspacePane): void {
    const tab = this.find(tabId);
    if (!tab || tab.pane === pane) return;
    const previousPane = tab.pane;
    tab.pane = pane;
    if (this.value.active[previousPane] === tab.id) {
      this.value.active[previousPane] =
        this.value.tabs.find(item => item.pane === previousPane)?.id ?? null;
    }
    this.value.active[pane] = tab.id;
    this.value.focusedPane = pane;
    this.value.secondaryVisible =
      pane === "secondary" ||
      this.value.tabs.some(item => item.pane === "secondary");
    this.commit();
  }

  updateState(tabId: string, changes: Partial<ViewState>): void {
    const tab = this.find(tabId);
    if (!tab) return;
    tab.state = {
      ...tab.state,
      ...changes,
      sourceIds: changes.sourceIds
        ? [...changes.sourceIds]
        : tab.state.sourceIds,
      filters: changes.filters
        ? {...changes.filters}
        : tab.state.filters,
      metricSections: changes.metricSections
        ? cloneSections(changes.metricSections)
        : tab.state.metricSections,
    };
    if (tab.preview) {
      tab.preview = false;
      tab.pinned = true;
    }
    this.commit();
  }

  updateTitle(tabId: string, title: string): void {
    const tab = this.find(tabId);
    if (!tab || !title.trim()) return;
    tab.title = title.trim();
    this.commit();
  }

  /** Persists local inspector controls without rebuilding the workspace. */
  rememberState(tabId: string, changes: Pick<ViewState, "filters" | "selectedId">): void {
    const tab = this.find(tabId);
    if (!tab) return;
    tab.state.filters = {...changes.filters};
    tab.state.selectedId = changes.selectedId;
    this.persistence.save(this.snapshot());
  }

  updateView(tabId: string, changes: Partial<ViewDefinition>): void {
    const tab = this.find(tabId);
    if (!tab) return;
    tab.view = {
      ...tab.view,
      ...changes,
      runIds: changes.runIds ? [...changes.runIds] : tab.view.runIds,
    };
    if (changes.title?.trim()) tab.title = changes.title.trim();
    if (tab.preview) {
      tab.preview = false;
      tab.pinned = true;
    }
    this.commit();
  }

  restoreClosed(): WorkspaceTab | null {
    const closed = this.value.recentlyClosed.shift();
    if (!closed) return null;
    const restored = {
      ...cloneTab(closed),
      id: newTabId(),
      preview: false,
      pinned: true,
    };
    this.value.tabs.push(restored);
    this.value.active[restored.pane] = restored.id;
    this.value.focusedPane = restored.pane;
    if (restored.pane === "secondary") this.value.secondaryVisible = true;
    this.commit();
    return cloneTab(restored);
  }

  activeTab(pane: WorkspacePane = this.value.focusedPane): WorkspaceTab | null {
    const id = this.value.active[pane];
    const tab = id ? this.find(id) : null;
    return tab ? cloneTab(tab) : null;
  }

  private find(tabId: string): WorkspaceTab | undefined {
    return this.value.tabs.find(tab => tab.id === tabId);
  }

  private commit(): void {
    this.persistence.save(this.snapshot());
    for (const listener of this.listeners) listener();
  }
}

function stateForView(view: ViewDefinition): ViewState {
  return {
    ...DEFAULT_VIEW_STATE,
    metric: view.metric ?? DEFAULT_VIEW_STATE.metric,
    sourceIds: [],
    filters: {},
    metricSections:
      view.kind === "metric"
        ? [
            {
              id: "section-main",
              title: "Metrics",
              columns: 2,
              panelHeight: 220,
              panels: [
                {
                  id: "panel-main",
                  type: "chart",
                  title: view.metric ?? DEFAULT_VIEW_STATE.metric,
                  metrics: [view.metric ?? DEFAULT_VIEW_STATE.metric],
                },
              ],
            },
          ]
        : [],
  };
}

function normalizeWorkspace(value: WorkspaceState | null): WorkspaceState {
  if (!value || !Array.isArray(value.tabs)) {
    return {
      tabs: [],
      active: {primary: null, secondary: null},
      focusedPane: "primary",
      secondaryVisible: false,
      recentlyClosed: [],
    };
  }
  const tabs = value.tabs.map(cloneTab);
  const valid = new Set(tabs.map(tab => tab.id));
  return {
    tabs,
    active: {
      primary: valid.has(value.active?.primary ?? "")
        ? value.active.primary
        : tabs.find(tab => tab.pane === "primary")?.id ?? null,
      secondary: valid.has(value.active?.secondary ?? "")
        ? value.active.secondary
        : tabs.find(tab => tab.pane === "secondary")?.id ?? null,
    },
    focusedPane:
      value.focusedPane === "secondary" ? "secondary" : "primary",
    secondaryVisible:
      Boolean(value.secondaryVisible) &&
      tabs.some(tab => tab.pane === "secondary"),
    recentlyClosed: Array.isArray(value.recentlyClosed)
      ? value.recentlyClosed.slice(0, MAX_RECENTLY_CLOSED).map(cloneTab)
      : [],
  };
}

function cloneWorkspace(value: WorkspaceState): WorkspaceState {
  return {
    tabs: value.tabs.map(cloneTab),
    active: {...value.active},
    focusedPane: value.focusedPane,
    secondaryVisible: value.secondaryVisible,
    recentlyClosed: value.recentlyClosed.map(cloneTab),
  };
}

function cloneTab(tab: WorkspaceTab): WorkspaceTab {
  return {
    ...tab,
    view: cloneView(tab.view),
    state: {
      ...tab.state,
      sourceIds: [...tab.state.sourceIds],
      filters: {...tab.state.filters},
      metricSections: cloneSections(tab.state.metricSections ?? []),
    },
  };
}

function cloneView(view: ViewDefinition): ViewDefinition {
  return {...view, runIds: [...view.runIds]};
}

function cloneSections(
  sections: MetricSectionDefinition[],
): MetricSectionDefinition[] {
  return sections.map(section => ({
    ...section,
    columns: section.columns ?? 2,
    panelHeight: section.panelHeight ?? 220,
    panels: section.panels.map(panel => ({
      ...panel,
      metrics: [...panel.metrics],
    })),
  }));
}

let fallbackId = 0;

function newTabId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `tab-${++fallbackId}`;
}
