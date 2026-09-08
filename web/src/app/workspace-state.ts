import {isRecord} from "./model";
import {copyLayout, type WorkspaceLayout, type WorkspaceSet} from "./panels";

/** Compare configuration content without confusing object insertion order with an edit. */
export function layoutSignature(layout: WorkspaceLayout): string {
  const copy = copyLayout(layout);
  for (const panel of copy.panels) {
    if (panel.kind === "chart") continue;
    if (!panel.title) delete panel.title;
    panel.sourceIds?.sort();
    if (panel.query) {
      const {search, filters, sort} = panel.query;
      panel.query = {...(search ? {search} : {}), ...(filters?.length ? {filters} : {}), ...(sort ? {sort} : {})};
      if (!Object.keys(panel.query).length) delete panel.query;
    }
  }
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, ordered(value[key])]))
    : value;
  return JSON.stringify(ordered(copy));
}

/** Track the current layout's identity against its last accepted or successfully saved content. */
export class WorkspaceState {
  id: string | null = null;
  name = "Default";
  scope = "";
  dirty = false;
  saveFailed = false;
  private baseline: string | null = null;

  /** Accept a loaded/default layout without claiming that generated defaults were persisted. */
  open(layout: WorkspaceLayout, scope: string, saved?: WorkspaceSet): void {
    this.id = saved?.id ?? null; this.name = saved?.name ?? "Default"; this.scope = saved?.experimentId ?? scope;
    this.baseline = layoutSignature(layout); this.dirty = false; this.saveFailed = false;
  }

  /** Reconcile actual layout edits, including an undo back to the last saved arrangement. */
  changed(layout: WorkspaceLayout): void {
    this.dirty = this.baseline === null || this.baseline !== layoutSignature(layout);
    if (!this.dirty && this.id) this.saveFailed = false;
  }

  /** Preserve an active deleted workspace as an explicitly unsaved draft rather than losing its panels. */
  detach(): void {
    this.id = null; this.name = "Untitled"; this.baseline = null; this.dirty = true; this.saveFailed = false;
  }

  /** Expose failed persistence separately from ordinary unsaved edits. */
  failed(): void {this.saveFailed = true;}

  /** A successful asynchronous save accepts only its submitted snapshot, never later edits. */
  saved(submitted: WorkspaceSet, current: WorkspaceLayout): void {
    this.id = submitted.id; this.name = submitted.name; this.scope = submitted.experimentId;
    this.baseline = layoutSignature(submitted); this.saveFailed = false; this.changed(current);
  }

  /** Keep status truthful: only a successful write or load can be called saved. */
  get status(): "saved" | "unsaved" | "default" | "failed" {
    return this.saveFailed ? "failed" : this.dirty ? "unsaved" : this.id ? "saved" : "default";
  }
}
