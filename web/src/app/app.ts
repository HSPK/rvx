import {MetricCatalogQueryCoordinator} from "./coordinator";
import {PreferencesStore} from "./preferences";
import {brandMark} from "./brand";
import {ConnectionStatus} from "./connection";
import {SidebarResize} from "./sidebar-resize";
import {Runs, type RunMetadata} from "./runs";
import {ChartWorkspace} from "./workspace";
import {RunDetails} from "./run-details";
import {runColorDialog} from "./run-color";
import {filteredRuns, filtersFrom, initialRange, routeFrom, RunColors, workspaceUrl} from "./model";
import {scopedRunLabels} from "./run-context";
import type {ExperimentRun} from "../domain/types";
import {button, dialog, el, errorText, icon, iconButton, message} from "./ui";

type NoticeKind = "preferences" | "metadata" | "authentication";

/** Own one shared run selection, URL state, selector, and chart workspace. */
export class App {
  private reads = new MetricCatalogQueryCoordinator();
  private globalNotice = el("div", "workspace-notice preferences-notice");
  private notices = new Map<NoticeKind, string>();
  private preferences = new PreferencesStore(message => this.showNotice(message), () => {
    if (this.themeControl) this.applyTheme(this.themeControl);
    this.resize?.set(this.preferences.data.sidebar_width);
    this.applyRunColors();
    if (this.preferences.error) {this.hadPreferenceFailure = true; this.showNotice(this.preferences.error);}
    else if (this.hadPreferenceFailure) {this.hadPreferenceFailure = false; this.clearNotice("preferences");}
  }, document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  private hadPreferenceFailure = false;
  private themeControl: HTMLButtonElement | null = null;
  private signOutControl: HTMLButtonElement | null = null;
  private connection: ConnectionStatus | null = null;
  private resize: SidebarResize | null = null;
  private metadata: RunMetadata | null = null;
  private workspace: ChartWorkspace | null = null;
  private selector: Runs | null = null;
  private main = el("div", "app-content");
  private workspaceHeader = el("div", "workspace-header-host");
  private layout = el("div", "analysis-layout");
  private dock = el("aside", "runs-dock");
  private sheet: ReturnType<typeof dialog> | null = null;
  private runDetails: RunDetails | null = null;
  private mobile = matchMedia("(max-width: 900px)");
  private lifetime = new AbortController();
  private metadataRequest: AbortController | null = null;
  private runIds: string[] = [];
  private filters = filtersFrom(new URL(location.href));
  private range = initialRange(new URL(location.href));
  private colors = new RunColors();
  private colorSignature = "";
  private colorDialog: ReturnType<typeof dialog> | null = null;
  private runLabels: ReadonlyMap<string, string> = new Map();

  /** Bind the host without creating duplicate desktop and mobile fetching views. */
  constructor(private root: HTMLElement, private authentication?: {required: boolean; signOut: () => Promise<void>}) {}

  /** Mount shared chrome and restore canonical query state before analysis begins. */
  async start(): Promise<void> {
    const bar = el("header", "appbar");
    const brand = brandMark();
    const theme = iconButton("Switch to dark appearance", "moon", () => {
      this.preferences.updateBrowser({theme: this.preferences.data.theme === "dark" ? "light" : "dark"});
    });
    this.themeControl = theme;
    this.applyTheme(theme);
    const connectionHost = el("div", "connection-host");
    const actions = el("div", "app-global-actions"); actions.append(theme);
    if (this.authentication) {
      this.signOutControl = iconButton("Sign out", "logout", () => {
        const leave = (): void => {void this.signOut();};
        if (this.workspace) this.workspace.prepareToLeave(leave); else leave();
      });
      this.signOutControl.hidden = !this.authentication.required; actions.append(this.signOutControl);
    }
    bar.append(brand, this.workspaceHeader, connectionHost, actions);
    this.globalNotice.setAttribute("role", "status"); this.globalNotice.hidden = !this.globalNotice.textContent;
    this.root.replaceChildren(bar, this.globalNotice, this.main);
    window.addEventListener("popstate", () => this.restoreUrl(), {signal: this.lifetime.signal});
    this.mobile.addEventListener("change", () => {
      if (!this.mobile.matches) this.sheet?.close();
      this.selector?.setActive(!this.mobile.matches || Boolean(this.sheet));
    }, {signal: this.lifetime.signal});
    window.addEventListener("pagehide", event => {if (!event.persisted) this.destroy();}, {signal: this.lifetime.signal});
    this.main.replaceChildren(message("Loading workspace settings", "Connecting to the server…"));
    const ready = await this.preferences.bootstrap();
    if (this.lifetime.signal.aborted) return;
    if (ready) this.startConnection(connectionHost);
    if (routeFrom(new URL(location.href)).kind === "missing") this.restoreUrl();
    else await this.loadMetadata();
  }
  private startConnection(host = this.root.querySelector<HTMLElement>(".connection-host")): void {
    if (!host || this.connection) return;
    this.connection = new ConnectionStatus(() => {
      void this.preferences.bootstrap().then(ok => {if (ok) this.workspace?.reconcilePreferences();});
      this.workspace?.refreshNow();
    });
    host.append(this.connection.element); this.connection.start();
  }

  /** Surface recoverable preference or metadata failures without replacing active charts. */
  private showNotice(text: string, kind: NoticeKind = "preferences"): void {
    this.notices.set(kind, text);
    this.renderNotice();
  }

  /** Clear only the dismissed or recovered concern, retaining other unresolved warnings. */
  private clearNotice(kind: NoticeKind): void {
    this.notices.delete(kind);
    this.renderNotice();
  }

  /** Show one bounded notification at a time without losing independent failure states. */
  private renderNotice(): void {
    const kind = this.notices.has("authentication") ? "authentication" : this.notices.has("metadata") ? "metadata" : "preferences";
    const text = this.notices.get(kind);
    this.globalNotice.hidden = text === undefined;
    if (text !== undefined) {
      this.globalNotice.replaceChildren(el("span", "", text));
      if (kind === "preferences" && this.preferences.error) this.globalNotice.append(button("Retry", () => {
        if (this.preferences.errorKind === "workspace" && !this.preferences.pendingDeletion) {this.workspace?.retrySave(); return;}
        void this.preferences.retry().then(() => {
          if (!this.preferences.error) {this.clearNotice("preferences"); this.workspace?.reconcilePreferences(); this.startConnection();}
        });
      }, "text-button"));
      this.globalNotice.append(iconButton("Dismiss notification", "close", () => this.clearNotice(kind)));
    }
  }

  /** Repaint existing plot instances when appearance changes. */
  private applyTheme(control: HTMLButtonElement): void {
    const dark = this.preferences.data.theme === "dark";
    const label = `Switch to ${dark ? "light" : "dark"} appearance`;
    if (document.documentElement.dataset.theme === this.preferences.data.theme && control.getAttribute("aria-label") === label) return;
    document.documentElement.dataset.theme = this.preferences.data.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#171b23" : "#f6f7f9");
    control.setAttribute("aria-label", label); control.title = label;
    control.replaceChildren(icon(dark ? "sun" : "moon"), el("span", "", label));
    window.dispatchEvent(new Event("rvx:theme"));
  }

  /** Stop protected reads without replacing the workspace or its unsaved layout. */
  suspendAuthentication(): void {
    this.metadataRequest?.abort(); this.workspace?.suspend(true); this.selector?.setActive(false); this.connection?.suspend();
  }

  /** Reconcile fresh credentials while retaining pending saves, layout identity and chart canvases. */
  async resumeAuthentication(required: boolean): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    if (this.signOutControl) this.signOutControl.hidden = !required;
    this.clearNotice("authentication");
    if (!await this.preferences.resumeAuthentication()) return;
    this.workspace?.reconcilePreferences();
    await this.loadMetadata();
    this.workspace?.suspend(false);
    this.startConnection(); this.connection?.start();
  }

  /** Sign out only after server revocation succeeds; failures leave the current draft recoverable. */
  private async signOut(): Promise<void> {
    if (!this.authentication || this.signOutControl?.disabled) return;
    if (this.signOutControl) this.signOutControl.disabled = true;
    try {await this.authentication.signOut();}
    catch (error) {
      if (!this.lifetime.signal.aborted) this.showNotice(`Sign out failed. ${errorText(error)}`, "authentication");
    } finally {if (this.signOutControl) this.signOutControl.disabled = false;}
  }

  /** Update rail and chart labels atomically while preserving workspace ownership and selection. */
  private async loadMetadata(): Promise<void> {
    this.metadataRequest?.abort();
    const request = new AbortController(); this.metadataRequest = request;
    this.selector?.setRefreshing(true);
    this.workspace?.setMetadataRefreshing(true);
    if (!this.workspace) this.main.replaceChildren(message("Loading runs", "Connecting to your experiment history…"));
    try {
      const [projects, experiments, runs] = await Promise.all([
        this.reads.api.projects(request.signal), this.reads.api.experiments(request.signal), this.reads.api.runs(request.signal),
      ]);
      if (request.signal.aborted) return;
      this.metadata = {projects, experiments, runs: runs.sort((a, b) => b.updated_at_ns - a.updated_at_ns)};
      this.runLabels = scopedRunLabels(runs, experiments, projects);
      this.clearNotice("metadata");
      if (this.workspace) this.applyState();
      else this.restoreUrl();
    } catch (error) {
      if (request.signal.aborted) return;
      if (this.workspace) this.showNotice(`Run metadata could not be refreshed. ${errorText(error)}`, "metadata");
      else this.main.replaceChildren(message("Could not load runs", errorText(error), button("Try again", () => {void this.loadMetadata();})));
    } finally {
      if (this.metadataRequest === request) {
        this.selector?.setRefreshing(false);
        this.workspace?.setMetadataRefreshing(false);
      }
    }
  }

  /** Restore selections and filters in place; only an absent runs parameter chooses one scoped run. */
  private restoreUrl(): void {
    this.runDetails?.destroy();
    const url = new URL(location.href), route = routeFrom(url);
    if (route.kind === "missing") {
      this.destroyAnalysis();
      document.title = "Page not found · RVX";
      this.main.replaceChildren(message("Page not found", "Analysis lives in one workspace.", button("Open workspace", () => {
        history.pushState(null, "", "/rvx"); this.restoreUrl();
      })));
      return;
    }
    if (!this.metadata) {void this.loadMetadata(); return;}
    this.filters = filtersFrom(url); this.range = initialRange(url);
    this.runIds = route.runIds ?? filteredRuns(this.metadata.runs, this.metadata.experiments, this.filters).slice(0, 1).map(run => run.id);
    if (route.runIds === null || url.searchParams.has("live")) this.writeUrl(true);
    this.applyState();
  }

  /** Keep display context separate from unchanged Run identities and registry names. */
  private runLabel(run: ExperimentRun): string {return this.runLabels.get(run.id) ?? run.name;}

  /** Synchronize peer views without remounting charts during toggles, filters, or browser history. */
  private applyState(): void {
    if (!this.metadata) return;
    if (this.runIds.length <= 4) this.colors.assign(this.runIds);
    if (!this.selector || !this.workspace) {
      this.selector = new Runs(this.metadata, this.filters, id => this.colors.get(id), run => this.runLabel(run), id => this.toggleRun(id), (filters, replace) => {
        this.filters = filters; this.writeUrl(replace); this.applyState();
      }, () => {void this.loadMetadata();}, id => this.openRunDetails(id));
      this.workspace = new ChartWorkspace(this.runIds, this.metadata, this.reads, this.preferences, this.range, id => this.colors.get(id), run => this.runLabel(run),
        () => this.openRuns(), id => this.toggleRun(id), range => {this.range = {...range}; this.writeUrl(false);},
        () => {void this.loadMetadata();}, id => this.openRunDetails(id), id => this.openRunColor(id));
      this.resize?.destroy();
      this.resize = new SidebarResize(this.layout, this.preferences.data.sidebar_width, sidebar_width => this.preferences.updateBrowser({sidebar_width}));
      this.dock.replaceChildren(this.selector.element, this.resize.element);
      this.workspaceHeader.replaceChildren(this.workspace.header);
      this.layout.replaceChildren(this.dock, this.workspace.element);
      this.main.replaceChildren(this.layout);
    }
    const selected = new Set(this.runIds);
    const visibleIds = new Set(filteredRuns(this.metadata.runs.filter(run => selected.has(run.id)), this.metadata.experiments, this.filters).map(run => run.id));
    this.selector.update(this.metadata, this.runIds, this.filters);
    this.selector.setActive(!this.mobile.matches || Boolean(this.sheet));
    this.workspace.setSelection(this.runIds, this.metadata, this.range, this.runIds.filter(id => !visibleIds.has(id)));
    this.runDetails?.update(this.metadata);
  }

  /** Open Run information independently of plot selection, including from the shared mobile selector. */
  private openRunDetails(id: string): void {
    if (!this.metadata?.runs.some(run => run.id === id)) {this.showNotice("Run details are unavailable. Refresh the Run list.", "metadata"); return;}
    this.runDetails?.destroy();
    const drawer = new RunDetails(id, this.metadata, run => this.runLabel(run), () => {
      if (this.runDetails === drawer) this.runDetails = null;
      const opener = [...document.querySelectorAll<HTMLElement>("[data-run-details]")].find(node => node.dataset.runDetails === id && node.getBoundingClientRect().width > 0);
      opener?.focus({preventScroll: true});
    }, () => this.colors.get(id), () => this.openRunColor(id));
    this.runDetails = drawer;
  }

  /** Repaint colors immediately without refetching observations or replacing chart canvases. */
  private applyRunColors(): void {
    const overrides = this.preferences.data.run_colors;
    const signature = JSON.stringify(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)));
    if (signature === this.colorSignature) return;
    this.colorSignature = signature;
    this.colors.assign(this.runIds, overrides);
    if (this.metadata) this.selector?.update(this.metadata, this.runIds, this.filters);
    this.workspace?.refreshColors(); this.runDetails?.refreshColor();
  }

  /** Store one sparse override in the browser's server-owned appearance preferences. */
  private openRunColor(id: string): void {
    if (!this.metadata?.runs.some(run => run.id === id)) {this.showNotice("Run unavailable. Refresh the Run list.", "metadata"); return;}
    this.colorDialog?.close();
    this.colorDialog = runColorDialog(this.colors.get(id), color => {
      const run_colors = {...this.preferences.data.run_colors};
      if (color === null) delete run_colors[id]; else run_colors[id] = color;
      if (Object.keys(run_colors).length > 1000) {this.showNotice("At most 1,000 custom Run colors can be saved. Reset an existing color to Automatic first."); return false;}
      this.preferences.updateBrowser({run_colors});
      return true;
    }, () => {
      this.colorDialog = null;
      const scope = document.querySelector(".run-drawer") ?? this.root;
      [...scope.querySelectorAll<HTMLElement>("[data-run-color]")].find(node => node.dataset.runColor === id)?.focus({preventScroll: true});
    });
  }

  /** Toggle one trace group immediately, preserving explicit empty and unavailable selections. */
  private toggleRun(id: string): void {
    if (this.runIds.includes(id)) this.runIds = this.runIds.filter(current => current !== id);
    else if (this.runIds.length < 4) this.runIds = [...this.runIds, id];
    else return;
    this.writeUrl(false); this.applyState();
  }

  /** Record complete peer state so Back/Forward restores selections without a page transition. */
  private writeUrl(replace: boolean): void {
    const url = workspaceUrl(this.runIds, this.range, this.filters);
    if (`${location.pathname}${location.search}` === url) return;
    if (replace) history.replaceState(null, "", url); else history.pushState(null, "", url);
  }

  /** Move the existing selector into a native mobile sheet, with immediate selection and no Apply step. */
  private openRuns(): void {
    if (!this.selector) return;
    if (!this.mobile.matches) {this.selector.focus(); return;}
    if (this.sheet) return;
    const sheet = dialog("Runs", "runs-sheet", () => {
      if (this.sheet !== sheet) return;
      this.sheet = null;
      if (this.selector) {
        this.dock.append(this.selector.element); this.selector.setActive(!this.mobile.matches);
        if (!this.mobile.matches) this.selector.focus();
      }
    });
    this.sheet = sheet;
    sheet.body.append(this.selector.element); this.selector.setActive(true); this.selector.focus();
  }

  /** Release the one selector and chart workspace when leaving the sole analysis route. */
  private destroyAnalysis(): void {
    this.runDetails?.destroy(); this.runDetails = null;
    this.sheet?.close(); this.sheet = null;
    this.selector?.destroy(); this.workspace?.destroy(); this.selector = null; this.workspace = null;
    this.workspaceHeader.replaceChildren();
  }

  /** Stop all subscriptions and reads when the application is actually unloaded. */
  destroy(): void {
    this.colorDialog?.close(); this.destroyAnalysis(); this.resize?.destroy(); this.connection?.destroy(); this.preferences.destroy(); this.reads.destroy(); this.metadataRequest?.abort(); this.lifetime.abort();
  }
}
