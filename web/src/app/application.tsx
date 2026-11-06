import {useCallback, useEffect, useMemo, useRef, useState, type CSSProperties} from "react";
import {RefreshCw, X} from "lucide-react";
import {MetricCatalogQueryCoordinator} from "./coordinator";
import {PreferencesStore} from "./preferences";
import {filteredRuns, filtersFrom, initialRange, routeFrom, RunColors, workspaceUrl, type RunFilters, type RangeState} from "./model";
import {scopedRunLabels} from "./run-context";
import {RunsPanel} from "./runs-panel";
import {RunSelector, type RunMetadata} from "./run-selector";
import {ConnectionIndicator} from "./connection-indicator";
import {Workspace, type WorkspaceHandle} from "./workspace-view";
import {RunInspector} from "./run-inspector";
import {RunColorPicker} from "./run-color-picker";
import {IconButton, Message} from "./react-ui";
import {Button} from "@/components/ui/button";
import {NotificationsContext} from "./notifications";
import type {ExperimentRun} from "../domain/types";
import type {ChartRunInfo} from "../domain/snapshots";

type NoticeKind = "preferences" | "metadata" | "authentication" | "updates";
interface RouteState {runIds: string[] | null; filters: RunFilters; range: RangeState; missing: boolean}
const panelStorage = "rvx-runs-panel-v1";

function readRoute(): RouteState {
  const url = new URL(location.href), route = routeFrom(url);
  return {runIds: route.kind === "workspace" ? route.runIds : null, filters: filtersFrom(url), range: initialRange(url), missing: route.kind === "missing"};
}

function panelState() {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(panelStorage) ?? "null");
    return {collapsed: !!saved && typeof saved === "object" && "collapsed" in saved && saved.collapsed === true,
      expanded: !!saved && typeof saved === "object" && "expanded" in saved && saved.expanded === true, error: false};
  } catch {return {collapsed: false, expanded: false, error: true};}
}

function ResizeHandle({width, maximum, onChange, onCommit}: {width: number; maximum: number; onChange: (width: number) => void; onCommit: (width: number) => void}) {
  const drag = useRef<{id: number; x: number; width: number} | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef(width);
  current.current = width;
  const [resizing, setResizing] = useState(false);
  useEffect(() => () => {if (pending.current) clearTimeout(pending.current);}, []);
  function resize(value: number) {
    const next = Math.max(220, Math.min(maximum, Math.round(value)));
    current.current = next; onChange(next);
  }
  function end(id: number) {
    if (drag.current?.id !== id) return;
    drag.current = null; setResizing(false); onCommit(current.current);
  }
  return <div className={`sidebar-resizer ${resizing ? "is-resizing" : ""}`} role="separator" tabIndex={0}
    aria-label="Resize run list" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={maximum} aria-valuenow={width} aria-valuetext={`${width} pixels`}
    onPointerDown={event => {
      if (event.button !== 0 || innerWidth <= 1023) return;
      event.preventDefault(); drag.current = {id: event.pointerId, x: event.clientX, width}; setResizing(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {if (drag.current?.id === event.pointerId) resize(drag.current.width + event.clientX - drag.current.x);}}
    onPointerUp={event => end(event.pointerId)} onPointerCancel={event => end(event.pointerId)} onLostPointerCapture={event => end(event.pointerId)}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      resize(event.key === "Home" ? 220 : event.key === "End" ? maximum : width + (event.key === "ArrowRight" ? 10 : -10));
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => {pending.current = null; onCommit(current.current);}, 250);
    }} />;
}

export function Application({suspended, authenticationRequired, onSignOut}: {
  suspended: boolean; authenticationRequired: boolean; onSignOut: () => Promise<void>;
}) {
  const [notices, setNotices] = useState<Partial<Record<NoticeKind, string>>>({});
  const [notificationHost, setNotificationHost] = useState<HTMLElement | null>(null);
  const showNotice = useCallback((kind: NoticeKind, text: string | null) => setNotices(old => {
    if (old[kind] === (text ?? undefined)) return old;
    const next = {...old}; if (text === null) delete next[kind]; else next[kind] = text; return next;
  }), []);
  const [preferenceVersion, setPreferenceVersion] = useState(0);
  const [preferencesSettled, setPreferencesSettled] = useState(false);
  const [preferences] = useState(() => new PreferencesStore(text => showNotice("preferences", text), () => setPreferenceVersion(value => value + 1),
    document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  const [reads] = useState(() => new MetricCatalogQueryCoordinator());
  const [route, setRoute] = useState(readRoute);
  const routeRef = useRef(route); routeRef.current = route;
  const [metadata, setMetadata] = useState<RunMetadata | null>(null);
  const [observations, setObservations] = useState<ChartRunInfo[]>([]);
  const [metadataError, setMetadataError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [metadataRevision, setMetadataRevision] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [live, setLive] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [inspect, setInspect] = useState<string | null>(null);
  const [colorRun, setColorRun] = useState<string | null>(null);
  const [savedPanel] = useState(panelState);
  const [collapsed, setCollapsed] = useState(savedPanel.collapsed);
  const [expanded, setExpanded] = useState(savedPanel.expanded);
  const [storageError, setStorageError] = useState(savedPanel.error);
  const [viewportWidth, setViewportWidth] = useState(innerWidth);
  const [sidebarWidth, setSidebarWidth] = useState(preferences.data.sidebar_width);
  const [colors] = useState(() => new RunColors());
  const workspace = useRef<WorkspaceHandle>(null);
  const maximum = Math.max(220, Math.min(520, viewportWidth - 640));
  const width = Math.min(maximum, sidebarWidth);
  const mobile = viewportWidth <= 1023;
  const runIds = useMemo(() => route.runIds ?? (metadata ? filteredRuns(metadata.runs, metadata.experiments, route.filters).slice(0, 1).map(run => run.id) : []),
    [route.runIds, route.filters, metadata]);
  const labels = useMemo(() => metadata ? scopedRunLabels(metadata.runs, metadata.experiments, metadata.projects) : new Map<string, string>(), [metadata]);
  colors.assign(runIds, preferences.data.run_colors);
  const colorSignature = JSON.stringify(preferences.data.run_colors);
  const colorFor = useCallback((id: string) => colors.get(id), [colors, colorSignature]);
  const labelFor = useCallback((run: ExperimentRun) => labels.get(run.id) ?? run.name, [labels]);
  const changeRoute = useCallback((patch: Partial<RouteState>, replace = false) => {
    const next = {...routeRef.current, ...patch};
    routeRef.current = next; setRoute(next);
    const url = workspaceUrl(next.runIds ?? [], next.range, next.filters);
    if (`${location.pathname}${location.search}` !== url) {
      if (replace) history.replaceState(null, "", url); else history.pushState(null, "", url);
    }
  }, []);
  const refresh = useCallback(() => {setMetadataRevision(value => value + 1); setRefreshRevision(value => value + 1);}, []);
  const reconnect = useCallback(() => {
    void preferences.bootstrap().then(ok => {if (ok) {workspace.current?.reconcilePreferences(); refresh();}});
  }, [preferences, refresh]);
  useEffect(() => {
    let active = true;
    void preferences.bootstrap().finally(() => {if (active) setPreferencesSettled(true);});
    return () => {active = false; preferences.destroy(); reads.destroy();};
  }, [preferences, reads]);
  useEffect(() => {
    const theme = preferences.data.theme, dark = theme === "dark";
    const changed = document.documentElement.dataset.theme !== theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", dark);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0e1014" : "#f3f4f6");
    if (changed) window.dispatchEvent(new Event("rvx:theme"));
    if (!preferences.error) showNotice("preferences", null);
  }, [preferences, preferenceVersion, showNotice]);
  useEffect(() => setSidebarWidth(preferences.data.sidebar_width), [preferences.data.sidebar_width]);
  useEffect(() => {
    if (!metadata) return;
    try {localStorage.setItem(panelStorage, JSON.stringify({collapsed, expanded})); setStorageError(false);}
    catch {setStorageError(true);}
  }, [collapsed, expanded, metadata !== null]);
  useEffect(() => {
    const resize = () => setViewportWidth(innerWidth);
    const pop = () => {setInspect(null); const next = readRoute(); routeRef.current = next; setRoute(next);};
    window.addEventListener("resize", resize); window.addEventListener("popstate", pop);
    return () => {window.removeEventListener("resize", resize); window.removeEventListener("popstate", pop);};
  }, []);
  useEffect(() => {
    if (!preferencesSettled || suspended || route.missing) return;
    const controller = new AbortController();
    setRefreshing(true);
    void Promise.all([reads.api.projects(controller.signal), reads.api.experiments(controller.signal), reads.api.runs(controller.signal)])
      .then(([projects, experiments, runs]) => {
        if (controller.signal.aborted) return;
        setMetadata({projects, experiments, runs: runs.sort((a, b) => b.updated_at_ns - a.updated_at_ns)});
        setMetadataError(""); showNotice("metadata", null);
      }).catch(error => {
        if (controller.signal.aborted) return;
        const text = error instanceof Error ? error.message : "The request could not be completed.";
        setMetadataError(text); showNotice("metadata", `Run metadata could not be refreshed. ${text}`);
      }).finally(() => {if (!controller.signal.aborted) setRefreshing(false);});
    return () => controller.abort();
  }, [reads, preferencesSettled, metadataRevision, suspended, route.missing, showNotice]);
  useEffect(() => {
    if (metadata && !route.missing && (route.runIds === null || new URL(location.href).searchParams.has("live"))) changeRoute({runIds}, true);
  }, [metadata, route.missing, route.runIds, runIds, changeRoute]);
  const previouslySuspended = useRef(suspended);
  useEffect(() => {
    if (previouslySuspended.current && !suspended) void preferences.resumeAuthentication().then(ok => {if (ok) reconnect();});
    previouslySuspended.current = suspended;
  }, [suspended, preferences, reconnect]);
  const toggleRun = useCallback((id: string) => {
    const selected = routeRef.current.runIds ?? runIds;
    if (!selected.includes(id) && selected.length >= 4) return;
    changeRoute({runIds: selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]});
  }, [changeRoute, runIds]);
  const workspaceNotice = useCallback((text: string | null) => showNotice("updates", text), [showNotice]);
  const onLogout = () => {
    const leave = () => {
      if (signingOut) return;
      setSigningOut(true);
      void onSignOut().catch(error => showNotice("authentication", `Sign out failed. ${error instanceof Error ? error.message : "The request could not be completed."}`))
        .finally(() => setSigningOut(false));
    };
    if (workspace.current) workspace.current.prepareToLeave(leave); else leave();
  };
  const noticeKind = (["authentication", "metadata", "preferences", "updates"] as const).find(kind => notices[kind] !== undefined);
  return <NotificationsContext value={notificationHost}>
    <div className="app-content">
      {route.missing ? <Message title="Page not found"><Button onClick={() => changeRoute({missing: false, runIds: null})}>Open workspace</Button></Message>
        : !metadata ? <Message title={metadataError ? "Could not load runs" : preferences.ready ? "Loading runs…" : "Loading workspace…"}
          {...(metadataError ? {description: metadataError} : {})}>
          {metadataError && <Button onClick={refresh}>Try again</Button>}
        </Message>
          : <div className="analysis-layout" data-collapsed={collapsed} data-controls-open={expanded}
            style={{"--sidebar-width": `${width}px`} as CSSProperties}>
            <aside className="runs-dock" aria-label="Runs panel">
              <RunsPanel theme={preferences.data.theme} collapsed={collapsed} expanded={expanded} storageError={storageError}
                onCollapsed={setCollapsed} onExpanded={setExpanded} live={live} refreshing={refreshing} authenticationRequired={authenticationRequired}
                signingOut={signingOut} authenticationSuspended={suspended} onTheme={() => preferences.updateBrowser({theme: preferences.data.theme === "dark" ? "light" : "dark"})}
                onLive={setLive} onRefresh={refresh} onLogout={onLogout}
                connection={<ConnectionIndicator suspended={suspended} onReconnect={reconnect} />}
                selector={<RunSelector metadata={metadata} observations={observations} runIds={runIds} filters={route.filters} compact={collapsed && !mobile}
                  mobileCompact={!expanded && mobile} refreshing={refreshing} suspended={suspended} colorFor={colorFor} labelFor={labelFor}
                  onToggle={toggleRun} onFilters={(filters, replace) => changeRoute({filters}, replace)} onDetails={setInspect} />} />
              <ResizeHandle width={width} maximum={maximum} onChange={setSidebarWidth} onCommit={sidebar_width => preferences.updateBrowser({sidebar_width})} />
            </aside>
            <Workspace ref={workspace} metadata={metadata} runIds={runIds} range={route.range}
              reads={reads} preferences={preferences} preferenceVersion={preferenceVersion} colorFor={colorFor} labelFor={labelFor}
              onRange={range => changeRoute({range})} onObservations={setObservations}
              onOpenRuns={() => {setCollapsed(false); setExpanded(true);}}
              onNotice={workspaceNotice} live={live} suspended={suspended} refreshRevision={refreshRevision} metadataRefreshing={refreshing} onRefreshRuns={refresh} />
          </div>}
    </div>
    <section ref={setNotificationHost} className="notification-region" aria-label="Notifications">
      {noticeKind && <div className="workspace-notice preferences-notice" role="status" title={notices[noticeKind]}>
        <span className="notification-message">{notices[noticeKind]}</span>
        {noticeKind !== "authentication" && <IconButton label="Retry" onClick={() => {
          if (noticeKind === "metadata") refresh();
          else if (noticeKind === "updates") workspace.current?.refreshNow();
          else if (preferences.errorKind === "workspace" && !preferences.pendingDeletion) workspace.current?.retrySave();
          else void preferences.retry().then(() => {if (!preferences.error) {showNotice("preferences", null); workspace.current?.reconcilePreferences();}});
        }}><RefreshCw /></IconButton>}
        <IconButton label="Dismiss notification" onClick={() => showNotice(noticeKind, null)}><X /></IconButton>
      </div>}
    </section>
    {inspect && metadata && <RunInspector runId={inspect} metadata={metadata} labelFor={labelFor} colorFor={colorFor} onColor={setColorRun} onClose={() => setInspect(null)} />}
    {colorRun && <RunColorPicker color={colorFor(colorRun)} onClose={() => setColorRun(null)} onChange={color => {
      const run_colors = {...preferences.data.run_colors};
      if (color === null) delete run_colors[colorRun]; else run_colors[colorRun] = color;
      if (Object.keys(run_colors).length > 1000) {showNotice("preferences", "At most 1,000 custom Run colors can be saved. Reset an existing color to Automatic first."); return false;}
      preferences.updateBrowser({run_colors}); return true;
    }} />}
  </NotificationsContext>;
}
