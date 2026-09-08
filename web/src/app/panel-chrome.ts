import {button, el, iconButton} from "./ui";

export type PanelAction = "edit" | "remove" | "size" | "expand";

/** Share centered actions, top-layer menus and drag affordances across charts and tables. */
export class PanelChrome {
  readonly element = el("header", "chart-header panel-header");
  readonly title = el("h2");
  readonly unit = el("span", "metric-unit");
  readonly status = el("span", "chart-status muted", "Loading…");
  readonly handle = button("Move panel", () => {}, "panel-drag-handle");
  private titleText = el("span", "panel-title-text");
  readonly trigger = iconButton("Panel options", "more", () => {});
  private menu = el("div", "menu-content");
  private sizeAction: HTMLButtonElement;
  private expand: HTMLButtonElement;
  private lifetime = new AbortController();
  private tracking: AbortController | null = null;
  /** Build one optional action surface; previews retain titles and status but no workspace actions. */
  constructor(private kind: "chart" | "table" | "snapshot", private action: (action: PanelAction) => void, private preview = false, private transition: () => void = () => {}) {
    const heading = el("div", "metric-heading"); heading.append(this.title);
    this.element.classList.toggle("panel-preview", preview);
    if (!preview) {this.handle.replaceChildren(this.titleText, this.unit); this.title.append(this.handle);}
    else this.title.append(this.titleText, this.unit);
    this.trigger.classList.add("menu-trigger");
    this.handle.setAttribute("aria-description", "Space picks up this panel. Up/down reorders; left/right changes section. Enter drops; Escape cancels.");
    this.handle.setAttribute("aria-keyshortcuts", "Space ArrowUp ArrowDown ArrowLeft ArrowRight Enter Escape");
    this.handle.setAttribute("aria-pressed", "false");
    const choice = (label: string, action: PanelAction): HTMLButtonElement => {
      const item = button(label, () => {
        this.menu.hidePopover(); this.trigger.focus({preventScroll: true}); this.action(action);
        if (action === "size" && this.trigger.isConnected) this.trigger.focus({preventScroll: true});
      }, "menu-item");
      item.setAttribute("role", "menuitem"); return item;
    };
    this.sizeAction = choice("Make wide", "size");
    this.expand = choice("Fullscreen", "expand");
    this.menu.append(choice(`Edit ${kind}`, "edit"), this.expand, this.sizeAction, choice(`Remove ${kind}`, "remove"));
    this.menu.popover = "auto"; this.menu.setAttribute("role", "menu");
    this.trigger.popoverTargetElement = this.menu; this.trigger.setAttribute("aria-haspopup", "menu"); this.trigger.setAttribute("aria-expanded", "false");
    const actions = el("div", "panel-actions"); actions.append(this.trigger, this.menu);
    const indicators = el("div", "panel-indicators"); indicators.append(this.status);
    this.element.append(heading, indicators);
    if (!preview) {this.element.append(actions); this.wireMenu();}
  }
  /** Chart-local actions never widen the shared workspace/table action contract. */
  addAction(label: string, action: () => void): HTMLButtonElement {
    const item = button(label, () => {
      this.menu.hidePopover(); this.trigger.focus({preventScroll: true}); action();
    }, "menu-item");
    item.setAttribute("role", "menuitem");
    this.menu.insertBefore(item, this.sizeAction);
    return item;
  }
  /** Prevent transient chart readouts from appearing over an open action menu. */
  get menuOpen(): boolean {return this.menu.matches(":popover-open");}
  /** Update names and size hints without replacing focused controls. */
  update(title: string, unit: string | null, size: "normal" | "wide"): void {
    this.titleText.textContent = title;
    this.title.setAttribute("aria-label", title);
    this.title.title = title; this.unit.textContent = unit ?? "";
    for (const [control, label] of [[this.trigger, `${title} ${this.kind} options`], [this.handle, `Move ${title}`]] as const) {
      control.title = label; control.setAttribute("aria-label", label);
    }
    this.handle.title = `${title} · Drag to move, or press Space`;
    this.menu.setAttribute("aria-label", `Actions for ${title}`);
    this.sizeAction.textContent = size === "wide" ? "Normal width" : "Make wide";
  }
  /** Fullscreen owns its own close control and never participates in workspace dragging. */
  setExpanded(expanded: boolean): void {this.transition(); this.handle.disabled = expanded; this.expand.hidden = expanded;}
  /** Open and focus menus synchronously so queued native toggle events cannot steal keyboard selection. */
  private wireMenu(): void {
    const signal = this.lifetime.signal;
    this.trigger.addEventListener("click", event => {
      event.preventDefault();
      this.transition();
      if (this.menu.matches(":popover-open")) {this.menu.hidePopover(); return;}
      this.menu.showPopover(); this.position();
      this.menu.querySelector<HTMLButtonElement>("button:not(:disabled):not([hidden])")?.focus({preventScroll: true});
    }, {signal});
    this.menu.addEventListener("beforetoggle", () => this.transition(), {signal});
    this.menu.addEventListener("toggle", () => {
      this.tracking?.abort();
      const open = this.menu.matches(":popover-open"); this.trigger.setAttribute("aria-expanded", String(open));
      if (!open) return;
      this.tracking = new AbortController();
      window.addEventListener("resize", () => this.position(), {signal: this.tracking.signal});
      window.addEventListener("scroll", () => this.position(), {capture: true, signal: this.tracking.signal});
    }, {signal});
    this.menu.addEventListener("keydown", event => {
      if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); this.menu.hidePopover(); this.trigger.focus(); return;}
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...this.menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([hidden])")];
      const index = items.findIndex(item => item === document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      event.preventDefault(); items[next]?.focus();
    }, {signal});
    this.menu.addEventListener("focusout", event => {
      if (this.menu.matches(":popover-open") && event.relatedTarget instanceof Node && !this.menu.contains(event.relatedTarget) && event.relatedTarget !== this.trigger) this.menu.hidePopover();
    }, {signal});
  }
  /** Flip above near the viewport edge and stop following anchors that leave their scroll region. */
  private position(): void {
    if (!this.menu.matches(":popover-open")) return;
    const anchor = this.trigger.getBoundingClientRect(), boundary = this.element.closest(".chart-scroll")?.getBoundingClientRect();
    if (boundary && (anchor.bottom < boundary.top || anchor.top > boundary.bottom)) {this.menu.hidePopover(); return;}
    const {width, height} = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
    this.menu.style.top = `${anchor.bottom + height + 6 <= innerHeight - 8 ? anchor.bottom + 6 : Math.max(8, anchor.top - height - 6)}px`;
  }
  /** Release top-layer and viewport listeners with the panel that owns them. */
  destroy(): void {if (this.menu.matches(":popover-open")) this.menu.hidePopover(); this.tracking?.abort(); this.lifetime.abort();}
}
