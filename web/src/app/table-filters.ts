import {uiIdentifier} from "../core/identifiers";
import {copyFilterGroups, filterGroupLimit, type TableFilterGroup, type TableFilterPreference, type TableQueryPreference} from "./panels";
import {filterGroupEditor} from "./filter-groups";
import {button, dialog, el, iconButton, select} from "./ui";

export interface FilterColumn {id: string; label: string; filterable?: boolean}

/** Edit copied conditions, retaining disabled rules until they are explicitly removed. */
export function openTableFilters(columns: FilterColumn[], input: TableQueryPreference,
  changed: (query: TableQueryPreference) => void, closed?: () => void): ReturnType<typeof dialog> {
  const filters = (input.filters ?? []).map(filter => ({...filter}));
  const groups = copyFilterGroups(input.filterGroups);
  const modal = dialog("Filter rows", "table-filters-dialog", closed);
  const column = select("Filter column", columns.filter(column => column.filterable !== false).map(column => [column.id, column.label]), "", () => {});
  column.selectedIndex = 0;
  const operation = select("Filter operation", [["contains", "Contains"], ["eq", "Equals"], ["gt", "Greater than"], ["lt", "Less than"]], "contains", () => {});
  const value = el("input", "text-input"); value.setAttribute("aria-label", "Filter value"); value.placeholder = "Value";
  const error = el("p", "error-text"); error.setAttribute("role", "alert");
  const tabs = el("div", "filter-editor-tabs");
  tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Filter editor");
  tabs.setAttribute("aria-description", "All enabled conditions and selected groups are combined with AND.");
  const conditions = el("section", "filter-editor-panel"), groupSection = el("section", "filter-editor-panel");
  const tabButtons: HTMLButtonElement[] = [];
  for (const [index, [name, panel]] of ([["Conditions", conditions], ["Groups", groupSection]] as const).entries()) {
    panel.id = uiIdentifier("filter-panel"); panel.setAttribute("role", "tabpanel");
    const tab = button(name, () => {
      for (const [position, control] of tabButtons.entries()) {
        const selected = position === index;
        control.setAttribute("aria-selected", String(selected)); control.tabIndex = selected ? 0 : -1;
        [conditions, groupSection][position]!.hidden = !selected;
      }
    }, "filter-editor-tab");
    tab.id = uiIdentifier("filter-tab"); tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panel.id); panel.setAttribute("aria-labelledby", tab.id);
    tab.setAttribute("aria-selected", String(index === 0)); tab.tabIndex = index === 0 ? 0 : -1; panel.hidden = index !== 0;
    tabButtons.push(tab); tabs.append(tab);
  }
  tabs.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const current = tabButtons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? tabButtons.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : tabButtons.length - 1)) % tabButtons.length;
    tabButtons[index]!.focus(); tabButtons[index]!.click();
  });
  const publish = (): void => changed({...input, filters: filters.map(filter => ({...filter})), filterGroups: copyFilterGroups(groups)});
  const list = el("div", "table-filter-list");
  let editing: number | null = null;
  const updateSubmit = (): void => {
    submit.disabled = !column.value || !value.value.trim();
    error.textContent = "";
  };
  const renderFilters = (): void => {
    list.replaceChildren();
    updateClear();
    for (const [index, filter] of filters.entries()) {
      const row = el("div", "active-table-filter");
      const enabled = el("input"); enabled.type = "checkbox"; enabled.checked = filter.enabled !== false;
      enabled.setAttribute("aria-label", `Enable filter ${index + 1}`);
      enabled.addEventListener("change", () => {
        filter.enabled = enabled.checked; updateClear(); publish();
      });
      const operators = {contains: "contains", eq: "=", gt: ">", lt: "<"};
      const edit = button(`${columns.find(column => column.id === filter.path)?.label ?? filter.path} ${operators[filter.op]} ${filter.value}`, () => {
        editing = index; column.value = filter.path; operation.value = filter.op; value.value = filter.value;
        submit.querySelector("span")!.textContent = "Update filter"; updateSubmit(); value.focus();
      }, "filter-condition");
      edit.setAttribute("aria-label", `Edit filter ${index + 1}`);
      const remove = iconButton(`Delete filter ${index + 1}`, "trash", () => {
        filters.splice(index, 1);
        if (editing === index) {
          editing = null; value.value = ""; submit.querySelector("span")!.textContent = "Add filter";
        } else if (editing !== null && editing > index) editing--;
        renderFilters(); updateSubmit(); publish();
        const next = list.querySelectorAll<HTMLButtonElement>(".icon-button")[Math.min(index, filters.length - 1)];
        (next ?? value).focus();
      });
      row.append(enabled, edit, remove); list.append(row);
    }
  };
  const criteria = el("div", "filter-criteria"), entry = el("div", "filter-entry");
  criteria.append(column, operation, value);
  const submit = button("Add filter", () => {
    if (!value.value.trim()) {error.textContent = "Enter a filter value."; value.focus(); return;}
    if (editing === null && filters.length + groups.length >= 32) {error.textContent = "Use at most 32 filters, including toolbar groups."; return;}
    if (new TextEncoder().encode(value.value).length > 4096) {error.textContent = "Filter values must fit within 4096 UTF-8 bytes."; return;}
    const op = operation.value;
    if (!column.value) {error.textContent = "Choose a column recorded in the current data."; column.focus(); return;}
    if (!["contains", "eq", "gt", "lt"].includes(op)) {error.textContent = "Choose a filter condition."; operation.focus(); return;}
    if (op === "contains" || op === "eq" || op === "gt" || op === "lt") {
      const filter: TableFilterPreference = {path: column.value, op, value: value.value};
      if (editing === null) filters.push(filter); else filters[editing] = {...filters[editing], ...filter};
    }
    modal.close(); publish();
  }, "button primary");
  entry.append(submit);
  const clear = button("Disable all", () => {
    for (const filter of filters) filter.enabled = false;
    for (const group of groups) delete group.selected;
    modal.close(); publish();
  }, "text-button");
  const updateClear = (): void => {
    clear.hidden = !filters.length && !groups.length;
    clear.disabled = filters.every(filter => filter.enabled === false) && groups.every(group => group.selected === undefined);
  };
  const groupList = el("div", "filter-group-list"), groupForm = el("div");
  const renderGroups = (): void => {
    groupList.replaceChildren(...groups.map((group, index) => {
      const row = el("div", "active-table-filter");
      row.append(button(group.name, () => editGroup(index), "filter-condition"),
        iconButton(`Delete filter group ${group.name}`, "trash", () => {groups.splice(index, 1); renderGroups(); updateClear(); publish();}));
      row.querySelector("button")!.setAttribute("aria-label", `Edit filter group ${group.name}`);
      row.querySelector("button")!.title = columns.find(column => column.id === group.path)?.label ?? group.path;
      return row;
    }));
    addGroup.disabled = groups.length >= filterGroupLimit || filters.length + groups.length >= 32;
  };
  const editGroup = (index?: number): void => {
    addGroup.hidden = true; groupList.hidden = true;
    const finish = (): void => {groupForm.replaceChildren(); addGroup.hidden = false; groupList.hidden = false; addGroup.focus();};
    groupForm.replaceChildren(filterGroupEditor(columns, index === undefined ? undefined : groups[index], (group: TableFilterGroup) => {
      if (index === undefined) groups.push(group); else groups[index] = group;
      finish(); renderGroups(); updateClear(); publish();
    }, finish));
    groupForm.querySelector("input")?.focus();
  };
  const addGroup = button("Add filter group", () => editGroup(), "button quiet");
  groupSection.append(groupList, addGroup, groupForm);
  modal.node.querySelector(".dialog-header > .icon-button")!.before(clear);
  value.addEventListener("input", updateSubmit);
  column.addEventListener("change", updateSubmit);
  operation.addEventListener("change", updateSubmit);
  conditions.append(list, criteria, entry, error);
  modal.body.append(tabs, conditions, groupSection);
  renderFilters(); renderGroups(); updateSubmit();
  return modal;
}
