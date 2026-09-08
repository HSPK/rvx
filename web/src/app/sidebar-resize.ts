import {el} from "./ui";

/** Keep a desktop preference independent of responsive clamping and the mobile selector sheet. */
export class SidebarResize {
  readonly element = el("div", "sidebar-resizer");
  private preferred: number;
  private lifetime = new AbortController();
  private drag: {id: number; x: number; width: number} | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  constructor(private layout: HTMLElement, width: number, private commit: (width: number) => void) {
    this.preferred = width;
    this.element.tabIndex = 0;
    this.element.setAttribute("role", "separator");
    this.element.setAttribute("aria-label", "Resize run list");
    this.element.setAttribute("aria-orientation", "vertical");
    this.element.setAttribute("aria-valuemin", "220");
    const signal = this.lifetime.signal;
    this.element.addEventListener("pointerdown", event => {
      if (event.button !== 0 || innerWidth <= 900) return;
      event.preventDefault();
      this.drag = {id: event.pointerId, x: event.clientX, width: this.effective};
      this.element.setPointerCapture(event.pointerId); this.element.classList.add("is-resizing");
    }, {signal});
    this.element.addEventListener("pointermove", event => {
      if (this.drag?.id === event.pointerId) this.set(Math.round(this.drag.width + event.clientX - this.drag.x), false);
    }, {signal});
    const end = (event: PointerEvent): void => {
      if (this.drag?.id !== event.pointerId) return;
      this.drag = null; this.element.classList.remove("is-resizing");
      if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
      this.commit(this.preferred);
    };
    this.element.addEventListener("pointerup", end, {signal});
    this.element.addEventListener("pointercancel", end, {signal});
    this.element.addEventListener("lostpointercapture", end, {signal});
    this.element.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      this.set(event.key === "Home" ? 220 : event.key === "End" ? this.maximum : this.effective + (event.key === "ArrowRight" ? 10 : -10), false);
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {this.debounce = null; this.commit(this.preferred);}, 250);
    }, {signal});
    window.addEventListener("resize", () => this.render(), {signal});
    this.render();
  }
  private get maximum(): number {return Math.max(220, Math.min(520, innerWidth - 640));}
  private get effective(): number {return Math.min(this.preferred, this.maximum);}
  set(width: number, restored = true): void {
    if (restored && (this.drag || this.debounce)) return;
    this.preferred = Math.round(Math.max(220, Math.min(restored ? 520 : this.maximum, width))); this.render();
  }
  private render(): void {
    this.layout.style.setProperty("--sidebar-width", `${this.effective}px`);
    this.element.setAttribute("aria-valuemax", String(this.maximum));
    this.element.setAttribute("aria-valuenow", String(this.effective));
    this.element.setAttribute("aria-valuetext", `${this.effective} pixels`);
  }
  destroy(): void {if (this.debounce) clearTimeout(this.debounce); this.lifetime.abort();}
}
