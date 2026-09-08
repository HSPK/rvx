import {isRecord} from "./model";
import type {SnapshotBarView, SnapshotStatusView, SnapshotView} from "../domain/snapshot-views";
import type {TableColumn, TableDefinition} from "../domain/tables";

const bytes = new TextEncoder();
export const unsetSnapshotField = "__choose_snapshot_field__";
export const statusLayoutLimits = {columns: [1, 64], cellSize: [12, 40], gap: [2, 12]} as const;

/** Preserve exact field pointers, including root and the native key/value pseudo-columns. */
export function snapshotFieldPath(value: unknown): value is string {
  return typeof value === "string" && bytes.encode(value).length <= 4096 && !value.includes("\0")
    && (value === "" || value === "$key" || value === "$value" || value.startsWith("/"))
    && !/~(?:[^01]|$)/.test(value);
}
/** Copy visual mappings without sharing nested editor state with a saved workspace. */
export function copySnapshotView(view: SnapshotView): SnapshotView {
  return view.type === "bar" ? {...view, valuePaths: [...view.valuePaths]}
    : {...view, idPaths: [...view.idPaths], ...(view.sort ? {sort: {...view.sort}} : {}), ...(view.colors ? {colors: {...view.colors}} : {})};
}
/** Validate the supported view configuration rather than accepting arbitrary chart-library options. */
export function validSnapshotView(value: unknown): value is SnapshotView {
  if (!isRecord(value)) return false;
  if (value.type === "bar") {
    const allowed = ["type", "categoryPath", "valuePaths", "aggregation", "orientation", "layout", "order", "limit", "decimals", "unit"];
    return Object.keys(value).every(key => allowed.includes(key)) && snapshotFieldPath(value.categoryPath)
      && Array.isArray(value.valuePaths) && value.valuePaths.every(snapshotFieldPath)
      && new Set(value.valuePaths).size === value.valuePaths.length
      && (value.aggregation === "count" ? value.valuePaths.length === 0 : value.valuePaths.length > 0 && value.valuePaths.length <= 8)
      && typeof value.aggregation === "string" && ["count", "sum", "min", "max"].includes(value.aggregation)
      && typeof value.orientation === "string" && ["horizontal", "vertical"].includes(value.orientation)
      && typeof value.layout === "string" && ["grouped", "stacked"].includes(value.layout)
      && typeof value.order === "string" && ["value-desc", "value-asc", "label"].includes(value.order)
      && typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 50
      && (value.decimals === undefined || typeof value.decimals === "number" && Number.isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 20)
      && (value.unit === undefined || typeof value.unit === "string" && [...value.unit].length <= 40 && !value.unit.includes("\0"));
  }
  if (value.type === "status-grid") {
    const allowed = ["type", "idPaths", "statusPath", "labelPath", "groupPath", "valuePath", "shadePath", "shadeScale", "density", "colors", "sort", "columns", "cellSize", "gap"];
    return Object.keys(value).every(key => allowed.includes(key)) && snapshotFieldPath(value.statusPath)
      && Array.isArray(value.idPaths) && value.idPaths.length > 0 && value.idPaths.length <= 4
      && value.idPaths.every(snapshotFieldPath) && new Set(value.idPaths).size === value.idPaths.length
      && ["labelPath", "groupPath", "valuePath", "shadePath"].every(key => value[key] === undefined || snapshotFieldPath(value[key]))
      && (value.shadeScale === undefined || value.shadeScale === "linear" || value.shadeScale === "log")
      && typeof value.density === "string" && ["comfortable", "compact"].includes(value.density)
      && (value.sort === undefined || isRecord(value.sort) && Object.keys(value.sort).every(key => key === "path" || key === "direction")
        && snapshotFieldPath(value.sort.path) && (value.sort.direction === "asc" || value.sort.direction === "desc"))
      && Object.entries(statusLayoutLimits).every(([key, [min, max]]) => value[key] === undefined
        || typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] >= min && value[key] <= max)
      && (value.colors === undefined || isRecord(value.colors) && Object.keys(value.colors).length <= 128
        && Object.entries(value.colors).every(([state, color]) => bytes.encode(state).length <= 256 && !state.includes("\0")
          && typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)));
  }
  return false;
}
/** Explain invalid bindings before issuing a visualization query or saving a draft. */
export function snapshotViewError(view: SnapshotView): string {
  if (view.type === "bar") {
    if (!snapshotFieldPath(view.categoryPath)) return "Choose a category field.";
    if (view.aggregation !== "count" && !view.valuePaths.length) return "Choose at least one numeric value field.";
    if (view.valuePaths.length > 8) return "Choose at most 8 value fields.";
    if (!Number.isInteger(view.limit) || view.limit < 1 || view.limit > 50) return "Show between 1 and 50 categories.";
  } else {
    if (!view.idPaths.length) return "Choose stable identity fields for the tasks.";
    if (view.idPaths.length > 4) return "Choose at most 4 identity fields.";
    if (!snapshotFieldPath(view.statusPath)) return "Choose a status field.";
    if (view.sort && !snapshotFieldPath(view.sort.path)) return "Choose a valid task sorting field.";
    for (const key of ["columns", "cellSize", "gap"] as const) {
      const [min, max] = statusLayoutLimits[key], value = view[key];
      if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) return `Choose ${key === "cellSize" ? "cell size" : key} between ${min} and ${max}.`;
    }
  }
  return validSnapshotView(view) ? "" : "Choose valid snapshot display settings.";
}
/** Field types are bounded discovery hints; unknown columns remain selectable for explicit binding. */
export function numericSnapshotFields(columns: TableColumn[]): TableColumn[] {
  return columns.filter(column => column.path !== "$key" && (!column.kinds?.length || column.kinds.includes("number")));
}
/** Prefer declared scalar names without pretending a sample proves identity or numeric validity. */
export function suggestSnapshotViews(table: TableDefinition | null): {bar: SnapshotBarView; status: SnapshotStatusView} {
  const columns = table?.columns ?? [], paths = new Set(columns.map(column => column.path));
  const choose = (names: string[]): string | undefined => names.find(name => paths.has(name));
  const numbers = columns.filter(column => column.kinds?.includes("number"));
  const categoricalValue = columns.find(column => column.path === "$value" && column.kinds?.some(kind => kind === "string" || kind === "boolean"));
  const category = choose(["/name", "/queue", "/label", "/status"]) ?? categoricalValue?.path ?? choose(["$key"]) ?? columns[0]?.path ?? unsetSnapshotField;
  const value = ["/running_gpus", "/allocated_gpus", "/value", "$value"].find(path => numbers.some(column => column.path === path)) ?? numbers[0]?.path;
  const unique = choose(["/task_id", "/uid", "/id"]);
  const composite = ["/queue", "/name", "/submitter", "/creator_id"].filter(path => paths.has(path));
  const objectMap = table?.collection_kinds?.length === 1 && table.collection_kinds[0] === "object";
  const idPaths = unique ? [unique] : composite.includes("/name") ? composite : objectMap ? ["$key"] : [];
  const labelPath = choose(["/name", "/label", "/task_id", "/uid", "/id"]);
  const groupPath = choose(["/queue", "/role", "/group"]);
  return {
    bar: {type: "bar", categoryPath: category, valuePaths: value ? [value] : [], aggregation: value ? "sum" : "count",
      orientation: "horizontal", layout: "grouped", order: "value-desc", limit: 20},
    status: {type: "status-grid", idPaths, statusPath: choose(["/status", "/state", "/phase"]) ?? unsetSnapshotField,
      ...(labelPath ? {labelPath} : {}), ...(groupPath ? {groupPath} : {}), ...(value ? {valuePath: value} : {}), density: "comfortable"},
  };
}
