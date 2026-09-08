import type {SnapshotStatusView} from "../domain/snapshot-views";
import type {TableColumn} from "../domain/tables";
import {numericSnapshotFields, statusLayoutLimits, unsetSnapshotField} from "./snapshot-config";
import {el, field, select} from "./ui";

/** Share compact, valid-only sorting and geometry controls between the editor and live panel. */
export function statusDisplayControls(read: () => SnapshotStatusView, columns: TableColumn[], changed: (view: SnapshotStatusView) => void): HTMLElement {
  const element = el("div", "snapshot-status-controls"), view = read();
  const choices: [string, string][] = [[unsetSnapshotField, "Stable identity"],
    ...columns.filter(column => !column.kinds?.length || column.kinds.some(kind => kind !== "array" && kind !== "object"))
      .map(column => [column.path, column.name] as [string, string])];
  if (view.sort && !choices.some(([path]) => path === view.sort!.path)) choices.push([view.sort.path, `${view.sort.path || "Row"} (not recorded)`]);
  const direction = select("Sort direction", [["asc", "Ascending"], ["desc", "Descending"]], view.sort?.direction ?? "asc", value => {
    const current = read();
    if (current.sort && (value === "asc" || value === "desc")) changed({...current, sort: {...current.sort, direction: value}});
  });
  direction.disabled = !view.sort;
  const order = select("Sort by", choices, view.sort?.path ?? unsetSnapshotField, path => {
    const next = {...read()};
    if (path === unsetSnapshotField) delete next.sort;
    else next.sort = {path, direction: next.sort?.direction ?? "asc"};
    direction.disabled = !next.sort; direction.value = next.sort?.direction ?? "asc";
    changed(next);
  });
  element.append(field("Sort by", order), field("Direction", direction));
  const shades: [string, string][] = [[unsetSnapshotField, "None"],
    ...numericSnapshotFields(columns).map(column => [column.path, column.name] as [string, string])];
  if (view.shadePath !== undefined && !shades.some(([path]) => path === view.shadePath)) shades.push([view.shadePath, `${view.shadePath || "Row"} (not recorded)`]);
  const scale = select("Shade scale", [["log", "Logarithmic"], ["linear", "Linear"]], view.shadeScale ?? "log", value => {
    if (value === "linear" || value === "log") changed({...read(), shadeScale: value});
  });
  scale.disabled = view.shadePath === undefined;
  element.append(field("Shade by", select("Shade by", shades, view.shadePath ?? unsetSnapshotField, path => {
    const next = {...read()};
    if (path === unsetSnapshotField) delete next.shadePath; else next.shadePath = path;
    scale.disabled = next.shadePath === undefined;
    changed(next);
  })), field("Scale", scale));
  for (const [key, label, defaultValue] of [
    ["columns", "Columns", ""],
    ["cellSize", "Cell size", view.density === "compact" ? 15 : 23],
    ["gap", "Gap", 5],
  ] as const) {
    const [min, max] = statusLayoutLimits[key];
    const options: [string, string][] = Array.from({length: max - min + 1}, (_, index): [string, string] =>
      [String(min + index), `${min + index}${key === "columns" ? "" : " px"}`]);
    if (key === "columns") options.unshift(["", "Auto"]);
    element.append(field(label, select(label, options, String(view[key] ?? defaultValue), value => {
      const next = {...read()};
      if (value === "") delete next[key]; else next[key] = Number(value);
      changed(next);
    })));
  }
  return element;
}
