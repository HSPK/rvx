import type {TableFilterPreference} from "./panels";
import {button, dialog, el, field, select} from "./ui";

export interface FilterColumn {id: string; label: string; filterable?: boolean}

/** Edit copied reusable conditions for tables and snapshot visualizations without deleting disabled rules. */
export function openTableFilters(columns: FilterColumn[], input: TableFilterPreference[],
  changed: (filters: TableFilterPreference[]) => void, closed?: () => void): ReturnType<typeof dialog> {
  const filters = input.map(filter => ({...filter}));
  const modal = dialog("Filter rows", "", closed);
  const column = select("Filter column", columns.filter(column => column.filterable !== false).map(column => [column.id, column.label]), "", () => {});
  column.selectedIndex = 0;
  const operation = select("Filter operation", [["contains", "Contains"], ["eq", "Equals"], ["gt", "Greater than"], ["lt", "Less than"]], "contains", () => {});
  const value = el("input", "text-input"); value.setAttribute("aria-label", "Filter value"); value.placeholder = "Value";
  const error = el("p", "error-text"); error.setAttribute("role", "alert");
  const publish = (): void => changed(filters.map(filter => ({...filter})));
  let editing: number | null = null;
  for (const [index, filter] of filters.entries()) {
    const row = el("div", "active-table-filter");
    const enabled = el("input"); enabled.type = "checkbox"; enabled.checked = filter.enabled !== false;
    enabled.setAttribute("aria-label", `Enable filter ${index + 1}`);
    enabled.addEventListener("change", () => {
      filter.enabled = enabled.checked; clear.disabled = filters.every(filter => filter.enabled === false); publish();
    });
    const operators = {contains: "contains", eq: "=", gt: ">", lt: "<"};
    const edit = button(`${columns.find(column => column.id === filter.path)?.label ?? filter.path} ${operators[filter.op]} ${filter.value}`, () => {
      editing = index; column.value = filter.path; operation.value = filter.op; value.value = filter.value;
      submit.querySelector("span")!.textContent = "Update filter"; value.focus();
    }, "filter-condition");
    edit.setAttribute("aria-label", `Edit filter ${index + 1}`);
    row.append(enabled, edit); modal.body.append(row);
  }
  const criteria = el("div", "filter-criteria"), entry = el("div", "filter-entry");
  criteria.append(field("Column", column), field("Condition", operation));
  const submit = button("Add filter", () => {
    if (editing === null && filters.length >= 32) {error.textContent = "Use at most 32 column filters."; return;}
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
  entry.append(value, submit);
  const clear = button("Disable all", () => {
    for (const filter of filters) filter.enabled = false;
    modal.close(); publish();
  }, "text-button");
  clear.hidden = !filters.length; clear.disabled = filters.every(filter => filter.enabled === false);
  modal.node.querySelector(".dialog-header > .icon-button")!.before(clear);
  modal.body.append(criteria, entry, error);
  return modal;
}
