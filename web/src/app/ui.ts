/** Render supplied labels as text rather than interpreting metadata as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const paths = {
  plus: "M12 5v14M5 12h14", close: "m6 6 12 12M6 18 18 6", back: "m12 5-7 7 7 7M5 12h15",
  more: "M5 12h.01M12 12h.01M19 12h.01", search: "m16 16 4 4M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  sun: "M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  moon: "M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11", pause: "M8 5v14M16 5v14",
  play: "m8 5 11 7-11 7z", arrow: "M4 12h16m-6-6 6 6-6 6", check: "m5 12 4 4L19 6",
  refresh: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5",
  runs: "M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01",
  info: "M12 17v-5M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  expand: "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5",
  grip: "M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01",
  down: "m6 9 6 6 6-6", left: "m14 6-6 6 6 6", right: "m10 6 6 6-6 6",
  columns: "M3 4h18v16H3zM9 4v16M15 4v16",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  edit: "m16 3 5 5-12 12H4v-5zM14 5l5 5",
  trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  eyeOff: "m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.1 3.8M6.3 6.3A20 20 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  logout: "M10 3H4v18h6M14 7l5 5-5 5M8 12h11",
} as const;
/** Use local decorative glyphs without network assets or duplicate screen-reader announcements. */
export function icon(name: keyof typeof paths): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (name === "more") {
    svg.setAttribute("fill", "currentColor"); svg.setAttribute("stroke", "none");
    for (const x of [5, 12, 19]) {
      const dot = document.createElementNS(svg.namespaceURI, "circle");
      dot.setAttribute("cx", String(x)); dot.setAttribute("cy", "12"); dot.setAttribute("r", "1.8"); svg.append(dot);
    }
  } else {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", paths[name]);
    svg.append(path);
  }
  return svg;
}
/** Create a keyboard-operable action that never submits an enclosing form accidentally. */
export function button(label: string, action: () => void, className = "button", glyph?: keyof typeof paths): HTMLButtonElement {
  const node = el("button", className);
  node.type = "button";
  if (glyph) node.append(icon(glyph));
  node.append(el("span", "", label));
  node.addEventListener("click", action);
  return node;
}
/** Give icon-only actions an explicit accessible name and discoverable tooltip. */
export function iconButton(label: string, glyph: keyof typeof paths, action: () => void): HTMLButtonElement {
  const node = button(label, action, "icon-button", glyph);
  node.title = label;
  node.setAttribute("aria-label", label);
  return node;
}
/** Keep native keyboard and touch selection while binding options by stable values. */
export function select(label: string, options: [string, string][], value: string, onChange: (value: string) => void): HTMLSelectElement {
  const node = el("select", "select");
  node.setAttribute("aria-label", label);
  node.title = label;
  // Native selectedcontent truncates the closed label without a separate hidden-select facade.
  if (CSS.supports("appearance", "base-select")) {
    const trigger = el("button", "select-button");
    trigger.type = "button";
    trigger.append(document.createElement("selectedcontent"));
    node.append(trigger);
  }
  for (const [id, name] of options) node.add(new Option(name, id));
  node.value = value;
  node.addEventListener("change", () => onChange(node.value));
  return node;
}
/** Associate a visible field description with its input without generated ID dependencies. */
export function field(label: string, input: HTMLElement): HTMLLabelElement {
  const wrapper = el("label", "field");
  wrapper.append(el("span", "field-label", label), input);
  return wrapper;
}
/** Present empty and failure states with an optional direct recovery action. */
export function message(title: string, description: string, action?: HTMLElement): HTMLElement {
  const node = el("div", "empty-state");
  node.append(el("h2", "", title), el("p", "muted", description));
  if (action) node.append(action);
  return node;
}
/** Surface known error messages without exposing arbitrary thrown objects. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}
/** Use native modal focus handling, restoring the opener and releasing DOM on close. */
export function dialog(title: string, className = "", onClose?: () => void): {node: HTMLDialogElement; body: HTMLElement; close: () => void} {
  const node = el("dialog", `dialog ${className}`);
  const heading = el("h2", "", title);
  const header = el("header", "dialog-header");
  const previousFocus = document.activeElement as HTMLElement | null;
  let closed = false;
  // Native close events are queued; dispose drafts and reads before returning to the workspace.
  const finish = (): void => {
    if (closed) return;
    closed = true; node.remove(); onClose?.(); previousFocus?.focus();
  };
  const close = (): void => {if (!closed) {node.close(); finish();}};
  node.setAttribute("aria-label", title);
  header.append(heading, iconButton("Close", "close", close));
  const body = el("div", "dialog-body");
  node.append(header, body);
  node.addEventListener("close", finish, {once: true});
  node.addEventListener("cancel", event => {event.preventDefault(); close();});
  node.addEventListener("click", event => {
    if (event.target === node) {
      const rect = node.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    }
  });
  document.body.append(node);
  node.showModal();
  return {node, body, close};
}

/** Keep lightweight workspace actions beside their trigger without blocking the chart surface. */
export function anchoredDialog(title: string, anchor: HTMLElement, onClose: () => void): ReturnType<typeof dialog> {
  const node = el("dialog", "dialog workspace-popover"), body = el("div", "dialog-body");
  const lifetime = new AbortController();
  let closed = false;
  const position = (): void => {
    if (closed || !node.matches(":popover-open")) return;
    const box = anchor.getBoundingClientRect(), popup = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(box.left, innerWidth - popup.width - 8))}px`;
    node.style.top = `${box.bottom + popup.height + 6 <= innerHeight - 8 ? box.bottom + 6 : Math.max(8, box.top - popup.height - 6)}px`;
  };
  const resize = new ResizeObserver(position);
  const finish = (restore: boolean): void => {
    if (closed) return;
    closed = true; resize.disconnect(); lifetime.abort(); node.remove();
    anchor.setAttribute("aria-expanded", "false"); onClose();
    if (restore && anchor.isConnected) anchor.focus({preventScroll: true});
  };
  const close = (): void => {
    if (closed) return;
    if (node.matches(":popover-open")) node.hidePopover();
    finish(true);
  };
  node.popover = "auto"; node.setAttribute("aria-label", title);
  node.append(body); document.body.append(node);
  node.addEventListener("toggle", () => {if (!node.matches(":popover-open")) finish(false);}, {signal: lifetime.signal});
  node.addEventListener("keydown", event => {
    if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); close();}
  }, {signal: lifetime.signal});
  window.addEventListener("resize", position, {signal: lifetime.signal});
  window.addEventListener("scroll", position, {capture: true, signal: lifetime.signal});
  node.showPopover(); anchor.setAttribute("aria-expanded", "true");
  resize.observe(node); position();
  return {node, body, close};
}
