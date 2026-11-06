import {Fragment, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode} from "react";
import {ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Filter, GripVertical, Plus, Settings2, Trash2} from "lucide-react";
import {RadioGroup} from "radix-ui";
import {Dialog, DialogContent, DialogDescription, DialogTitle} from "../components/ui/dialog";
import {Button} from "../components/ui/button";
import {Checkbox} from "../components/ui/checkbox";
import {Input} from "../components/ui/input";
import {Tabs, TabsContent, TabsList, TabsTrigger} from "../components/ui/tabs";
import {uiIdentifier} from "../core/identifiers";
import {activeTableFilters, copyFilterGroups, validFilterGroups, type ColumnPreference, type TableFilterGroup, type TableFilterPreference, type TableQueryPreference} from "./panels";
import {missingCell, pageCsv, type ViewColumn, type ViewRow} from "./data-table-model";
import {decimalDisplay} from "./decimal-display";
import {temporalCellText} from "./time";
import {IconButton, SelectControl} from "./react-ui";

export function RecordDialog({title, label, className = "", onClose, children, style, onEscapeKeyDown, hideTitle = false}: {
  title: string; label?: string; className?: string; onClose: () => void; children: ReactNode; style?: CSSProperties;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  hideTitle?: boolean;
}) {
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}>
    <DialogContent className={`dialog react-dialog ${className}`} {...(label ? {"aria-label": label, "aria-labelledby": undefined} : {})}
      onEscapeKeyDown={onEscapeKeyDown} onCloseAutoFocus={event => {
        event.preventDefault();
        if (returnFocus.current?.isConnected) returnFocus.current.focus({preventScroll: true});
      }} style={{display: "flex", flexDirection: "column", gap: 0, ...style}}>
      {hideTitle ? <DialogTitle hidden>{title}</DialogTitle>
        : <header className="dialog-header"><DialogTitle>{title}</DialogTitle></header>}
      <DialogDescription className="sr-only">{title}</DialogDescription>
      <div className="dialog-body">{children}</div>
    </DialogContent>
  </Dialog>;
}

export function FilterGroupControls({query, onChange}: {query: TableQueryPreference; onChange: (query: TableQueryPreference) => void}) {
  const instance = useId();
  return <div className="filter-group-toolbar" hidden={!query.filterGroups?.length}>{query.filterGroups?.map((group, index) => {
    const change = (value: string) => onChange({...query, filterGroups: copyFilterGroups(query.filterGroups).map(item => {
      if (item.id === group.id) {if (value === "") delete item.selected; else item.selected = value;}
      return item;
    })});
    return <Fragment key={group.id}>{index > 0 && <span className="filter-group-separator" aria-hidden="true">{"\uFF5C"}</span>}
    <div className="toolbar-filter-group" data-group-id={group.id}>
      {group.display === "select" ? <label className="field"><span className="field-label">{group.name}</span>
        <SelectControl label={group.name} value={group.selected ?? ""} onChange={change}
          options={[["", "All"], ...group.options.map(option => [option.value, option.label] as const)]} /></label> : <RadioGroup.Root aria-label={group.name} className="flex min-w-0 flex-wrap items-center gap-1"
            name={`${instance}-${group.id}`} value={group.selected ?? ""} onValueChange={change}>
        <span className="filter-group-label">{group.name}</span>{[{label: "All", value: ""}, ...group.options].map(option =>
          <RadioGroup.Item key={option.value} aria-label={option.label} value={option.value}
            className="filter-radio-option group min-w-0 rounded border-0 bg-transparent p-0 text-inherit outline-none">
            <span>{option.label}</span>
          </RadioGroup.Item>)}
      </RadioGroup.Root>}
    </div></Fragment>;
  })}</div>;
}

function GroupEditor({columns, initial, onSave, onCancel}: {
  columns: ViewColumn[]; initial: TableFilterGroup | null; onSave: (group: TableFilterGroup) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [path, setPath] = useState(initial?.path ?? columns.find(column => column.filterable !== false)?.id ?? "");
  const [display, setDisplay] = useState<"select" | "radio">(initial?.display ?? "select");
  const [options, setOptions] = useState(initial ? copyFilterGroups([initial])[0]!.options : [{label: "", value: ""}]);
  const [error, setError] = useState("");
  function save() {
    const group: TableFilterGroup = {id: initial?.id ?? uiIdentifier("filter-group"), name: name.trim(), path, display,
      options: options.map(option => ({label: option.label.trim() || option.value, value: option.value}))};
    if (initial?.selected !== undefined && group.options.some(option => option.value === initial.selected)) group.selected = initial.selected;
    if (!validFilterGroups([group])) {setError("Use a group name, unique nonempty values, up to 32 options, 120 characters per label and 4096 bytes per value."); return;}
    onSave(group);
  }
  return <div className="filter-group-editor">
    <label className="field">Group name<Input className="text-input" aria-label="Group name" placeholder="Group name" maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="filter-group-settings"><label className="field">Column<SelectControl label="Group column" value={path} onChange={setPath}
      options={columns.filter(column => column.filterable !== false).map(column => [column.id, column.label])} /></label>
      <label className="field">Display<SelectControl label="Group display" value={display} onChange={value => setDisplay(value === "radio" ? "radio" : "select")}
        options={[["select", "Dropdown"], ["radio", "Radio group"]]} /></label></div>
    <div className="filter-group-option-headings" aria-hidden="true"><span>Value</span><span>Label</span></div>
    <div className="filter-group-options">{options.map((option, index) => <div key={index} className="filter-group-option">
      <Input className="text-input" aria-label={`Option value ${index + 1}`} placeholder="Value" value={option.value}
        onChange={event => setOptions(options.map((item, position) => position === index ? {...item, value: event.target.value} : item))} />
      <Input className="text-input" aria-label={`Option label ${index + 1}`} maxLength={120} value={option.label}
        onChange={event => setOptions(options.map((item, position) => position === index ? {...item, label: event.target.value} : item))} />
      <IconButton label={`Delete option ${index + 1}`} onClick={() => setOptions(options.filter((_, position) => position !== index))}><Trash2 /></IconButton>
    </div>)}</div>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="filter-group-actions">
      <Button variant="outline" disabled={options.length >= 32} onClick={() => setOptions([...options, {label: "", value: ""}])}><Plus />Add option</Button>
      <Button variant="outline" aria-label="Cancel group" onClick={onCancel}>Cancel</Button><Button onClick={save}>Save group</Button>
    </div>
  </div>;
}

export function RecordFilters({columns, query, onChange, onClose}: {
  columns: ViewColumn[]; query: TableQueryPreference; onChange: (query: TableQueryPreference) => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<"conditions" | "groups">("conditions");
  const [editing, setEditing] = useState<number | null>(null);
  const [groupEditing, setGroupEditing] = useState<TableFilterGroup | null | undefined>();
  const [path, setPath] = useState(columns.find(column => column.filterable !== false)?.id ?? "");
  const [op, setOp] = useState<TableFilterPreference["op"]>("contains");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const filters = query.filters ?? [], groups = query.filterGroups ?? [];
  function submit() {
    if (!value.trim() || !columns.some(column => column.id === path && column.filterable !== false)) {setError("Choose a column and enter a filter value."); return;}
    if (value.includes("\0") || new TextEncoder().encode(value).length > 4096) {setError("Filter values must fit within 4096 UTF-8 bytes and contain no NUL."); return;}
    if (editing === null && filters.length + groups.length >= 32) {setError("Use at most 32 filters, including toolbar groups."); return;}
    const filter = {path, op, value};
    onChange({...query, filters: editing === null ? [...filters, filter] : filters.map((item, index) => index === editing ? {...item, ...filter} : item)});
    onClose();
  }
  return <RecordDialog title="Filter rows" className="table-filters-dialog" onClose={onClose}
    style={{width: "min(640px, calc(100vw - 32px))", maxWidth: "calc(100vw - 32px)"}}>
    <Tabs className="flex-col" value={tab} onValueChange={value => setTab(value === "groups" ? "groups" : "conditions")}>
    <TabsList className="filter-editor-tabs" aria-label="Filter editor">{(["conditions", "groups"] as const).map(item =>
      <TabsTrigger key={item} value={item} className="filter-editor-tab">{item === "conditions" ? "Conditions" : "Groups"}</TabsTrigger>)}</TabsList>
    <p className="muted">All enabled conditions and selected groups are combined with AND.</p>
    <TabsContent value="conditions" className="filter-editor-panel" forceMount hidden={tab !== "conditions"}>
      <div className="table-filter-list">{filters.map((filter, index) => <div key={index} className="active-table-filter">
        <Checkbox aria-label={`Enable filter ${index + 1}`} checked={filter.enabled !== false}
          onCheckedChange={checked => onChange({...query, filters: filters.map((item, position) => position === index ? {...item, enabled: checked === true} : item)})} />
        <button className="filter-condition" aria-label={`Edit filter ${index + 1}`} onClick={() => {setEditing(index); setPath(filter.path); setOp(filter.op); setValue(filter.value);}}>
          {columns.find(column => column.id === filter.path)?.label ?? filter.path} {({contains: "contains", eq: "=", gt: ">", lt: "<"})[filter.op]} {filter.value}
        </button>
        <IconButton label={`Delete filter ${index + 1}`} onClick={() => {
          onChange({...query, filters: filters.filter((_, position) => position !== index)});
          if (editing === index) {setEditing(null); setValue("");} else if (editing !== null && editing > index) setEditing(editing - 1);
        }}><Trash2 /></IconButton>
      </div>)}</div>
      <form onSubmit={event => {event.preventDefault(); submit();}}>
        <div className="filter-criteria">
          <label className="field">Column<SelectControl label="Filter column" value={path} onChange={setPath}
            options={columns.filter(column => column.filterable !== false).map(column => [column.id, column.label])} /></label>
          <label className="field">Operation<SelectControl label="Filter operation" value={op} onChange={value => setOp(value as TableFilterPreference["op"])}
            options={[["contains", "Contains"], ["eq", "Equals"], ["gt", "Greater than"], ["lt", "Less than"]]} /></label>
          <label className="field">Value<Input className="text-input" aria-label="Filter value" placeholder="Value" value={value} onChange={event => setValue(event.target.value)} /></label>
        </div><div className="filter-entry"><Button type="submit" disabled={!value.trim()}>{editing === null ? "Add filter" : "Update filter"}</Button></div>
      </form>
      {error && <p className="error-text" role="alert">{error}</p>}
    </TabsContent>
    <TabsContent value="groups" className="filter-editor-panel" forceMount hidden={tab !== "groups"}>
      {groupEditing !== undefined ? <GroupEditor key={groupEditing?.id ?? "new"} columns={columns} initial={groupEditing} onCancel={() => setGroupEditing(undefined)} onSave={group => {
        onChange({...query, filterGroups: groupEditing ? groups.map(item => item.id === group.id ? group : item) : [...groups, group]}); setGroupEditing(undefined);
      }} /> : <><div className="filter-group-list">{groups.map(group => <div key={group.id} className="active-table-filter">
        <button className="filter-condition" aria-label={`Edit filter group ${group.name}`} onClick={() => setGroupEditing(group)}>{group.name}</button>
        <IconButton label={`Delete filter group ${group.name}`} onClick={() => onChange({...query, filterGroups: groups.filter(item => item.id !== group.id)})}><Trash2 /></IconButton>
      </div>)}</div><Button variant="outline" disabled={groups.length >= 16 || groups.length + filters.length >= 32} onClick={() => setGroupEditing(null)}><Plus />Add filter group</Button></>}
    </TabsContent>
    </Tabs>
    <footer className="filter-dialog-actions"><Button variant="ghost" disabled={!activeTableFilters(query).length} onClick={() => {
      onChange({...query, filters: filters.map(filter => ({...filter, enabled: false})), filterGroups: copyFilterGroups(groups).map(group => {delete group.selected; return group;})}); onClose();
    }}>Disable all</Button><Button variant="ghost" onClick={onClose}>Done</Button></footer>
  </RecordDialog>;
}

export function RecordQueryToolbar({columns, query, onChange, visual = false, actions, showFilterCount = true}: {
  columns: ViewColumn[]; query: TableQueryPreference; onChange: (query: TableQueryPreference) => void; visual?: boolean; actions?: ReactNode; showFilterCount?: boolean;
}) {
  const [search, setSearch] = useState(query.search ?? ""), [filtersOpen, setFiltersOpen] = useState(false);
  const current = useRef(onChange); current.current = onChange;
  const queryRef = useRef(query); queryRef.current = query;
  useEffect(() => {setSearch(query.search ?? "");}, [query.search]);
  useEffect(() => {
    if (search === (queryRef.current.search ?? "")) return;
    const timeout = setTimeout(() => current.current({...queryRef.current, search}), 180);
    return () => clearTimeout(timeout);
  }, [search]);
  return <><div className={visual ? "sv-tools" : "table-tools"}>
    <Input type="search" className={`text-input ${visual ? "sv-search" : "table-search"}`} aria-label={visual ? "Search snapshot rows" : "Search table rows"}
      placeholder="Search…" value={search} onChange={event => setSearch(event.target.value)} />
    <FilterGroupControls query={query} onChange={onChange} />
    <div className="table-actions"><Button variant="ghost" className="button quiet" onClick={() => setFiltersOpen(true)}><Filter />{showFilterCount && activeTableFilters(query).length ? `Filter (${activeTableFilters(query).length})` : "Filter"}</Button>{actions}</div>
  </div>{filtersOpen && <RecordFilters columns={columns} query={query} onChange={onChange} onClose={() => setFiltersOpen(false)} />}</>;
}

export interface DataTableProps {
  columns: ViewColumn[]; rows: ViewRow[]; total: number; offset: number; limit: number; busy: boolean; loaded: boolean;
  preferences: ColumnPreference[]; query: TableQueryPreference;
  onQueryChange: (query: TableQueryPreference) => void; onColumnsChange: (columns: ColumnPreference[]) => void; onPage: (offset: number) => void;
  onRowDetails?: (row: ViewRow) => void;
}

export function DataTable({columns, rows, total, offset, limit, busy, loaded, preferences, query, onQueryChange, onColumnsChange, onPage, onRowDetails}: DataTableProps) {
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [announcement, setAnnouncement] = useState("");
  const drag = useRef<{id: string; x: number; initial: number; current: number} | null>(null);
  const reorder = useRef<{from: number; to: number | null; x: number; y: number; startX: number; startY: number; active: boolean} | null>(null);
  const columnList = useRef<HTMLDivElement>(null), reorderFrame = useRef(0);
  const [reorderIndicator, setReorderIndicator] = useState<{from: number; target: number; after: boolean} | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const [paintedRows, setPaintedRows] = useState(rows);
  const latestRows = useRef(rows); latestRows.current = rows;
  const scrolling = useRef(false), scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paint = () => {
    const selection = document.getSelection();
    const selecting = selection && !selection.isCollapsed && (body.current?.contains(selection.anchorNode) || body.current?.contains(selection.focusNode));
    if (!selecting && !scrolling.current && !drag.current) setPaintedRows(latestRows.current);
  };
  const paintRef = useRef(paint); paintRef.current = paint;
  useEffect(() => {paintRef.current();}, [rows]);
  useEffect(() => {
    const selected = () => paintRef.current();
    document.addEventListener("selectionchange", selected);
    return () => {document.removeEventListener("selectionchange", selected); if (scrollTimer.current) clearTimeout(scrollTimer.current); cancelAnimationFrame(reorderFrame.current);};
  }, []);
  const first = columns[0];
  const ordered = [...(first ? [first] : []), ...preferences.flatMap(pref => columns.filter(column => column.id === pref.id && column.id !== first?.id)),
    ...columns.filter(column => column.id !== first?.id && !preferences.some(pref => pref.id === column.id))];
  const displayed = ordered.filter((column, index) => index === 0 || !preferences.find(pref => pref.id === column.id)?.hidden);
  const width = (column: ViewColumn) => widths[column.id] ?? preferences.find(pref => pref.id === column.id)?.width ?? column.width ?? (column.numeric ? 130 : 180);
  function changeColumn(id: string, changes: Partial<ColumnPreference>, clearDecimals = false) {
    onColumnsChange(ordered.map(column => {
      const next = {id: column.id, ...preferences.find(pref => pref.id === column.id), ...(column.id === id ? changes : {})};
      if (column.id === id && clearDecimals) delete next.decimals;
      return next;
    }));
  }
  function move(from: number, to: number) {
    if (from <= 0 || to < 1 || from === to || to >= ordered.length) return;
    const next = [...ordered], [column] = next.splice(from, 1); next.splice(to, 0, column!);
    onColumnsChange(next.map(item => ({id: item.id, ...preferences.find(pref => pref.id === item.id)})));
    setAnnouncement(`${column!.label} column moved to position ${to + 1}.`);
  }
  function reorderTarget() {
    const pointer = reorder.current, list = columnList.current;
    if (!pointer || !list) return;
    pointer.to = null;
    const box = list.getBoundingClientRect();
    if (pointer.x < box.left || pointer.x > box.right || pointer.y < box.top || pointer.y > box.bottom) {setReorderIndicator(null); return;}
    const target = [...list.children].findIndex(row => {const rect = row.getBoundingClientRect(); return pointer.y >= rect.top && pointer.y <= rect.bottom;});
    if (target <= 0) {setReorderIndicator(null); return;}
    const rect = list.children[target]!.getBoundingClientRect(), after = pointer.y > rect.top + rect.height / 2;
    const insertion = target + Number(after);
    pointer.to = insertion > pointer.from ? insertion - 1 : insertion;
    setReorderIndicator(pointer.to === pointer.from ? null : {from: pointer.from, target, after});
  }
  function reorderScroll() {
    const pointer = reorder.current, list = columnList.current;
    if (!pointer?.active || !list) return;
    const box = list.getBoundingClientRect();
    if (pointer.x >= box.left && pointer.x <= box.right && pointer.y >= box.top && pointer.y <= box.bottom) {
      list.scrollTop += pointer.y < box.top + 32 ? -10 : pointer.y > box.bottom - 32 ? 10 : 0;
      reorderTarget();
    }
    reorderFrame.current = requestAnimationFrame(reorderScroll);
  }
  function cancelReorder() {reorder.current = null; cancelAnimationFrame(reorderFrame.current); reorderFrame.current = 0; setReorderIndicator(null);}
  function finishResize() {
    const current = drag.current;
    if (!current) return;
    drag.current = null; changeColumn(current.id, {width: current.current});
    setWidths({}); paintRef.current();
  }
  function exportPage() {
    const url = URL.createObjectURL(new Blob([pageCsv(displayed, paintedRows)], {type: "text/csv;charset=utf-8"}));
    const link = document.createElement("a"); link.href = url; link.download = "rvx-table-page.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="data-grid" aria-busy={busy}>
    <RecordQueryToolbar columns={columns} query={query} onChange={onQueryChange} showFilterCount={loaded} actions={<>
      <Button variant="ghost" className="button quiet" onClick={() => setColumnsOpen(true)}><Settings2 />Columns</Button>
      <IconButton className="icon-button" label="Export page CSV" onClick={exportPage}><Download /></IconButton>
    </>} />
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Table rows" onScroll={() => {
      scrolling.current = true;
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      scrollTimer.current = setTimeout(() => {scrolling.current = false; paintRef.current();}, 140);
    }}>
      <table style={{width: displayed.reduce((totalWidth, column) => totalWidth + width(column), 0)}}>
        <colgroup>{displayed.map(column => <col key={column.id} style={{width: width(column)}} />)}</colgroup>
        <thead><tr>{displayed.map((column, index) => <th key={column.id} data-column={column.id} className={index === 0 ? "pinned" : ""} title={column.label}
          aria-sort={column.sortable === false ? undefined : query.sort?.path === column.id ? query.sort.direction === "asc" ? "ascending" : "descending" : "none"}>
          {column.sortable === false ? <span>{column.label}</span> : <button className="table-sort" aria-label={column.label} onClick={() => onQueryChange({...query,
            sort: {path: column.id, direction: query.sort?.path === column.id && query.sort.direction === "asc" ? "desc" : "asc"}})}>
            {column.label}{query.sort?.path === column.id && (query.sort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
          </button>}
          <span className="column-resizer" tabIndex={0} role="separator" aria-label={`Resize ${column.label} column`} aria-orientation="vertical"
            aria-valuemin={70} aria-valuemax={800} aria-valuenow={width(column)}
            onPointerDown={event => {if (event.button !== 0) return; event.preventDefault(); drag.current = {id: column.id, x: event.clientX, initial: width(column), current: width(column)}; event.currentTarget.setPointerCapture(event.pointerId);}}
            onPointerMove={event => {if (drag.current?.id !== column.id) return; drag.current.current = Math.max(70, Math.min(800, drag.current.initial + event.clientX - drag.current.x)); setWidths({[column.id]: drag.current.current});}}
            onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize}
            onKeyDown={event => {if (event.key === "ArrowLeft" || event.key === "ArrowRight") {event.preventDefault(); changeColumn(column.id, {width: Math.max(70, Math.min(800, width(column) + (event.key === "ArrowRight" ? 10 : -10)))});}}} />
        </th>)}</tr></thead>
        <tbody ref={body}>{paintedRows.map(row => <tr key={row.key} data-row-key={row.key} data-snapshot-id={row.snapshotId ?? ""} aria-label={row.title}
          onDoubleClick={onRowDetails ? () => onRowDetails(row) : undefined}>
          {displayed.map((column, index) => {
            const cell = row.cells[column.id] ?? missingCell, text = cell.kind === "missing" ? "missing" : cell.kind === "string" && !cell.text ? '""' : cell.text;
            const display = temporalCellText(column.id, cell) ?? (cell.kind === "number" && !cell.truncated ? decimalDisplay(text, preferences.find(pref => pref.id === column.id)?.decimals) : text);
            return <td key={column.id} data-column={column.id} data-kind={cell.kind}
              className={`${index === 0 ? "pinned " : ""}${cell.kind === "number" ? "numeric " : ""}${cell.kind === "missing" || cell.kind === "null" ? "muted" : ""}`}
              title={row.cellTitles?.[column.id] ?? `${cell.kind}${cell.truncated ? " · truncated preview" : ""}: ${cell.text}`}>
              {index === 0 && onRowDetails ? <button className="table-sort" aria-label={`Details for ${row.title}`} onClick={() => onRowDetails(row)}>{display}{cell.truncated ? " …" : ""}</button>
                : <>{display}{cell.truncated ? " …" : ""}</>}
            </td>;
          })}
        </tr>)}{!paintedRows.length && <tr><td className="table-empty" colSpan={Math.max(1, displayed.length)}>{busy ? "Loading…" : "No matching rows"}</td></tr>}</tbody>
      </table>
    </div>
    <footer className="table-footer"><span className="muted">{total ? `${offset + 1}–${Math.min(total, offset + rows.length)} of ${total.toLocaleString()}` : "0 rows"}</span>
      <IconButton className="icon-button" label="Previous page" disabled={busy || offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}><ChevronLeft /></IconButton>
      <IconButton className="icon-button" label="Next page" disabled={busy || offset + limit >= total} onClick={() => onPage(offset + limit)}><ChevronRight /></IconButton>
    </footer>
    {columnsOpen && <RecordDialog title="Columns" hideTitle className="table-columns-dialog" onClose={() => {cancelReorder(); setColumnsOpen(false);}}
      onEscapeKeyDown={event => {if (reorder.current) {event.preventDefault(); cancelReorder();}}}>
      <p className="sr-only" role="status">{announcement}</p><div className="column-order-headings" aria-hidden="true"><span>Column</span><span>Decimals</span></div>
      <div className="column-order-list" ref={columnList}>{ordered.map((column, index) => <div key={column.id}
        className={`column-option ${reorderIndicator?.from === index ? "column-dragging" : ""} ${reorderIndicator?.target === index ? reorderIndicator.after ? "column-drop-after" : "column-drop-before" : ""}`} data-column-index={index}>
        <IconButton className="column-drag-handle icon-button" label={`Reorder ${column.label} column`} disabled={index === 0}
          aria-keyshortcuts="ArrowUp ArrowDown Home End" title={index === 0 ? "The first column stays pinned" : "Drag to reorder, or use Up/Down"}
          onPointerDown={event => {
            if (event.button !== 0 || !index) return; event.preventDefault(); event.currentTarget.focus({preventScroll: true});
            reorder.current = {from: index, to: null, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, active: false};
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            const pointer = reorder.current; if (!pointer) return;
            pointer.x = event.clientX; pointer.y = event.clientY;
            if (!pointer.active && Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) < 5) return;
            pointer.active = true; reorderTarget(); if (!reorderFrame.current) reorderFrame.current = requestAnimationFrame(reorderScroll);
          }}
          onPointerUp={event => {
            const pointer = reorder.current; cancelReorder();
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            if (pointer?.active && pointer.to !== null) move(pointer.from, pointer.to);
          }} onPointerCancel={cancelReorder} onLostPointerCapture={cancelReorder}
          onKeyDown={event => {
            if (event.key === "Escape" && reorder.current) {event.preventDefault(); event.stopPropagation(); cancelReorder(); return;}
            if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {event.preventDefault(); cancelReorder(); move(index, event.key === "Home" ? 1 : event.key === "End" ? ordered.length - 1 : index + (event.key === "ArrowUp" ? -1 : 1));}
          }}><GripVertical /></IconButton>
        <label><Checkbox aria-label={`Show ${column.label}`} disabled={index === 0} checked={index === 0 || !preferences.find(pref => pref.id === column.id)?.hidden}
          onCheckedChange={checked => changeColumn(column.id, {hidden: checked !== true})} /><span>{column.label}</span></label>
        {(column.numeric || rows.some(row => row.cells[column.id]?.kind === "number") || preferences.some(pref => pref.id === column.id && pref.decimals !== undefined)) &&
          <SelectControl className="column-decimals" label={`Decimal places for ${column.label}`} value={String(preferences.find(pref => pref.id === column.id)?.decimals ?? "")}
            onChange={value => changeColumn(column.id, value === "" ? {} : {decimals: Number(value)}, value === "")}
            options={[["", "Auto"], ...Array.from({length: 21}, (_, places) => [String(places), String(places)] as const)]} />}
      </div>)}</div>
    </RecordDialog>}
  </div>;
}
