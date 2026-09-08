import {uiIdentifier} from "../core/identifiers";
import {isRecord} from "./model";
import {copyLayout, validLayout, type WorkspaceLayout, type WorkspaceSet} from "./panels";
import {assertAuthenticated, AuthenticationRequired, requireAuthentication} from "../auth/session";

export interface WorkspaceDocument {revision: number; sets: WorkspaceSet[]}
export interface BrowserPreferences {revision: number; theme: "light" | "dark"; sidebar_width: number; selected: Record<string, string>; run_colors: Record<string, string>}
export interface UiState {workspaces: WorkspaceDocument; browser: BrowserPreferences}
type BrowserPatch = Partial<Omit<BrowserPreferences, "revision">>;
type PreferenceConcern = "bootstrap" | "workspace" | "browser";
interface PendingWorkspace {body: string; record?: WorkspaceSet}
class UiApiError extends Error {
  constructor(message: string, readonly status: number, readonly current?: unknown) {super(message);}
}
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function validWorkspaceDocument(value: unknown): value is WorkspaceDocument {
  return isRecord(value) && revision(value.revision) && Array.isArray(value.sets) && value.sets.length <= 100
    && value.sets.every(validSet) && new Set(value.sets.map(set => set.id)).size === value.sets.length;
}
export function validBrowserPreferences(value: unknown): value is BrowserPreferences {
  return isRecord(value) && revision(value.revision) && (value.theme === "light" || value.theme === "dark")
    && Number.isInteger(value.sidebar_width) && Number(value.sidebar_width) >= 220 && Number(value.sidebar_width) <= 520
    && isRecord(value.selected) && Object.values(value.selected).every(id => typeof id === "string")
    && isRecord(value.run_colors) && Object.keys(value.run_colors).length <= 1000
    && Object.values(value.run_colors).every(color => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color));
}
function validSet(value: unknown): value is WorkspaceSet {
  return isRecord(value) && typeof value.id === "string" && !!value.id && typeof value.name === "string" && !!value.name.trim()
    && value.name.length <= 80 && typeof value.experimentId === "string" && validLayout(value);
}

/** One server owner: shared definitions and cookie-scoped browser preferences never use local storage. */
export class PreferencesStore {
  workspaces: WorkspaceDocument = {revision: 0, sets: []};
  browser: BrowserPreferences = {revision: 0, theme: "light", sidebar_width: 280, selected: {}, run_colors: {}};
  ready = false;
  private errors = new Map<PreferenceConcern, string>();
  private authenticationErrors = new Set<PreferenceConcern>();
  conflict: WorkspaceDocument | null = null;
  conflictRecord: WorkspaceSet | null = null;
  saving = false;
  lastSavedRevision = 0;
  private pendingWorkspace: PendingWorkspace | null = null;
  private pendingBrowser: {body: string; patch: BrowserPatch} | null = null;
  private queuedBrowser: BrowserPatch = {};
  private browserWriting = false;
  private browserDrain: Promise<void> | null = null;
  private browserFailed = false;
  private lifetime = new AbortController();
  private bootstrapRequest: Promise<boolean> | null = null;
  /** Hydrate the server-rendered appearance before the authoritative preference bootstrap finishes. */
  constructor(private warn: (message: string) => void = () => {}, private changed: () => void = () => {},
    initialTheme: BrowserPreferences["theme"] = "light") {this.browser.theme = initialTheme;}
  get data(): Omit<BrowserPreferences, "revision"> & {sets: WorkspaceSet[]} {
    return {...this.browser, ...this.queuedBrowser, sets: this.workspaces.sets};
  }
  get uncertain(): boolean {return this.pendingWorkspace !== null;}
  get pendingDeletion(): boolean {return this.pendingWorkspace !== null && !this.pendingWorkspace.record;}
  get errorKind(): PreferenceConcern | null {return (["bootstrap", "workspace", "browser"] as const).find(kind => this.errors.has(kind)) ?? null;}
  get error(): string {return this.errorKind ? this.errors.get(this.errorKind)! : "";}

  /** Bootstrap before layout restoration; failed bootstrap leaves drafts usable but never writable. */
  bootstrap(): Promise<boolean> {
    if (this.bootstrapRequest) return this.bootstrapRequest;
    this.bootstrapRequest = this.loadState().finally(() => {this.bootstrapRequest = null;});
    return this.bootstrapRequest;
  }
  private async loadState(): Promise<boolean> {
    try {
      const value = await this.request("/api/ui/state");
      if (!isRecord(value) || !validWorkspaceDocument(value.workspaces) || !validBrowserPreferences(value.browser)) throw new Error("The server returned invalid UI settings.");
      if (value.workspaces.revision >= this.workspaces.revision) this.workspaces = value.workspaces;
      // A reconnect must not discard an in-flight browser preference snapshot or newer queued edits.
      if (!this.browserWriting && !this.pendingBrowser && value.browser.revision >= this.browser.revision) this.browser = value.browser;
      this.ready = true; this.errors.delete("bootstrap"); this.changed();
      if (!this.browserFailed) void this.flushBrowser();
      return true;
    } catch (error) {if (!this.lifetime.signal.aborted) this.report(error, "bootstrap"); return false;}
  }
  /** Copy and freeze the full request before the first await; uncertain retries reuse these exact bytes. */
  async save(name: string, experimentId: string, layout: WorkspaceLayout, loadedRevision = this.workspaces.revision, id?: string): Promise<WorkspaceSet | null> {
    if (this.saving) return null;
    if (this.pendingWorkspace) {this.report(new Error("The previous save has an unknown outcome. Retry it before saving more changes.")); return null;}
    if (!this.ready) {this.report(new Error("Server settings are unavailable. Retry loading before saving."), "bootstrap"); return null;}
    const existing = id ? this.workspaces.sets.find(set => set.id === id) : this.workspaces.sets.find(set => set.experimentId === experimentId && set.name === name.trim());
    const record: WorkspaceSet = {id: id ?? existing?.id ?? uiIdentifier("set"), name: name.trim(), experimentId, ...copyLayout(layout)};
    const sets = [...this.workspaces.sets.filter(set => set.id !== record.id), record];
    if (!record.name || record.name.length > 80 || sets.length > 100) {this.report(new Error("Use a name of 1–80 characters and at most 100 workspace sets.")); return null;}
    this.conflict = null; this.conflictRecord = null;
    this.pendingWorkspace = {record, body: JSON.stringify({revision: loadedRevision, mutation_id: uiIdentifier("mutation"), sets})};
    return this.submitWorkspace();
  }
  async retrySave(): Promise<WorkspaceSet | null> {return this.pendingWorkspace && !this.saving ? this.submitWorkspace() : null;}
  private async submitWorkspace(): Promise<WorkspaceSet | null> {
    const pending = this.pendingWorkspace; if (!pending) return null;
    this.saving = true; this.changed();
    try {
      const value = await this.request("/api/ui/workspaces", pending.body);
      if (!validWorkspaceDocument(value)) throw new Error("The save response was invalid. Retry to confirm the result.");
      this.lastSavedRevision = value.revision;
      if (value.revision >= this.workspaces.revision) this.workspaces = value;
      this.pendingWorkspace = null; this.conflict = null; this.conflictRecord = null; this.errors.delete("workspace");
      if (pending.record) {
        this.select(pending.record.experimentId, pending.record.id);
        await this.flushBrowser();
      }
      else await this.bootstrap();
      return pending.record ?? null;
    } catch (error) {
      if (error instanceof UiApiError && error.status === 409 && validWorkspaceDocument(error.current)) {
        if (error.current.revision >= this.workspaces.revision) this.workspaces = error.current;
        this.conflict = this.workspaces; this.conflictRecord = pending.record ?? null; this.pendingWorkspace = null;
        this.report(new Error("This workspace changed on the server. Your draft is intact. Reload the server version or save a copy."));
      } else {
        // Definite validation/auth failures did not commit; transport/5xx failures retain the mutation.
        if (error instanceof UiApiError && error.status >= 400 && error.status < 500) this.pendingWorkspace = null;
        if (!this.lifetime.signal.aborted) this.report(error);
      }
      return null;
    } finally {this.saving = false; this.changed();}
  }
  async remove(id: string): Promise<boolean> {
    if (!this.ready) {this.report(new Error("Retry loading server settings before deleting a workspace."), "bootstrap"); return false;}
    if (this.saving || this.pendingWorkspace) {this.report(new Error("Retry the pending save before deleting a workspace.")); return false;}
    this.conflict = null;
    this.pendingWorkspace = {body: JSON.stringify({revision: this.workspaces.revision, mutation_id: uiIdentifier("mutation"), sets: this.workspaces.sets.filter(set => set.id !== id)})};
    await this.submitWorkspace();
    return !this.pendingWorkspace && !this.conflict && !this.errors.has("workspace");
  }
  select(experimentId: string, id: string | null): void {
    const selected = {...this.data.selected};
    if (id === null) delete selected[experimentId]; else selected[experimentId] = id;
    this.updateBrowser({selected});
  }
  updateBrowser(patch: BrowserPatch): void {
    this.queuedBrowser = {...this.queuedBrowser, ...patch, ...(patch.selected ? {selected: {...patch.selected}} : {}),
      ...(patch.run_colors ? {run_colors: {...patch.run_colors}} : {})};
    this.changed(); void this.flushBrowser();
  }
  /** Resolve only after queued browser choices have settled, including the selected saved workspace. */
  private flushBrowser(): Promise<void> {
    if (this.browserDrain) return this.browserDrain;
    if (!this.ready || this.browserFailed || this.lifetime.signal.aborted) return Promise.resolve();
    if (!this.pendingBrowser && !Object.keys(this.queuedBrowser).length) return Promise.resolve();
    this.browserDrain = this.drainBrowser().finally(() => {this.browserDrain = null;});
    return this.browserDrain;
  }
  /** Drain one immutable write at a time while coalescing newer appearance and selection choices. */
  private async drainBrowser(): Promise<void> {
    while (!this.browserFailed && !this.lifetime.signal.aborted && (this.pendingBrowser || Object.keys(this.queuedBrowser).length)) {
      await this.writeBrowser();
    }
  }
  /** Submit one frozen preference revision without allowing concurrent writes to race its acknowledgement. */
  private async writeBrowser(): Promise<void> {
    if (!this.pendingBrowser) {
      const patch = this.queuedBrowser; this.queuedBrowser = {};
      this.pendingBrowser = {patch, body: JSON.stringify({...this.browser, ...patch, mutation_id: uiIdentifier("mutation")})};
      this.browser = {...this.browser, ...patch};
    }
    const pending = this.pendingBrowser; this.browserWriting = true;
    try {
      const value = await this.request("/api/ui/browser", pending.body);
      if (!validBrowserPreferences(value)) throw new Error("The browser settings response was invalid. Retry to confirm the result.");
      this.browser = value; this.pendingBrowser = null; this.errors.delete("browser");
    } catch (error) {
      this.browserFailed = true;
      if (error instanceof UiApiError && error.status === 409 && validBrowserPreferences(error.current)) {
        this.browser = error.current; this.pendingBrowser = null;
        this.queuedBrowser = {...pending.patch, ...this.queuedBrowser};
      } else if (error instanceof UiApiError && error.status >= 400 && error.status < 500) {
        this.pendingBrowser = null; this.queuedBrowser = {...pending.patch, ...this.queuedBrowser};
      }
      if (!this.lifetime.signal.aborted) this.report(error, "browser");
    } finally {
      this.browserWriting = false; this.changed();
    }
  }
  /** Explicit Retry is the only path that reapplies browser choices after a revision conflict. */
  async retry(): Promise<void> {
    if (this.pendingDeletion && !this.saving) {
      await this.submitWorkspace();
      if (this.pendingDeletion || this.conflict) return;
    }
    if (!await this.bootstrap()) return;
    if (this.queuedBrowser.selected) this.queuedBrowser.selected = Object.fromEntries(Object.entries(this.queuedBrowser.selected)
      .filter(([experiment, id]) => this.workspaces.sets.some(set => set.experimentId === experiment && set.id === id)));
    this.browserFailed = false; await this.flushBrowser();
  }
  selected(experimentId: string): WorkspaceSet | undefined {
    return this.workspaces.sets.find(set => set.id === this.data.selected[experimentId] && set.experimentId === experimentId);
  }
  /** Resume authentication-blocked preferences without retrying unrelated revision conflicts or layouts. */
  async resumeAuthentication(): Promise<boolean> {
    const browserBlocked = this.authenticationErrors.has("browser");
    for (const concern of this.authenticationErrors) this.errors.delete(concern);
    this.authenticationErrors.clear();
    if (browserBlocked) this.browserFailed = false;
    const ready = await this.bootstrap();
    if (ready && browserBlocked) await this.flushBrowser();
    this.changed();
    return ready;
  }
  private report(error: unknown, kind: PreferenceConcern = "workspace"): void {
    if (error instanceof AuthenticationRequired) this.authenticationErrors.add(kind); else this.authenticationErrors.delete(kind);
    this.errors.set(kind, error instanceof Error ? error.message : "Server settings could not be saved.");
    this.warn(this.error); this.changed();
  }
  private async request(path: string, body?: string): Promise<unknown> {
    assertAuthenticated();
    const response = await fetch(path, {method: body ? "PUT" : "GET", credentials: "same-origin", cache: "no-store",
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]), ...(body ? {headers: {"Content-Type": "application/json"}, body} : {})});
    if (response.status === 401) throw requireAuthentication();
    const value: unknown = await response.json();
    if (!response.ok) throw new UiApiError(isRecord(value) && typeof value.error === "string" ? value.error : `Server settings request failed (${response.status}).`, response.status, isRecord(value) ? value.current : undefined);
    return value;
  }
  destroy(): void {this.lifetime.abort();}
}
