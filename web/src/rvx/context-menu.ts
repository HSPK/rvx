export interface ContextMenuItem {
  label?: string;
  shortcut?: string;
  separator?: boolean;
  action?: () => void;
}

export class ContextMenu {
  private element: HTMLElement | null = null;

  open(event: MouseEvent, items: ContextMenuItem[]): void {
    this.close();
    const menu = document.createElement("div");
    menu.className = "rvx-context-menu";
    menu.setAttribute("role", "menu");
    for (const item of items) {
      if (item.separator) {
        menu.append(document.createElement("hr"));
        continue;
      }
      if (!item.label || !item.action) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      const label = document.createElement("span");
      const shortcut = document.createElement("kbd");
      label.textContent = item.label;
      shortcut.textContent = item.shortcut ?? "";
      button.append(label, shortcut);
      button.addEventListener("click", () => {
        item.action?.();
        this.close();
      });
      menu.append(button);
    }
    document.body.append(menu);
    const left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 6);
    const top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 6);
    menu.style.left = `${Math.max(4, left)}px`;
    menu.style.top = `${Math.max(4, top)}px`;
    this.element = menu;
    requestAnimationFrame(() => menu.querySelector("button")?.focus());
    window.addEventListener(
      "pointerdown",
      closeEvent => {
        if (!menu.contains(closeEvent.target as Node)) this.close();
      },
      {capture: true, once: true},
    );
  }

  close(): void {
    this.element?.remove();
    this.element = null;
  }
}
