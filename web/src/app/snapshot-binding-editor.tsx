import {type ReactNode} from "react";
import {ChevronDown} from "lucide-react";
import {Popover, Tabs} from "radix-ui";
import {Button} from "@/components/ui/button";
import {Checkbox} from "@/components/ui/checkbox";
import type {SnapshotBarView, SnapshotStatusView, SnapshotView} from "../domain/snapshot-views";
import type {TableColumn, TableDefinition} from "../domain/tables";
import {numericSnapshotFields, statusLayoutLimits, unsetSnapshotField} from "./snapshot-config";
export {snapshotBindingError} from "./snapshot-config";
import {SelectControl} from "./react-ui";

export function BindingField({label, children}: {label: string; children: ReactNode}) {
  return <label className="field"><span className="field-label">{label}</span>{children}</label>;
}

export function BindingSelect({label, value, options, onChange, disabled = false}: {
  label: string; value: string; options: readonly (readonly [string, string])[];
  onChange: (value: string) => void; disabled?: boolean;
}) {
  return <SelectControl label={label} value={value} options={options} disabled={disabled} onChange={onChange} />;
}

function FieldChoice({label, columns, value, onChange, optional = false}: {
  label: string; columns: TableColumn[]; value?: string | undefined; optional?: boolean; onChange: (value: string | undefined) => void;
}) {
  const options: [string, string][] = [[unsetSnapshotField, optional ? "None" : "Choose field"], ...columns.map(column => [column.path, column.name] as [string, string])];
  if (value !== undefined && value !== unsetSnapshotField && !options.some(([path]) => path === value)) options.push([value, `${value || "Row"} (not recorded)`]);
  return <BindingField label={label}><BindingSelect label={label} options={options} value={value ?? unsetSnapshotField}
    onChange={path => onChange(path === unsetSnapshotField ? undefined : path)} /></BindingField>;
}

function FieldSet({label, columns, values, limit, onChange}: {
  label: string; columns: TableColumn[]; values: string[]; limit: number; onChange: (values: string[]) => void;
}) {
  const available = [...columns, ...values.filter(path => !columns.some(column => column.path === path))
    .map(path => ({path, name: `${path || "Row"} (not recorded)`}))];
  return <div className="field snapshot-field-set"><span className="field-label">{label}</span>
    <Popover.Root><div className="snapshot-field-picker">
      <Popover.Trigger asChild><Button type="button" variant="ghost" className="select w-full justify-between" aria-label={`${label} fields`}>
        <span className="min-w-0 truncate">{values.length ? values.map(path => available.find(column => column.path === path)?.name ?? path).join(" + ") : "Choose fields"}</span><ChevronDown aria-hidden="true" size={14} />
      </Button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="react-popover snapshot-field-choices" align="start" sideOffset={4}
        aria-label={`${label} fields`} style={{width: "var(--radix-popover-trigger-width)", minWidth: 200, maxWidth: "calc(100vw - 32px)"}}>
        {available.map(column => <label key={column.path}>
          <Checkbox className="size-4 shrink-0" data-path={column.path} aria-label={`${label} field ${column.name}`} checked={values.includes(column.path)}
            disabled={!values.includes(column.path) && values.length >= limit}
            onCheckedChange={checked => onChange(checked === true ? [...values, column.path] : values.filter(path => path !== column.path))} />
          <span>{column.name}</span>
        </label>)}
      </Popover.Content></Popover.Portal>
    </div></Popover.Root>
  </div>;
}

export function SnapshotViewTabs({type, onChange}: {type: "table" | SnapshotView["type"]; onChange: (type: "table" | SnapshotView["type"]) => void}) {
  return <Tabs.Root value={type} onValueChange={value => {
    if (value === "table" || value === "bar" || value === "status-grid") onChange(value);
  }}><Tabs.List className="snapshot-view-tabs" aria-label="Snapshot view">
    <Tabs.Trigger value="table" className="snapshot-view-tab">Table</Tabs.Trigger>
    <Tabs.Trigger value="bar" className="snapshot-view-tab">Bar</Tabs.Trigger>
    <Tabs.Trigger value="status-grid" className="snapshot-view-tab">Status</Tabs.Trigger>
  </Tabs.List></Tabs.Root>;
}

export interface StatusDisplayControlsProps {
  view: SnapshotStatusView;
  columns: TableColumn[];
  onChange: (view: SnapshotStatusView) => void;
}

export function StatusDisplayControls({view, columns, onChange}: StatusDisplayControlsProps) {
  const scalars = columns.filter(column => !column.kinds?.length || column.kinds.some(kind => kind !== "array" && kind !== "object"));
  const orderChoices: [string, string][] = [[unsetSnapshotField, "Stable identity"], ...scalars.map(column => [column.path, column.name] as [string, string])];
  if (view.sort && !orderChoices.some(([path]) => path === view.sort!.path)) orderChoices.push([view.sort.path, `${view.sort.path || "Row"} (not recorded)`]);
  return <div className="snapshot-status-controls">
    <BindingField label="Sort by"><BindingSelect label="Sort by" value={view.sort?.path ?? unsetSnapshotField} options={orderChoices} onChange={path => {
      const next = {...view}; if (path === unsetSnapshotField) delete next.sort; else next.sort = {path, direction: view.sort?.direction ?? "asc"}; onChange(next);
    }} /></BindingField>
    <BindingField label="Direction"><BindingSelect label="Sort direction" disabled={!view.sort} value={view.sort?.direction ?? "asc"}
      options={[["asc", "Ascending"], ["desc", "Descending"]]} onChange={direction => {
        if (view.sort && (direction === "asc" || direction === "desc")) onChange({...view, sort: {...view.sort, direction}});
      }} /></BindingField>
    <FieldChoice label="Shade by" columns={numericSnapshotFields(columns)} value={view.shadePath} optional onChange={shadePath => {
      const next = {...view}; if (shadePath === undefined) delete next.shadePath; else next.shadePath = shadePath; onChange(next);
    }} />
    <BindingField label="Scale"><BindingSelect label="Shade scale" disabled={view.shadePath === undefined} value={view.shadeScale ?? "log"}
      options={[["log", "Logarithmic"], ["linear", "Linear"]]} onChange={shadeScale => {
        if (shadeScale === "linear" || shadeScale === "log") onChange({...view, shadeScale});
      }} /></BindingField>
    {(["columns", "cellSize", "gap"] as const).map(key => {
      const label = key === "cellSize" ? "Cell size" : key === "columns" ? "Columns" : "Gap";
      const [min, max] = statusLayoutLimits[key];
      const options: [string, string][] = Array.from({length: max - min + 1}, (_, index) => [String(min + index), `${min + index}${key === "columns" ? "" : " px"}`]);
      if (key === "columns") options.unshift(["", "Auto"]);
      return <BindingField key={key} label={label}><BindingSelect label={label} options={options}
        value={String(view[key] ?? (key === "columns" ? "" : key === "gap" ? 5 : view.density === "compact" ? 15 : 23))}
        onChange={value => {const next = {...view}; if (value === "") delete next[key]; else next[key] = Number(value); onChange(next);}} /></BindingField>;
    })}
    <BindingField label="Density"><BindingSelect label="Density" value={view.density} options={[["comfortable", "Comfortable"], ["compact", "Compact"]]}
      onChange={density => {if (density === "comfortable" || density === "compact") onChange({...view, density});}} /></BindingField>
  </div>;
}

export function SnapshotBindingEditor({table, view, onChange}: {table: TableDefinition | null; view: SnapshotView; onChange: (view: SnapshotView) => void}) {
  const columns = table?.columns ?? [];
  const scalars = columns.filter(column => !column.kinds?.length || column.kinds.some(kind => kind !== "array" && kind !== "object"));
  if (view.type === "bar") {
    const change = (patch: Partial<SnapshotBarView>) => onChange({...view, ...patch});
    return <div className="snapshot-binding-fields">
      <FieldChoice label="Category" columns={scalars} value={view.categoryPath} onChange={categoryPath => change({categoryPath: categoryPath ?? unsetSnapshotField})} />
      <BindingField label="Aggregation"><BindingSelect label="Aggregation" value={view.aggregation}
        options={[["sum", "Sum"], ["count", "Count"], ["min", "Minimum"], ["max", "Maximum"]]}
        onChange={aggregation => {if (aggregation === "sum" || aggregation === "count" || aggregation === "min" || aggregation === "max") change({aggregation});}} /></BindingField>
      {view.aggregation !== "count" && <FieldSet label="Values" columns={numericSnapshotFields(columns)} values={view.valuePaths} limit={8} onChange={valuePaths => change({valuePaths})} />}
      <BindingField label="Orientation"><BindingSelect label="Orientation" value={view.orientation} options={[["horizontal", "Horizontal"], ["vertical", "Vertical"]]}
        onChange={orientation => {if (orientation === "horizontal" || orientation === "vertical") change({orientation});}} /></BindingField>
      <BindingField label="Arrangement"><BindingSelect label="Arrangement" value={view.layout} options={[["grouped", "Grouped"], ["stacked", "Stacked"]]}
        onChange={layout => {if (layout === "grouped" || layout === "stacked") change({layout});}} /></BindingField>
      <BindingField label="Order"><BindingSelect label="Order" value={view.order} options={[["value-desc", "Largest first"], ["value-asc", "Smallest first"], ["label", "Category"]]}
        onChange={order => {if (order === "value-desc" || order === "value-asc" || order === "label") change({order});}} /></BindingField>
      <BindingField label="Categories"><input className="text-input" type="number" min="1" max="50" step="1" aria-label="Categories" value={Number.isNaN(view.limit) ? "" : view.limit}
        onChange={event => change({limit: event.target.value === "" ? NaN : Number(event.target.value)})} /></BindingField>
      <BindingField label="Decimals"><BindingSelect label="Decimals" value={String(view.decimals ?? "")}
        options={[["", "Auto"], ...Array.from({length: 21}, (_, index): [string, string] => [String(index), String(index)])]}
        onChange={value => {const next = {...view}; if (value === "") delete next.decimals; else next.decimals = Number(value); onChange(next);}} /></BindingField>
      <BindingField label="Unit"><input className="text-input" maxLength={40} aria-label="Unit" placeholder="Optional" value={view.unit ?? ""} onChange={event => {
        const next = {...view}; if (event.target.value) next.unit = event.target.value; else delete next.unit; onChange(next);
      }} /></BindingField>
    </div>;
  }
  const change = (patch: Partial<SnapshotStatusView>) => onChange({...view, ...patch});
  const identity = scalars.filter(column => column.path !== "$key" || table?.collection_kinds?.every(kind => kind === "object") === true);
  return <div className="snapshot-binding-fields">
    <FieldSet label="Identity" columns={identity} values={view.idPaths} limit={4} onChange={idPaths => change({idPaths})} />
    <FieldChoice label="Status field" columns={scalars} value={view.statusPath} onChange={statusPath => change({statusPath: statusPath ?? unsetSnapshotField})} />
    {([["Label", "labelPath", scalars], ["Group", "groupPath", scalars], ["Value", "valuePath", numericSnapshotFields(columns)]] as const).map(([label, key, choices]) =>
      <FieldChoice key={key} label={label} columns={choices} value={view[key]} optional onChange={path => {
        const next = {...view}; if (path === undefined) delete next[key]; else next[key] = path; onChange(next);
      }} />)}
    <StatusDisplayControls view={view} columns={columns} onChange={onChange} />
  </div>;
}
