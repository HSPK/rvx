import type {SnapshotBarView, SnapshotStatusView, SnapshotView} from "../domain/snapshot-views";
import type {TableColumn, TableDefinition} from "../domain/tables";
import {copySnapshotView, numericSnapshotFields, snapshotViewError, suggestSnapshotViews, unsetSnapshotField} from "./snapshot-config";
import {statusDisplayControls} from "./status-display-controls";
import {button, el, field, select} from "./ui";

type ViewType = "table" | SnapshotView["type"];

/** Own only visual field bindings; collection selection, data reads and panel persistence remain outside. */
export class SnapshotBindings {
  readonly tabs = el("div", "snapshot-view-tabs");
  readonly element = el("div", "snapshot-binding-fields");
  private buttons = new Map<ViewType, HTMLButtonElement>();
  private table: TableDefinition | null = null;
  private initialized = false;
  private type: ViewType;
  private bar: SnapshotBarView;
  private status: SnapshotStatusView;
  private initial?: SnapshotView;

  /** Present one view selector without adding more top-level Add types. */
  constructor(private changed: () => void, initial?: SnapshotView) {
    const defaults = suggestSnapshotViews(null);
    this.bar = defaults.bar; this.status = defaults.status; this.type = initial?.type ?? "table";
    if (initial) {this.initial = copySnapshotView(initial); this.accept(initial);}
    this.tabs.setAttribute("role", "tablist"); this.tabs.setAttribute("aria-label", "Snapshot view");
    for (const [type, label] of [["table", "Table"], ["bar", "Bar"], ["status-grid", "Status"]] as const) {
      const tab = button(label, () => {
        if (this.type === type) return;
        this.type = type; this.render(); this.changed();
      }, "snapshot-view-tab");
      tab.setAttribute("role", "tab"); this.buttons.set(type, tab); this.tabs.append(tab);
    }
    this.tabs.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = [...this.buttons.values()], index = tabs.findIndex(tab => tab === event.target);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
      tabs[next]!.focus(); tabs[next]!.click();
    });
    this.render();
  }

  /** Recommend fields only on a new collection, preserving explicit settings while discovery refreshes. */
  setCollection(table: TableDefinition | null): void {
    const changed = !this.initialized || table?.path !== this.table?.path;
    this.table = table;
    if (changed) {
      const defaults = suggestSnapshotViews(table);
      this.bar = defaults.bar; this.status = defaults.status;
      if (!this.initialized && this.initial) this.accept(this.initial);
      this.initialized = true;
    }
    this.render();
  }

  /** Keep renderer-driven palette changes without rebuilding focused field controls. */
  accept(view: SnapshotView): void {
    if (view.type === "bar") this.bar = {...view, valuePaths: [...view.valuePaths]};
    else this.status = {...view, idPaths: [...view.idPaths], ...(view.sort ? {sort: {...view.sort}} : {}), ...(view.colors ? {colors: {...view.colors}} : {})};
  }

  /** Return a detached wire configuration; table is the existing no-view representation. */
  get value(): SnapshotView | undefined {
    if (this.type === "table") return undefined;
    return this.type === "bar" ? {...this.bar, valuePaths: this.bar.aggregation === "count" ? [] : [...this.bar.valuePaths]}
      : copySnapshotView(this.status);
  }

  /** Catch incomplete mappings before a preview request can fail or an unsavable panel is committed. */
  get error(): string {
    const view = this.value;
    if (!view) return "";
    if (view.type === "status-grid" && view.idPaths.includes("$key") && this.table?.collection_kinds?.includes("array")) {
      return "Choose stable task fields; array positions are not task identities.";
    }
    return snapshotViewError(view);
  }

  /** Build accessible native field selectors, retaining missing saved fields for explicit correction. */
  private fieldChoice(label: string, columns: TableColumn[], value: string | undefined, changed: (value: string | undefined) => void, optional = false): HTMLElement {
    const options: [string, string][] = [[unsetSnapshotField, optional ? "None" : "Choose field"],
      ...columns.map(column => [column.path, column.name] as [string, string])];
    if (value !== undefined && value !== unsetSnapshotField && !options.some(([path]) => path === value)) options.push([value, `${value || "Row"} (not recorded)`]);
    return field(label, select(label, options, value ?? unsetSnapshotField, value => {changed(value === unsetSnapshotField ? undefined : value); this.changed();}));
  }

  /** Use one compact checkbox picker for multiple measures or compound identity fields. */
  private fieldSet(label: string, columns: TableColumn[], values: string[], limit: number, changed: (values: string[]) => void): HTMLElement {
    const wrapper = el("div", "field snapshot-field-set"), details = el("details", "snapshot-field-picker");
    const summary = el("summary"), choices = el("div", "snapshot-field-choices");
    wrapper.append(el("span", "field-label", label), details); details.append(summary, choices);
    const selected = new Set(values);
    const available = [...columns, ...values.filter(path => !columns.some(column => column.path === path))
      .map(path => ({path, name: `${path || "Row"} (not recorded)`}))];
    const update = (): void => {
      summary.textContent = selected.size ? [...selected].map(path => available.find(column => column.path === path)?.name ?? path).join(" + ") : "Choose fields";
      for (const check of choices.querySelectorAll<HTMLInputElement>("input")) check.disabled = !check.checked && selected.size >= limit;
    };
    for (const column of available) {
      const row = el("label"), check = el("input");
      check.type = "checkbox"; check.checked = selected.has(column.path); check.dataset.path = column.path;
      check.setAttribute("aria-label", `${label} field ${column.name}`);
      check.addEventListener("change", () => {
        check.checked ? selected.add(column.path) : selected.delete(column.path);
        update(); changed([...selected]); this.changed();
      });
      row.append(check, el("span", "", column.name)); choices.append(row);
    }
    update(); return wrapper;
  }

  /** Rebuild controls only for view or collection changes, not during numeric typing or data refresh. */
  private render(): void {
    for (const [type, button] of this.buttons) {
      button.setAttribute("aria-selected", String(type === this.type)); button.tabIndex = type === this.type ? 0 : -1;
    }
    this.element.replaceChildren(); this.element.hidden = this.type === "table";
    if (this.type === "table") return;
    const columns = this.table?.columns ?? [];
    const scalars = columns.filter(column => !column.kinds?.length || column.kinds.some(kind => kind !== "array" && kind !== "object"));
    if (this.type === "bar") {
      this.element.append(this.fieldChoice("Category", scalars, this.bar.categoryPath, value => {this.bar.categoryPath = value ?? unsetSnapshotField;}));
      this.element.append(field("Aggregation", select("Aggregation", [["sum", "Sum"], ["count", "Count"], ["min", "Minimum"], ["max", "Maximum"]],
        this.bar.aggregation, value => {
          if (value === "sum" || value === "count" || value === "min" || value === "max") this.bar.aggregation = value;
          this.render(); this.changed();
        })));
      if (this.bar.aggregation !== "count") this.element.append(this.fieldSet("Values", numericSnapshotFields(columns), this.bar.valuePaths, 8, values => {this.bar.valuePaths = values;}));
      this.element.append(field("Orientation", select("Orientation", [["horizontal", "Horizontal"], ["vertical", "Vertical"]], this.bar.orientation,
        value => {if (value === "horizontal" || value === "vertical") this.bar.orientation = value; this.changed();})));
      this.element.append(field("Arrangement", select("Arrangement", [["grouped", "Grouped"], ["stacked", "Stacked"]], this.bar.layout,
        value => {if (value === "grouped" || value === "stacked") this.bar.layout = value; this.changed();})));
      this.element.append(field("Order", select("Order", [["value-desc", "Largest first"], ["value-asc", "Smallest first"], ["label", "Category"]],
        this.bar.order, value => {if (value === "value-desc" || value === "value-asc" || value === "label") this.bar.order = value; this.changed();})));
      const limit = el("input", "text-input"); limit.type = "number"; limit.min = "1"; limit.max = "50"; limit.step = "1"; limit.value = String(this.bar.limit);
      limit.setAttribute("aria-label", "Categories");
      limit.addEventListener("input", () => {this.bar.limit = Number(limit.value); this.changed();});
      this.element.append(field("Categories", limit));
      this.element.append(field("Decimals", select("Decimals", [["", "Auto"], ...Array.from({length: 21}, (_, index): [string, string] => [String(index), String(index)])],
        String(this.bar.decimals ?? ""), value => {if (value === "") delete this.bar.decimals; else this.bar.decimals = Number(value); this.changed();})));
      const unit = el("input", "text-input"); unit.maxLength = 40; unit.value = this.bar.unit ?? ""; unit.placeholder = "Optional";
      unit.setAttribute("aria-label", "Unit");
      unit.addEventListener("input", () => {if (unit.value.trim()) this.bar.unit = unit.value.trim(); else delete this.bar.unit; this.changed();});
      this.element.append(field("Unit", unit));
    } else {
      const identity = scalars.filter(column => column.path !== "$key" || this.table?.collection_kinds?.every(kind => kind === "object") === true);
      this.element.append(this.fieldSet("Identity", identity, this.status.idPaths, 4, values => {this.status.idPaths = values;}));
      this.element.append(this.fieldChoice("Status field", scalars, this.status.statusPath, value => {this.status.statusPath = value ?? unsetSnapshotField;}));
      for (const [label, key, choices] of [["Label", "labelPath", scalars], ["Group", "groupPath", scalars], ["Value", "valuePath", numericSnapshotFields(columns)]] as const) {
        this.element.append(this.fieldChoice(label, choices, this.status[key], value => {
          if (value === undefined) delete this.status[key]; else this.status[key] = value;
        }, true));
      }
      this.element.append(statusDisplayControls(() => this.status, columns, view => {this.status = view; this.changed();}));
    }
  }
}
