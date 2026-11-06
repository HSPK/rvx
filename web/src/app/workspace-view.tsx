import {use, useCallback, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState, type Ref} from "react";
import {createPortal} from "react-dom";
import {Popover, RadioGroup} from "radix-ui";
import {Check, ChevronDown, Pencil, Plus, RefreshCw, Trash2, X} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import type {ChartCatalog, ChartMetric, ChartRunInfo} from "../domain/snapshots";
import type {ExperimentRun} from "../domain/types";
import {uiIdentifier} from "../core/identifiers";
import {axisLabel, chartPaths, defaultCharts, formatTime, humanize, observedTime, rangeBounds, reporters, timeWindowChoices, type RangeState} from "./model";
import {chartPanel, copyLayout, copyPanel, emptyLayout, type PanelSpec, type WorkspaceLayout, type WorkspaceSet} from "./panels";
import {WorkspaceState, layoutSignature} from "./workspace-state";
import type {MetricCatalogQueryCoordinator} from "./coordinator";
import type {PreferencesStore} from "./preferences";
import type {RunMetadata} from "./run-selector";
import {PanelCanvas} from "./panel-canvas";
import {ChartPanel} from "./chart-panel";
import {RecordPanel} from "./record-panel";
import {PanelEditor} from "./panel-editor";
import {TimeSettings} from "./time-settings";
import {IconButton, Message, SelectControl} from "./react-ui";
import type {ChartData, ChartViewSettings, PanelAction} from "./panel-types";
import {NotificationsContext} from "./notifications";

const blankCatalog: ChartCatalog = {runs: [], metrics: [], defaults: [], axes: ["wall_time", "elapsed"], truncated: false};
const workspaceNames = new Intl.Collator(undefined, {numeric: true});
const errorText = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed.";
type MenuKind = "list" | "save" | "copy" | "conflict" | "discard" | "rename";
interface Menu {kind: MenuKind}
export interface WorkspaceHandle {
  refreshNow: () => void;
  reconcilePreferences: () => void;
  retrySave: () => void;
  prepareToLeave: (action: () => void) => void;
}

interface WorkspaceProps {
  ref?: Ref<WorkspaceHandle>;
  metadata: RunMetadata;
  runIds: string[];
  range: RangeState;
  reads: MetricCatalogQueryCoordinator;
  preferences: PreferencesStore;
  preferenceVersion: number;
  colorFor: (id: string) => string;
  labelFor: (run: ExperimentRun) => string;
  onRange: (range: RangeState) => void;
  onObservations: (runs: ChartRunInfo[]) => void;
  onOpenRuns: () => void;
  onNotice: (text: string | null) => void;
  live: boolean;
  suspended: boolean;
  refreshRevision: number;
  metadataRefreshing: boolean;
  onRefreshRuns: () => void;
}

export function Workspace(props: WorkspaceProps) {
  const notificationHost = use(NotificationsContext);
  const root = useRef<HTMLElement>(null);
  const focusFrame = useRef(0);
  const {metadata, runIds, range, reads, preferences, onNotice, suspended} = props;
  const [layout, setLayout] = useState(emptyLayout);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const runs = useMemo(() => runIds.flatMap(id => metadata.runs.filter(run => run.id === id)), [runIds, metadata]);
  const lastExperiment = useRef("");
  if (runs[0]) lastExperiment.current = runs[0].experiment_id;
  const experimentId = runs[0]?.experiment_id ?? lastExperiment.current;
  const [session] = useState(() => {const session = new WorkspaceState(); session.open(layout, experimentId); return session;});
  const [, notify] = useReducer(value => value + 1, 0);
  const loadedRevision = useRef(0);
  const initialized = useRef(false);
  const [catalog, setCatalog] = useState<ChartCatalog | null>(null);
  const [catalogGeneration, setCatalogGeneration] = useState(-1);
  const [catalogScope, setCatalogScope] = useState("");
  const catalogRequest = useRef<AbortController | null>(null);
  const queryRequest = useRef<AbortController | null>(null);
  const catalogRef = useRef(catalog); catalogRef.current = catalog;
  useEffect(() => {props.onObservations(catalog?.runs ?? []);}, [catalog, props.onObservations]);
  const [catalogError, setCatalogError] = useState("");
  const [data, setData] = useState<Record<string, ChartData>>({});
  const completed = useRef(new Map<string, string>());
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const [editor, setEditor] = useState<{sectionId: string; existing?: PanelSpec} | null>(null);
  const [chartViews, setChartViews] = useState<Record<string, ChartViewSettings>>({});
  useEffect(() => {
    const ids = new Set(layout.panels.map(panel => panel.id));
    setChartViews(previous => Object.keys(previous).some(id => !ids.has(id))
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))) : previous);
  }, [layout.panels]);
  const [timeSettings, setTimeSettings] = useState(false);
  const [notice, setNotice] = useState<{text: string; retry?: () => void} | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef(menu); menuRef.current = menu;
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [formName, setFormName] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const afterSave = useRef<(() => void) | undefined>(undefined);
  const pendingAction = useRef<(() => void) | null>(null);
  const picker = useRef<HTMLButtonElement>(null);
  const [saveExpired, setSaveExpired] = useState(false);
  const scope = session.scope || experimentId;
  const valid = runs.length > 0 && runIds.length <= 4;
  const scopeKey = runs.map(run => run.id).join("\0");
  const rangeKey = JSON.stringify(range);
  const queryRangeKey = JSON.stringify([range.axis, range.window, range.from, range.to]);
  const chartLayoutKey = JSON.stringify(layout.panels.flatMap(panel => panel.kind === "chart" ? [[panel.id, chartPaths(panel)]] : []));
  const active = useMemo(() => {
    if (suspended || !pageVisible || !valid) return new Set<string>();
    return expanded ? new Set([expanded]) : new Set([...visible].filter(id => {
      const panel = layout.panels.find(panel => panel.id === id);
      return panel && !layout.sections.find(section => section.id === panel.sectionId)?.collapsed;
    }));
  }, [suspended, pageVisible, valid, expanded, visible, layout]);
  const activeKey = [...active].sort().join("\0");
  const generation = tick;
  const current = useRef({props, runs, scope, active, catalog, layout, valid, session});
  current.current = {props, runs, scope, active, catalog, layout, valid, session};
  const refreshNow = useCallback(() => {
    if (!catalogRequest.current && !queryRequest.current) setTick(value => value + 1);
  }, []);
  const externalRefresh = useRef(props.refreshRevision);
  useEffect(() => {
    if (externalRefresh.current !== props.refreshRevision) refreshNow();
    externalRefresh.current = props.refreshRevision;
  }, [props.refreshRevision, refreshNow]);
  function showNotice(text: string, retry?: () => void) {setNotice({text, ...(retry ? {retry} : {})});}
  function focusPanel(id?: string) {
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      const target = id ? root.current?.querySelector<HTMLElement>(`[data-panel-id=${JSON.stringify(id)}] .menu-trigger`)
        : root.current?.querySelector<HTMLElement>(".add-chart-button");
      target?.focus({preventScroll: true});
    });
  }
  const updateLayout = useCallback((next: WorkspaceLayout) => {
    initialized.current = true;
    session.changed(next); layoutRef.current = next; setLayout(next); notify();
  }, [session]);
  function replaceLayout(next: WorkspaceLayout, saved?: WorkspaceSet) {
    layoutRef.current = next; setLayout(next);
    session.open(next, saved?.experimentId ?? scope, saved);
    loadedRevision.current = preferences.workspaces.revision;
    initialized.current = saved !== undefined || next.panels.length > 0;
    completed.current.clear(); setExpanded(null); notify();
  }
  function closeMenu() {menuRef.current = null; setMenu(null); setFormError("");}
  function openMenu(kind: MenuKind) {
    const next = {kind};
    menuRef.current = next; setMenu(next); setFormError("");
    if (kind === "save") setFormName(session.id ? session.name : "");
    if (kind === "copy") setFormName(`${session.name} copy`.slice(0, 80));
    if (kind === "rename") setFormName(session.name);
    if (kind === "list" || kind === "rename") void preferences.bootstrap();
  }
  function activateWorkspace(set: WorkspaceSet) {
    const record = preferences.data.sets.find(item => item.id === set.id);
    if (!record) {showNotice("This saved workspace is no longer available. Open the workspace list again."); return;}
    preferences.select(record.experimentId, record.id);
    replaceLayout(copyLayout(record), record); closeMenu();
  }
  function confirmDiscard(action: () => void) {
    if (savingRef.current || preferences.uncertain) {showNotice("Finish or retry the pending save before switching workspaces."); return;}
    if (!session.dirty) {action(); return;}
    pendingAction.current = action; openMenu("discard");
  }
  async function writeWorkspace(name: string, copy = false, rename = false): Promise<boolean> {
    if (!scope) {showNotice("Select a Run before saving a workspace."); return false;}
    if (savingRef.current) return false;
    const stored = rename ? preferences.data.sets.find(set => set.id === session.id) : undefined;
    if (rename && !stored) {showNotice("This workspace is no longer available. Reopen the workspace list."); return false;}
    const owner = menuRef.current;
    savingRef.current = true; setSaving(true);
    const submitted = preferences.uncertain ? await preferences.retrySave()
      : await preferences.save(name, scope, stored ?? layoutRef.current, copy || rename ? preferences.workspaces.revision : loadedRevision.current,
        !copy && session.id && (rename || name === session.name) ? session.id : undefined);
    savingRef.current = false;
    if (!mounted.current) return false;
    setSaving(false);
    if (!submitted) {
      session.failed(); notify();
      if (!rename && preferences.conflict && menuRef.current === owner) openMenu("conflict");
      return false;
    }
    session.saved(submitted, layoutRef.current);
    loadedRevision.current = preferences.lastSavedRevision;
    notify(); return true;
  }
  function saveCurrent(after?: () => void) {
    if (preferences.conflict) {openMenu("conflict"); return;}
    if (preferences.pendingDeletion) {showNotice("Retry the pending deletion in the server settings notification before saving."); return;}
    if (!session.id && !preferences.uncertain) {afterSave.current = after; openMenu("save"); return;}
    const owner = menuRef.current;
    void writeWorkspace(session.name).then(ok => {
      if (ok && menuRef.current === owner) {closeMenu(); if (!session.dirty) after?.();}
    });
  }
  const imperative = useRef<WorkspaceHandle>(null);
  imperative.current = {
    refreshNow, retrySave: () => saveCurrent(), prepareToLeave: confirmDiscard,
    reconcilePreferences: () => {
      if (savingRef.current || preferences.uncertain) return;
      const record = preferences.data.sets.find(set => set.id === session.id);
      if (session.id && !record) {session.detach(); loadedRevision.current = preferences.workspaces.revision; notify(); return;}
      if (!session.id && !session.dirty) {
        const selected = preferences.selected(current.current.scope);
        if (selected) activateWorkspace(selected); else loadedRevision.current = preferences.workspaces.revision;
      } else if (record) {
        session.name = record.name;
        if (layoutSignature(record) !== layoutSignature(layoutRef.current)) {
          showNotice("A newer workspace is available on the server. Your current layout is unchanged.", () => confirmDiscard(() => activateWorkspace(record)));
        } else if (!session.dirty) {
          session.open(layoutRef.current, record.experimentId, record); loadedRevision.current = preferences.workspaces.revision;
        }
        notify();
      }
    },
  };
  useImperativeHandle(props.ref, () => ({
    refreshNow, reconcilePreferences: () => imperative.current!.reconcilePreferences(),
    retrySave: () => imperative.current!.retrySave(), prepareToLeave: action => imperative.current!.prepareToLeave(action),
  }), [refreshNow]);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; cancelAnimationFrame(focusFrame.current); onNotice(null);};}, [onNotice]);
  useEffect(() => {
    const visibility = () => {setPageVisible(!document.hidden); if (!document.hidden && current.current.props.live) refreshNow();};
    const unload = (event: BeforeUnloadEvent) => {
      if (session.dirty || savingRef.current || preferences.uncertain) {event.preventDefault(); event.returnValue = "";}
    };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("beforeunload", unload);
    return () => {document.removeEventListener("visibilitychange", visibility); window.removeEventListener("beforeunload", unload);};
  }, [session, preferences, refreshNow]);
  useEffect(() => {
    if (!props.live || suspended || !pageVisible || !valid) return;
    const timer = setInterval(() => {if (current.current.active.size || !initialized.current) refreshNow();}, 5000);
    return () => clearInterval(timer);
  }, [props.live, suspended, pageVisible, valid, refreshNow]);
  useEffect(() => {
    setEditor(null); setTimeSettings(false);
  }, [scopeKey, rangeKey]);
  useEffect(() => {
    completed.current.clear(); setData({}); setCatalog(null); onNotice(null);
  }, [scopeKey, onNotice]);
  useEffect(() => {completed.current.clear();}, [queryRangeKey]);
  useEffect(() => {
    if (suspended || !pageVisible || !valid) return;
    const request = new AbortController();
    catalogRequest.current = request;
    setCatalogError("");
    void reads.catalog(current.current.runs.map(run => run.id), request.signal, generation > 0).then(value => {
      if (request.signal.aborted) return;
      setCatalog(value); catalogRef.current = value; setCatalogGeneration(generation); setCatalogScope(scopeKey); onNotice(null);
      if (!initialized.current) {
        const saved = preferences.selected(current.current.runs[0]?.experiment_id ?? "");
        const next = saved ? copyLayout(saved) : copyLayout(layoutRef.current);
        if (!saved) next.panels = defaultCharts(value).map(chart => chartPanel(chart, next.sections[0]!.id));
        initialized.current = !!saved || next.panels.length > 0;
        layoutRef.current = next; setLayout(next);
        session.open(next, current.current.runs[0]?.experiment_id ?? "", saved);
        loadedRevision.current = preferences.workspaces.revision; notify();
      }
      if (value.truncated) showNotice("The metric catalog is partial; some fields are outside discovery budgets.");
    }).catch(error => {
      if (request.signal.aborted) return;
      if (layoutRef.current.panels.length) onNotice(`Updates unavailable. ${errorText(error)}`);
      else setCatalogError(errorText(error));
    }).finally(() => {if (catalogRequest.current === request) catalogRequest.current = null;});
    return () => {request.abort(); if (catalogRequest.current === request) catalogRequest.current = null;};
  }, [reads, preferences, session, scopeKey, generation, metadata, suspended, pageVisible, valid, onNotice]);
  const lastGeneration = useRef(-1);
  useEffect(() => {
    if (!catalog || catalogGeneration !== generation || catalogScope !== scopeKey || suspended || !pageVisible || !valid) return;
    const request = new AbortController();
    const fresh = lastGeneration.current !== generation; lastGeneration.current = generation;
    const key = `${scopeKey}:${queryRangeKey}:${JSON.stringify(catalog.metrics.map(metric => [metric.path, metric.sources.map(source => [source.run_id, source.source_id])]))}`;
    const charts = layout.panels.filter((panel): panel is Extract<PanelSpec, {kind: "chart"}> => panel.kind === "chart" && active.has(panel.id)
      && (fresh || completed.current.get(panel.id) !== `${key}:${chartPaths(panel).join("\0")}`));
    if (!charts.length) return;
    const metricsFor = (paths: string[]): ChartMetric[] => paths.map(path => catalog.metrics.find(metric => metric.path === path)
      ?? {path, name: humanize(path.split("/").at(-1) ?? "Metric"), group: "Saved field", unit: null, run_ids: [], sources: []});
    const allMetrics = metricsFor([...new Set(charts.flatMap(chartPaths))]);
    const metrics = allMetrics.filter(metric => metric.sources.length);
    const ids = new Set(charts.map(panel => panel.id));
    setData(old => {
      const next = {...old};
      for (const panel of charts) {
        const unavailable = !chartPaths(panel).some(path => metrics.some(metric => metric.path === path));
        next[panel.id] = {...(old[panel.id] ?? {series: []}), metrics: metricsFor(chartPaths(panel)), axis: range.axis,
          pending: !unavailable && catalog.axes.includes(range.axis), error: catalog.axes.includes(range.axis) ? null : "This alignment is not recorded. Choose another time alignment.",
          unavailable, truncated: catalog.truncated};
      }
      return next;
    });
    if (!catalog.axes.includes(range.axis) || !metrics.length) return;
    queryRequest.current = request;
    const sources = [...new Set(metrics.flatMap(metric => runs.flatMap(run => reporters(metric, run.id).map(source => source.source_id))))];
    const delay = setTimeout(() => {
      void reads.query({run_ids: runs.map(run => run.id), paths: metrics.map(metric => metric.path),
        ...(sources.length ? {source_ids: sources} : {}), axis: range.axis, ...rangeBounds(range, catalog),
        max_points: Math.max(1, Math.min(1600, Math.floor(40_000 / Math.max(1, metrics.reduce((sum, metric) => sum + metric.sources.length, 0)))))},
      request.signal, fresh).then(result => {
        if (request.signal.aborted) return;
        if (result.axis !== range.axis) throw new Error("The returned projection uses another alignment.");
        setData(old => {
          const next = {...old};
          for (const panel of charts) {
            const paths = chartPaths(panel);
            next[panel.id] = {metrics: metricsFor(paths), series: result.series.filter(series => paths.includes(series.path)), axis: result.axis,
              pending: false, error: null, unavailable: !paths.some(path => metrics.some(metric => metric.path === path)), truncated: catalog.truncated};
            completed.current.set(panel.id, `${key}:${paths.join("\0")}`);
          }
          return next;
        });
      }).catch(error => {
        if (!request.signal.aborted) setData(old => Object.fromEntries(Object.entries(old).map(([id, value]) =>
          [id, ids.has(id) ? {...value, pending: false, error: errorText(error)} : value])));
      }).finally(() => {if (queryRequest.current === request) queryRequest.current = null;});
    }, 40);
    return () => {request.abort(); clearTimeout(delay); if (queryRequest.current === request) queryRequest.current = null;};
  }, [catalog, catalogGeneration, catalogScope, activeKey, queryRangeKey, scopeKey, generation, chartLayoutKey, reads, suspended, pageVisible, valid]);
  const preferenceIdentity = `${preferences.workspaces.revision}:${preferences.data.selected[scope] ?? ""}`;
  useEffect(() => {
    if (menu?.kind === "list") void preferences.bootstrap();
  }, [menu, preferences]);
  useEffect(() => {
    if (initialized.current) imperative.current?.reconcilePreferences();
  }, [preferenceIdentity]);
  const saveState = saving ? "saving" : session.saveFailed || preferences.uncertain ? "failed" : session.status;
  useEffect(() => {
    setSaveExpired(false);
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveExpired(true), 3000);
    return () => clearTimeout(timer);
  }, [saveState, session.id]);
  useEffect(() => {document.title = `${session.dirty ? "* " : ""}${session.name} · RVX`;}, [session.dirty, session.name]);
  useEffect(() => {if (expanded && !layout.panels.some(panel => panel.id === expanded)) setExpanded(null);}, [layout, expanded]);
  function panelAction(panel: PanelSpec, action: PanelAction) {
    if (action === "expand") {setExpanded(id => id === panel.id ? null : panel.id); return;}
    if (action === "edit") {setEditor({existing: copyPanel(panel), sectionId: panel.sectionId}); return;}
    const next = copyLayout(layoutRef.current);
    const index = next.panels.findIndex(item => item.id === panel.id);
    next.panels = next.panels.filter(item => item.id !== panel.id);
    updateLayout(next);
    focusPanel((next.panels[index] ?? next.panels.at(-1))?.id);
  }
  function panelChanged(changed: PanelSpec) {
    const next = copyLayout(layoutRef.current), index = next.panels.findIndex(panel => panel.id === changed.id);
    if (index < 0) return;
    const existing = next.panels[index]!;
    next.panels[index] = {...copyPanel(changed), id: existing.id, sectionId: existing.sectionId, size: existing.size}; updateLayout(next);
  }
  async function submitForm() {
    const name = formName.trim(), kind = menuRef.current?.kind;
    if (!name) {setFormError(kind === "rename" ? "Enter a name." : "Give the workspace set a name."); return;}
    if (kind === "copy" && preferences.data.sets.some(set => set.experimentId === scope && set.name === name)) {
      setFormError("Choose a new name to preserve the server version."); return;
    }
    if (kind === "rename" && name === session.name) {closeMenu(); return;}
    const owner = menuRef.current;
    const ok = await writeWorkspace(name, kind === "copy", kind === "rename");
    if (menuRef.current !== owner) return;
    if (ok && (kind !== "rename" || session.name === name)) {
      const after = afterSave.current; afterSave.current = undefined; closeMenu(); if (!session.dirty) after?.();
    } else setFormError(ok ? "Previous rename confirmed. Apply the new name."
      : kind === "rename" ? preferences.error || "Rename failed." : `Save failed. Your draft remains available.${preferences.error ? ` ${preferences.error}` : ""}`);
  }
  const latest = catalog?.runs.flatMap(run => run.last_observed_at_ns === null ? [] : [run.last_observed_at_ns]) ?? [];
  const latestTime = latest.length ? Math.max(...latest) : null;
  const sets = preferences.data.sets.filter(set => set.experimentId === scope)
    .sort((a, b) => Number(b.id === session.id) - Number(a.id === session.id) || workspaceNames.compare(a.name, b.name));
  const filteredSets = sets.filter(set => set.name.toLocaleLowerCase().includes(workspaceSearch.toLocaleLowerCase()));
  const setNameExists = preferences.data.sets.some(set => set.experimentId === scope && set.name === formName.trim());
  const title = menu?.kind === "save" ? "Save workspace" : menu?.kind === "copy" ? "Save workspace copy"
    : menu?.kind === "conflict" ? "Workspace changed on server" : menu?.kind === "discard" ? "Unsaved changes" : "Workspace sets";
  const form = <form className={`workspace-save-form ${menu?.kind === "rename" ? "is-renaming" : ""}`}
    onSubmit={event => {event.preventDefault(); void submitForm();}}>
    <Input className={`text-input ${menu?.kind === "rename" ? "workspace-rename-input" : ""}`} maxLength={80}
      aria-label={menu?.kind === "rename" ? "Workspace name" : "Workspace set name"} placeholder="Workspace name"
      value={formName} onChange={event => {setFormName(event.target.value); setFormError("");}} disabled={saving} />
    <Button size="sm" type="submit" disabled={!scope || saving}
      aria-label={menu?.kind === "rename" ? "Apply workspace name" : setNameExists ? "Update workspace set" : "Save workspace set"}>
      {menu?.kind === "rename" ? <Check /> : setNameExists ? "Update" : "Save"}
    </Button>
    {menu?.kind === "rename" && <IconButton label="Cancel rename" disabled={saving} onClick={() => openMenu("list")}><X /></IconButton>}
    {formError && <p className={`error-text ${menu?.kind === "rename" ? "workspace-rename-error" : ""}`} role="status">{formError}</p>}
  </form>;
  return <main ref={root} className="workspace-page">
    <h1 className="sr-only">Run analysis</h1>
    <div className="workspace-controls" inert={expanded !== null}>
      <div className="workspace-header-host">
        <div className="workspace-header" data-workspace-id={session.id ?? ""}>
          <Popover.Root open={menu !== null} onOpenChange={open => {if (!open) closeMenu(); else openMenu("list");}}>
            <Popover.Trigger asChild><Button ref={picker} variant="ghost" className="workspace-picker" aria-label="Workspace sets"
              title={`${session.name} · ${metadata.experiments.find(experiment => experiment.id === scope)?.name ?? ""}${session.id ? " · F2 to rename" : ""}`}
              aria-keyshortcuts="F2 ArrowDown" onKeyDown={event => {
                if (event.key === "F2") {event.preventDefault(); openMenu(session.id ? "rename" : "list");}
                if (event.key === "ArrowDown") {event.preventDefault(); openMenu("list");}
              }}><span>{session.name}</span><ChevronDown /></Button></Popover.Trigger>
            <Popover.Portal><Popover.Content className={`workspace-popover react-popover ${menu?.kind === "list" || menu?.kind === "rename" ? "workspace-menu" : ""}`} sideOffset={6} align="start" aria-label={title}
              onOpenAutoFocus={event => {
                event.preventDefault();
                if (event.target instanceof HTMLElement) event.target.focus({preventScroll: true});
              }}>
              <div className="dialog-body">
                {menu?.kind === "list" && <>
                  {(sets.length > 8 || workspaceSearch) && <Input className="text-input workspace-search" type="search" placeholder="Find workspace"
                    aria-label="Search workspaces" value={workspaceSearch} onChange={event => setWorkspaceSearch(event.target.value)} />}
                  <div className="workspace-set-list" onKeyDown={event => {
                    if ((event.target as HTMLElement).tagName === "INPUT" || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                    const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".saved-set-name")];
                    if (!choices.length) return;
                    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
                    event.preventDefault();
                    choices[event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length]?.focus();
                  }}>
                    {filteredSets.map(set => <div className="saved-set" key={set.id}>
                      <Button variant="ghost" className="saved-set-name" data-workspace-id={set.id} aria-current={set.id === session.id ? "true" : undefined}
                        onClick={() => {if (set.id === session.id && !session.dirty) closeMenu(); else confirmDiscard(() => activateWorkspace(set));}}>{set.name}</Button>
                      {set.id === session.id && <IconButton label="Rename workspace" onClick={() => openMenu("rename")}><Pencil /></IconButton>}
                      <IconButton label={`Delete workspace set ${set.name}`} disabled={preferences.saving} onClick={() => {
                        void preferences.remove(set.id).then(ok => {
                          if (!ok) {if (preferences.conflict) openMenu("conflict"); return;}
                          if (session.id === set.id) {session.detach(); loadedRevision.current = preferences.workspaces.revision; notify();}
                        });
                      }}><Trash2 /></IconButton>
                    </div>)}
                    {!filteredSets.length && workspaceSearch && <p className="workspace-list-empty muted">No matches</p>}
                  </div>
                  <div className="workspace-list-actions">
                    {session.id && <Button variant="ghost" onClick={() => {afterSave.current = undefined; openMenu("save");}}>Save as…</Button>}
                    <IconButton label="Reset to defaults" onClick={() => confirmDiscard(() => {
                      if (scope) preferences.select(scope, null);
                      const next = emptyLayout(); next.panels = (catalog ? defaultCharts(catalog) : []).map(chart => chartPanel(chart, next.sections[0]!.id));
                      replaceLayout(next); closeMenu();
                    })}><RefreshCw /></IconButton>
                  </div>
                  {!session.id && form}
                </>}
                {menu && ["save", "copy", "rename"].includes(menu.kind) && form}
                {menu?.kind === "conflict" && <>
                  <p className="workspace-confirm-message">Changed on the server. Your draft is preserved.</p>
                  <div className="workspace-confirm-actions">
                    <Button variant="ghost" aria-label="Reload server version" onClick={() => {
                      const record = preferences.data.sets.find(set => set.id === (session.id ?? preferences.conflictRecord?.id));
                      preferences.conflict = null;
                      if (record) activateWorkspace(record); else {session.detach(); loadedRevision.current = preferences.workspaces.revision; closeMenu(); notify();}
                    }}>Reload</Button>
                    <Button onClick={() => openMenu("copy")}>Save copy</Button>
                    <Button variant="ghost" onClick={closeMenu}>Keep draft</Button>
                  </div>
                </>}
                {menu?.kind === "discard" && <>
                  <p className="workspace-confirm-message">“{session.name}” has unsaved changes.</p>
                  <div className="workspace-confirm-actions">
                    <Button aria-label="Save and continue" onClick={() => saveCurrent(pendingAction.current ?? undefined)}>Save</Button>
                    <Button variant="ghost" aria-label="Discard changes" onClick={() => {const action = pendingAction.current; closeMenu(); action?.();}}>Discard</Button>
                    <Button variant="ghost" onClick={closeMenu}>Cancel</Button>
                  </div>
                </>}
              </div>
            </Popover.Content></Popover.Portal>
          </Popover.Root>
          <div className="workspace-save-slot" data-state={saveState} data-expired={saveExpired}>
            {saving || saveState === "saved" ? <span className="workspace-save-status" role="status" data-state={saveState}
              title="Panel layout and table settings are saved on the server. Runs and time range stay in the URL.">{saving ? "Saving…" : "Saved"}</span>
              : <Button size="sm" className={`workspace-save ${session.dirty || saveState === "failed" ? "save-needed" : ""}`} disabled={!scope}
                aria-label={saveState === "failed" ? "Retry saving workspace" : "Save current workspace"}
                title={saveState === "failed" ? "Save failed. Your changes are not saved." : session.dirty ? "Unsaved changes" : "Save this workspace"}
                onClick={() => saveCurrent()}><span>{saveState === "failed" ? "Retry save" : "Save"}</span></Button>}
          </div>
        </div>
      </div>
      <div className="chart-toolbar">
        <RadioGroup.Root className="chart-axis-controls" aria-label="X axis" value={range.axis} onValueChange={axis => {
          const {from: _from, to: _to, ...next} = range;
          const window = ["wall_time", "elapsed"].includes(axis) && range.window !== "custom" ? range.window : "all";
          props.onRange({...next, axis, window});
        }}>
          {[...new Set([...(catalog?.axes ?? blankCatalog.axes), range.axis])].map(axis =>
            <RadioGroup.Item key={axis} value={axis} className="chart-axis-choice">
              {axis === "wall_time" ? "Time" : axis === "elapsed" ? "Relative" : axisLabel(axis)}
            </RadioGroup.Item>)}
        </RadioGroup.Root>
        {range.axis === "wall_time" && <SelectControl label="X-axis labels" value={range.timeFormat ?? "auto"}
          options={[["auto", "Auto"], ["time", "Time"], ["date", "Date"]]} onChange={format => {
            const {timeFormat: _format, ...next} = range;
            props.onRange(format === "auto" ? next : {...next, timeFormat: format === "date" ? "date" : "time"});
          }} />}
        <div className="time-controls"><SelectControl label="Time range" title={`${axisLabel(range.axis)} · Time range`} value={range.window}
          onReselect={value => {if (value === "custom") setTimeSettings(true);}}
          options={timeWindowChoices.map(([value, name]) => [value, value === "custom" && range.window === "custom" ? "Custom" : name,
            !["wall_time", "elapsed"].includes(range.axis) && !["all", "custom"].includes(value)] as const)}
          onChange={window => {
            if (window === "custom") {setTimeSettings(true); return;}
            const {from: _from, to: _to, ...next} = range; props.onRange({...next, window});
          }} /></div>
        <div className="chart-actions">
          <div className="collection-freshness">{latestTime !== null ? <><span className="freshness-label">Updated </span>
            <span className="freshness-time" title={formatTime(latestTime)}>{observedTime(latestTime)}</span></>
            : catalog && runs.length ? "Waiting for data" : ""}</div>
          <Button variant="ghost" className="add-chart-button" disabled={runIds.length > 4}
            onClick={() => setEditor({sectionId: layout.sections[0]!.id})}><Plus />Add</Button>
        </div>
      </div>
      {(runIds.length > 4 || runIds.length > runs.length) && <p className="selection-feedback muted" role="status">
        {runIds.length > 4 ? "Select up to 4 runs so overlays remain readable." : `${runIds.length - runs.length} selected ${runIds.length - runs.length === 1 ? "run is" : "runs are"} unavailable.`}
      </p>}
    </div>
    {notice && notificationHost && createPortal(<div className="workspace-notice workspace-local-notice" role="status"><span>{notice.text}</span>
      {notice.retry && <Button variant="ghost" onClick={notice.retry}>Try again</Button>}
      <IconButton label="Dismiss message" onClick={() => setNotice(null)}><X /></IconButton>
    </div>, notificationHost)}
    <div className="chart-scroll" tabIndex={0} role="region" aria-label="Analysis panels">
      <div className="selection-empty" hidden={valid}>
        {!metadata.runs.length && !runIds.length ? <Message title="No runs yet" description="Set up a Run and register a Source with the RVX CLI, then refresh the Run list.">
          <Button aria-label="Refresh runs" disabled={props.metadataRefreshing} onClick={props.onRefreshRuns}>{props.metadataRefreshing ? "Refreshing…" : "Refresh runs"}</Button>
        </Message> : <Message title={runIds.length > 4 ? "Select up to 4 runs" : runIds.length ? "Selected runs unavailable" : "Select runs"}>
          <Button onClick={props.onOpenRuns}>Choose runs</Button>
        </Message>}
      </div>
      <div className="panel-workspace" hidden={!valid}>
        {catalogError && !catalog && !layout.panels.length ? <Message title="Could not load panels" description={catalogError}><Button onClick={refreshNow}>Try again</Button></Message>
          : !catalog && !layout.panels.length ? <Message title="Loading panels…" />
            : !layout.panels.length && layout.sections.length === 1 && !layout.sections[0]!.name ? <Message
              title={initialized.current ? "No panels selected" : !catalog?.runs.some(run => run.snapshot_count) ? "Waiting for the first observation"
                : !catalog.metrics.length ? "Choose a snapshot view" : "Choose recorded fields"}>
              <Button variant="ghost" onClick={() => setEditor({sectionId: layout.sections[0]!.id})}><Plus />Add panel</Button>
            </Message>
            : <PanelCanvas layout={layout} onChange={updateLayout} onAdd={sectionId => setEditor({sectionId})} expanded={expanded}
              onExpandedChange={setExpanded} onVisibleChange={setVisible} renderPanel={panel => {
                const common = {catalog: catalog ?? blankCatalog, runs, range, reads, colorFor: props.colorFor, labelFor: props.labelFor,
                  active: active.has(panel.id), refreshRevision: generation, onAction: (action: PanelAction) => panelAction(panel, action)};
                return panel.kind === "chart" ? <ChartPanel {...common} spec={panel} viewSettings={chartViews[panel.id]} onChange={panelChanged} onRetry={refreshNow}
                  data={data[panel.id] ?? {metrics: chartPaths(panel).map(path => catalog?.metrics.find(metric => metric.path === path)
                    ?? {path, name: humanize(path.split("/").at(-1) ?? "Metric"), group: "Saved field", unit: null, run_ids: [], sources: []}),
                    series: [], axis: range.axis, pending: !catalogError, error: catalogError || null, unavailable: false, truncated: catalog?.truncated ?? false}} />
                  : <RecordPanel {...common} spec={panel} onChange={panelChanged} />;
              }} />}
      </div>
    </div>
    {editor && <PanelEditor catalog={catalog ?? blankCatalog} runs={runs} range={{...range}} layout={copyLayout(layout)} reads={reads}
      chartView={editor.existing ? chartViews[editor.existing.id] : undefined}
      previewData={editor.existing?.kind === "chart" ? data[editor.existing.id] : undefined}
      colorFor={props.colorFor} labelFor={props.labelFor} targetSection={editor.sectionId}
      {...(editor.existing ? {existing: editor.existing} : {})} onClose={() => {setEditor(null); focusPanel(editor.existing?.id);}}
      onCommit={result => {
        const next = copyLayout(layoutRef.current);
        if (result.kind === "section") next.sections.push({id: uiIdentifier("section"), name: result.name.trim().slice(0, 100) || "Untitled section", collapsed: false});
        else {
          const index = editor.existing ? next.panels.findIndex(panel => panel.id === editor.existing!.id) : -1;
          if (index >= 0) next.panels.splice(index, 1, ...result.panels.map(copyPanel)); else next.panels.push(...result.panels.map(copyPanel));
          for (const panel of result.panels) {const section = next.sections.find(section => section.id === panel.sectionId); if (section) section.collapsed = false;}
          const view = result.chartView;
          if (view) setChartViews(previous => ({...previous, ...Object.fromEntries(result.panels.map(panel => [panel.id, view]))}));
        }
        updateLayout(next); setEditor(null); focusPanel(editor.existing?.id);
      }} />}
    {timeSettings && <TimeSettings range={range}
      bounds={catalog ? rangeBounds(range, catalog) : range} onChange={props.onRange} onClose={() => setTimeSettings(false)} />}
  </main>;
}
