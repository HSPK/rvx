import {uiIdentifier} from "../core/identifiers";
import {copyFilterGroups, validFilterGroups, type TableFilterGroup} from "./panels";
import type {FilterColumn} from "./table-filters";
import {button, el, field, iconButton, select} from "./ui";

/** Reuse toolbar controls across live refreshes so focused native pickers remain open. */
export class FilterGroupToolbar {
  readonly element = el("div", "filter-group-toolbar");
  private signature = "";

  constructor(private changed: (id: string, selected: string | undefined) => void) {}

  sync(groups: TableFilterGroup[] = []): void {
    const signature = JSON.stringify(groups.map(({selected: _selected, ...definition}) => definition));
    if (signature !== this.signature) {
      this.signature = signature;
      this.element.replaceChildren(...groups.map(group => {
        const container = el("div", "toolbar-filter-group");
        container.dataset.groupId = group.id;
        const options: [string, string][] = [["", "All"], ...group.options.map(option => [option.value, option.label] as [string, string])];
        if (group.display === "select") {
          container.append(field(group.name, select(group.name, options, group.selected ?? "",
            value => this.changed(group.id, value || undefined))));
        } else {
          container.setAttribute("role", "radiogroup"); container.setAttribute("aria-label", group.name);
          container.append(el("span", "filter-group-label", group.name));
          const name = uiIdentifier("filter-options");
          for (const [value, label] of options) {
            const input = el("input"); input.type = "radio"; input.name = name; input.value = value;
            input.addEventListener("change", () => {if (input.checked) this.changed(group.id, value || undefined);});
            const item = el("label", "filter-radio-option"); item.append(input, el("span", "", label)); container.append(item);
          }
        }
        return container;
      }));
    }
    this.element.hidden = !groups.length;
    for (const [index, group] of groups.entries()) {
      const container = this.element.children[index]!;
      const picker = container.querySelector("select");
      if (picker) picker.value = group.selected ?? "";
      for (const input of container.querySelectorAll<HTMLInputElement>('input[type="radio"]')) input.checked = input.value === (group.selected ?? "");
    }
  }
}

export function filterGroupEditor(columns: FilterColumn[], input: TableFilterGroup | undefined,
  saved: (group: TableFilterGroup) => void, cancelled: () => void): HTMLElement {
  const editor = el("div", "filter-group-editor");
  const name = el("input", "text-input"); name.value = input?.name ?? ""; name.maxLength = 120; name.placeholder = "Group name"; name.setAttribute("aria-label", "Group name");
  const choices: [string, string][] = columns.filter(column => column.filterable !== false).map(column => [column.id, column.label]);
  if (input && !choices.some(([path]) => path === input.path)) choices.push([input.path, `${input.path} (not recorded)`]);
  const column = select("Group column", choices, input?.path ?? choices[0]?.[0] ?? "", () => {});
  const display = select("Group display", [["select", "Dropdown"], ["radio", "Radio group"]], input?.display ?? "select", () => {});
  const options = input ? copyFilterGroups([input])[0]!.options : [{label: "", value: ""}];
  const settings = el("div", "filter-group-settings");
  settings.append(field("Column", column), field("Display", display));
  const headings = el("div", "filter-group-option-headings");
  headings.setAttribute("aria-hidden", "true");
  headings.append(el("span", "", "Value"), el("span", "", "Label"));
  headings.lastElementChild!.setAttribute("title", "Leave blank to use the value");
  const rows = el("div", "filter-group-options");
  const error = el("p", "error-text"); error.setAttribute("role", "alert");
  const render = (): void => {
    rows.replaceChildren(...options.map((option, index) => {
      const row = el("div", "filter-group-option");
      const label = el("input", "text-input"); label.value = option.label; label.maxLength = 120;
      label.setAttribute("aria-description", "Optional. Leave blank to use the value.");
      label.setAttribute("aria-label", `Option label ${index + 1}`); label.addEventListener("input", () => {option.label = label.value;});
      const value = el("input", "text-input"); value.value = option.value; value.placeholder = "Value";
      value.setAttribute("aria-label", `Option value ${index + 1}`); value.addEventListener("input", () => {option.value = value.value;});
      row.append(value, label, iconButton(`Delete option ${index + 1}`, "trash", () => {
        options.splice(index, 1); render();
        (rows.children[Math.min(index, options.length - 1)]?.querySelector("input") ?? add).focus();
      }));
      return row;
    }));
    add.disabled = options.length >= 32;
  };
  const add = button("Add option", () => {options.push({label: "", value: ""}); render(); rows.lastElementChild?.querySelector("input")?.focus();}, "button quiet");
  const save = button("Save group", () => {
    const group: TableFilterGroup = {id: input?.id ?? uiIdentifier("filter-group"), name: name.value.trim(), path: column.value,
      display: display.value === "radio" ? "radio" : "select",
      options: options.map(option => ({label: option.label.trim() || option.value, value: option.value}))};
    if (input?.selected !== undefined && group.options.some(option => option.value === input.selected)) group.selected = input.selected;
    if (!group.name) {error.textContent = "Enter a group name."; name.focus(); return;}
    if (column.selectedIndex < 0) {error.textContent = "Choose a column."; column.focus(); return;}
    if (!group.options.length || group.options.some(option => !option.value.trim())) {
      error.textContent = "Enter at least one nonempty value."; return;
    }
    if (new Set(group.options.map(option => option.value)).size !== group.options.length) {
      error.textContent = "Option values must be unique."; return;
    }
    if (!validFilterGroups([group])) {
      error.textContent = "Use up to 32 options, 120 characters per label and 4096 bytes per value.";
      return;
    }
    saved(group);
  }, "button primary");
  const actions = el("div", "filter-group-actions");
  const cancel = button("Cancel", cancelled, "button quiet"); cancel.setAttribute("aria-label", "Cancel group");
  actions.append(add, cancel, save);
  editor.append(name, settings, headings, rows, error, actions);
  render();
  return editor;
}
