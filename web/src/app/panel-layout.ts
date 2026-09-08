import {uiIdentifier} from "../core/identifiers";
import {movePanel, removeSection, type WorkspaceLayout} from "./panels";
import type {PanelChrome} from "./panel-chrome";
import {button, dialog, el, field, iconButton} from "./ui";

export interface LayoutView {element: HTMLElement; chrome: PanelChrome}
interface DragState {id: string; sectionId: string; index: number; keyboard: boolean; active: boolean; valid: boolean; x: number; y: number; startX: number; startY: number}

/** Own flat sections, pointer/keyboard placement and in-page expansion independently of panel data. */
export class PanelLayout {
  readonly element = el("div", "section-stack");
  private sections = new Map<string, HTMLElement>();
  private views = new Map<string, LayoutView>();
  private handles = new Map<string, AbortController>();
  private lifetime = new AbortController();
  private drag: DragState | null = null;
  private frame = 0;
  private expanded: {id: string; modal: ReturnType<typeof dialog>; placeholder: HTMLElement; scrollTop: number} | null = null;
  private editor: ReturnType<typeof dialog> | null = null;
  private announcement = el("span", "sr-only");
  /** Bind only layout callbacks; data requests remain owned by the chart workspace and table panels. */
  constructor(private scroll: HTMLElement, private state: () => WorkspaceLayout, private changed: () => void, private add: (sectionId: string) => void, private visibilityChanged: () => void) {
    this.announcement.setAttribute("role", "status"); this.element.append(this.announcement);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.drag) {event.preventDefault(); this.cancelDrag();}
    }, {signal: this.lifetime.signal});
  }
  /** Reparent surviving panels without recreating canvases, table state or event ownership. */
  sync(views: Map<string, LayoutView>): void {
    this.views = views;
    if (this.expanded && !views.has(this.expanded.id)) this.expanded.modal.close();
    const layout = this.state();
    for (const [id, section] of this.sections) if (!layout.sections.some(item => item.id === id)) {section.remove(); this.sections.delete(id);}
    for (const [id, owner] of this.handles) if (!views.has(id)) {owner.abort(); this.handles.delete(id);}
    for (const [index, spec] of layout.sections.entries()) {
      let section = this.sections.get(spec.id);
      if (!section) {
        section = el("section", "workspace-section"); section.dataset.sectionId = spec.id;
        section.append(el("header", "section-header"), el("div", "chart-grid section-grid"));
        this.sections.set(spec.id, section);
      }
      const header = section.querySelector<HTMLElement>(".section-header")!;
      header.hidden = layout.sections.length === 1 && !spec.name;
      const toggle = iconButton(`${spec.collapsed ? "Expand" : "Collapse"} section ${spec.name || "Untitled"}`, "down", () => {
        spec.collapsed = !spec.collapsed; this.changed(); this.visibilityChanged();
        this.sections.get(spec.id)?.querySelector<HTMLButtonElement>(".section-toggle")?.focus({preventScroll: true});
      });
      toggle.classList.add("section-toggle");
      toggle.setAttribute("aria-expanded", String(!spec.collapsed)); toggle.classList.toggle("collapsed", spec.collapsed);
      header.replaceChildren(toggle, button(spec.name || "Untitled section", () => this.editSection(spec.id), "section-name"),
        iconButton(`Add to section ${spec.name || "Untitled"}`, "plus", () => this.add(spec.id)));
      const grid = section.querySelector<HTMLElement>(".section-grid")!;
      grid.hidden = spec.collapsed;
      const panels = layout.panels.filter(panel => panel.sectionId === spec.id);
      grid.querySelector(".section-empty")?.remove();
      for (const [position, panel] of panels.entries()) {
        const view = views.get(panel.id);
        if (!view) continue;
        view.element.dataset.panelId = panel.id; view.element.dataset.sectionId = spec.id;
        if (!this.handles.has(panel.id)) this.bindHandle(panel.id, view);
        if (this.expanded?.id === panel.id) continue;
        const at = grid.children[position];
        if (at !== view.element) grid.insertBefore(view.element, at ?? null);
      }
      if (!panels.length) grid.append(el("div", "section-empty muted", "Drop panels here, or use Add."));
      const at = this.element.children[index + 1];
      if (at !== section) this.element.insertBefore(section, at ?? null);
    }
  }
  /** Keep an expanded panel active even after it leaves the chart-scroller intersection root. */
  get expandedId(): string | null {return this.expanded?.id ?? null;}
  /** Restore expanded DOM before its owning panel is removed or a workspace set replaces it. */
  ensurePanels(ids: Set<string>): void {if (this.expanded && !ids.has(this.expanded.id)) this.expanded.modal.close();}
  /** Release handle/fullscreen ownership before a stable panel ID receives another renderer. */
  releaseView(id: string): boolean {
    const expanded = this.expanded?.id === id;
    if (expanded) this.expanded?.modal.close();
    if (this.drag?.id === id) this.cancelDrag();
    this.handles.get(id)?.abort(); this.handles.delete(id); this.views.delete(id);
    return expanded;
  }
  /** Distinguish hidden sections from offscreen panels when cancelling reads. */
  isCollapsed(id: string): boolean {
    const panel = this.state().panels.find(panel => panel.id === id);
    return Boolean(this.state().sections.find(section => section.id === panel?.sectionId)?.collapsed);
  }
  /** Expand the same DOM/canvas in a reliable native dialog, including on nonsecure HTTP origins. */
  expand(id: string): void {
    if (this.expanded) return;
    const view = this.views.get(id);
    if (!view) return;
    this.cancelDrag();
    const placeholder = el("div", "panel-placeholder");
    const box = view.element.getBoundingClientRect();
    placeholder.style.height = `${box.height}px`; placeholder.classList.toggle("wide", view.element.classList.contains("wide"));
    view.element.before(placeholder);
    const top = this.scroll.scrollTop;
    const modal = dialog(view.chrome.title.textContent ?? "Panel", "panel-fullscreen", () => {
      placeholder.replaceWith(view.element); view.element.classList.remove("is-expanded"); view.chrome.setExpanded(false);
      this.expanded = null; this.scroll.scrollTop = top; this.visibilityChanged();
    });
    this.expanded = {id, modal, placeholder, scrollTop: top};
    view.chrome.setExpanded(true); view.element.classList.add("is-expanded"); modal.body.append(view.element);
    this.visibilityChanged();
  }
  /** Add named groups without disturbing the existing initial unheaded group. */
  addSection(name: string): string {
    const id = uiIdentifier("section");
    this.state().sections.push({id, name: name.trim().slice(0, 100) || "Untitled section", collapsed: false}); this.changed(); return id;
  }
  /** Rename or safely remove a section while preserving every contained panel. */
  editSection(id: string): void {
    const section = this.state().sections.find(section => section.id === id);
    if (!section) return;
    this.editor?.close();
    const modal = dialog("Section", "", () => {this.editor = null;}); this.editor = modal;
    const name = el("input", "text-input"); name.value = section.name; name.maxLength = 100; name.setAttribute("aria-label", "Section name");
    modal.body.append(field("Name", name), el("p", "muted", "Deleting a section moves its panels into another section; no panels are deleted."),
      button("Save", () => {section.name = name.value.trim(); modal.close(); this.changed();}, "button primary"),
      button("Delete section", () => {removeSection(this.state(), id); modal.close(); this.changed(); this.visibilityChanged();}, "button quiet"));
    name.focus();
  }
  /** Restrict dragging to the explicit handle so plot zoom and table resizing retain their own gestures. */
  private bindHandle(id: string, view: LayoutView): void {
    const owner = new AbortController(); this.handles.set(id, owner);
    const handle = view.chrome.handle;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || handle.disabled || this.expanded) return;
      const panel = this.state().panels.find(panel => panel.id === id);
      if (!panel) return;
      this.drag = {id, sectionId: panel.sectionId, index: 0, keyboard: false, active: false, valid: false, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY};
      handle.setPointerCapture(event.pointerId);
    }, {signal: owner.signal});
    handle.addEventListener("pointermove", event => {
      const drag = this.drag;
      if (!drag || drag.id !== id || drag.keyboard) return;
      drag.x = event.clientX; drag.y = event.clientY;
      if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
      drag.active = true; handle.setAttribute("aria-pressed", "true"); view.element.classList.add("is-dragging"); this.pointerTarget();
      if (!this.frame) this.frame = requestAnimationFrame(() => this.autoscroll());
    }, {signal: owner.signal});
    handle.addEventListener("pointerup", () => {if (this.drag?.id === id && !this.drag.keyboard) this.drop();}, {signal: owner.signal});
    handle.addEventListener("pointercancel", () => this.cancelDrag(), {signal: owner.signal});
    handle.addEventListener("keydown", event => this.keyboardMove(id, event), {signal: owner.signal});
  }
  /** Resolve a visible insertion edge or an empty/collapsed section under the pointer. */
  private pointerTarget(): void {
    const drag = this.drag; if (!drag) return;
    const boundary = this.scroll.getBoundingClientRect();
    drag.valid = drag.x >= boundary.left && drag.x <= boundary.right && drag.y >= boundary.top && drag.y <= boundary.bottom;
    if (!drag.valid) {this.showTarget(); return;}
    // The translucent origin ignores pointer events, so geometry must retain its own slot.
    const origin = this.views.get(drag.id)?.element.getBoundingClientRect();
    if (origin && drag.x >= origin.left && drag.x <= origin.right && drag.y >= origin.top && drag.y <= origin.bottom) {
      const panel = this.state().panels.find(panel => panel.id === drag.id)!;
      drag.sectionId = panel.sectionId;
      drag.index = this.state().panels.filter(item => item.sectionId === panel.sectionId).findIndex(item => item.id === panel.id);
      this.showTarget(); return;
    }
    const hit = document.elementFromPoint(drag.x, drag.y);
    const section = hit?.closest<HTMLElement>(".workspace-section");
    if (!section) {drag.valid = false; this.showTarget(); return;}
    drag.sectionId = section.dataset.sectionId!;
    const panels = this.state().panels.filter(panel => panel.sectionId === drag.sectionId && panel.id !== drag.id);
    const target = hit?.closest<HTMLElement>("[data-panel-id]");
    const index = panels.findIndex(panel => panel.id === target?.dataset.panelId);
    if (index < 0 || !target) drag.index = panels.length;
    else {
      const rect = target.getBoundingClientRect();
      const after = drag.y > rect.top + rect.height * .75 || drag.y >= rect.top + rect.height * .25 && drag.x > rect.left + rect.width / 2;
      drag.index = index + Number(after);
    }
    this.showTarget();
  }
  /** Scroll the graph region while a captured pointer waits near its upper or lower edge. */
  private autoscroll(): void {
    this.frame = 0;
    const drag = this.drag; if (!drag?.active || drag.keyboard) return;
    const box = this.scroll.getBoundingClientRect();
    const speed = drag.y < box.top + 48 ? -12 : drag.y > box.bottom - 48 ? 12 : 0;
    if (speed) {this.scroll.scrollTop += speed; this.pointerTarget();}
    this.frame = requestAnimationFrame(() => this.autoscroll());
  }
  /** Offer equivalent keyboard placement with a cancellable target, not hidden move-menu actions. */
  private keyboardMove(id: string, event: KeyboardEvent): void {
    if (this.expanded) return;
    if (event.key === "Escape") {event.preventDefault(); this.cancelDrag(); return;}
    if ((event.key === " " || event.key === "Enter") && this.drag?.id === id) {event.preventDefault(); this.drop(); return;}
    if (event.key === " " && !this.drag) {
      event.preventDefault();
      const panel = this.state().panels.find(panel => panel.id === id)!;
      const index = this.state().panels.filter(item => item.sectionId === panel.sectionId).findIndex(item => item.id === id);
      this.drag = {id, sectionId: panel.sectionId, index, keyboard: true, active: true, valid: true, x: 0, y: 0, startX: 0, startY: 0};
      this.views.get(id)?.element.classList.add("is-dragging");
      this.views.get(id)?.chrome.handle.setAttribute("aria-pressed", "true"); this.showTarget(); return;
    }
    const drag = this.drag;
    if (!drag?.keyboard || drag.id !== id || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const sections = this.state().sections;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const next = Math.max(0, Math.min(sections.length - 1, sections.findIndex(section => section.id === drag.sectionId) + (event.key === "ArrowRight" ? 1 : -1)));
      drag.sectionId = sections[next]!.id; drag.index = 0;
    } else drag.index = Math.max(0, Math.min(this.state().panels.filter(panel => panel.sectionId === drag.sectionId && panel.id !== id).length, drag.index + (event.key === "ArrowDown" ? 1 : -1)));
    this.showTarget();
  }
  /** Mark a concrete target without moving data-bearing elements until the user commits. */
  private showTarget(): void {
    this.element.querySelectorAll(".drop-before,.drop-after,.drop-empty").forEach(node => node.classList.remove("drop-before", "drop-after", "drop-empty"));
    const drag = this.drag; if (!drag) return;
    if (!drag.valid) {this.announcement.textContent = "Outside the workspace. Release to cancel."; return;}
    const panels = this.state().panels.filter(panel => panel.sectionId === drag.sectionId && panel.id !== drag.id);
    const target = panels[drag.index];
    if (target) this.views.get(target.id)?.element.classList.add("drop-before");
    else if (panels.length) this.views.get(panels.at(-1)!.id)?.element.classList.add("drop-after");
    else this.sections.get(drag.sectionId)?.classList.add("drop-empty");
    const section = this.state().sections.find(section => section.id === drag.sectionId);
    this.announcement.textContent = `Move to ${section?.name || "initial section"}, position ${drag.index + 1}. Enter drops; Escape cancels.`;
  }
  /** Commit one placement while keeping the exact same chart/table instance and focused handle. */
  private drop(): void {
    const drag = this.drag;
    if (!drag?.active || !drag.valid) {this.cancelDrag(); return;}
    const panels = this.state().panels.filter(panel => panel.sectionId === drag.sectionId && panel.id !== drag.id);
    movePanel(this.state(), drag.id, drag.sectionId, panels[drag.index]?.id);
    const section = this.state().sections.find(section => section.id === drag.sectionId);
    if (section) section.collapsed = false;
    this.cancelDrag(); this.changed(); this.visibilityChanged();
    this.announcement.textContent = `Panel moved to ${section?.name || "initial section"}, position ${drag.index + 1}.`;
    this.views.get(drag.id)?.chrome.handle.focus({preventScroll: true});
  }
  /** Cancel visual placement without changing persisted order or leaving autoscroll running. */
  private cancelDrag(): void {
    if (this.drag) {
      this.views.get(this.drag.id)?.chrome.handle.setAttribute("aria-pressed", "false");
      this.announcement.textContent = "Move canceled.";
    }
    cancelAnimationFrame(this.frame); this.frame = 0; this.drag = null;
    this.element.querySelectorAll(".is-dragging,.drop-before,.drop-after,.drop-empty").forEach(node => node.classList.remove("is-dragging", "drop-before", "drop-after", "drop-empty"));
  }
  /** Release moved DOM and every interaction listener before workspace teardown. */
  destroy(): void {
    this.cancelDrag(); this.expanded?.modal.close(); this.editor?.close();
    for (const owner of this.handles.values()) owner.abort();
    this.handles.clear(); this.lifetime.abort();
  }
}
