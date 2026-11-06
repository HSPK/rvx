import {useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent} from "react";
import type {SnapshotAggregateResponse, SnapshotRecordsResponse, SnapshotStatusView} from "../../domain/snapshot-views";
import type {TableColumn} from "../../domain/tables";
import {missingCell} from "../data-table-model";
import {RecordDialog} from "../data-table";
import {SelectControl} from "../react-ui";
import {numericSnapshotFields, statusLayoutLimits, unsetSnapshotField} from "../snapshot-config";
import {cellText, fieldCellText, gridGeometry, statusColor, statusTasks, statusTotals, type StatusTask} from "./react-model";
import {provenance, SnapshotTooltip, type VisualNames} from "./react-details";
import {statusShade, statusShadeDomain} from "./shading";

function StateColorInput({label, value, onChange}: {label: string; value: string; onChange: (value: string) => void}) {
  const input = useRef<HTMLInputElement>(null), reported = useRef(value), changed = useRef(onChange);
  reported.current = value; changed.current = onChange;
  const publish = (next: string) => {if (reported.current !== next) {reported.current = next; changed.current(next);}};
  const publishRef = useRef(publish); publishRef.current = publish;
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    // Native color pickers commit on change, including platforms without intermediate input events.
    const commit = () => publishRef.current(node.value);
    node.addEventListener("change", commit);
    return () => node.removeEventListener("change", commit);
  }, []);
  return <input ref={input} type="color" className="sv-state-color" aria-label={label} title={label} value={value}
    onChange={event => publish(event.target.value)} />;
}

export function SnapshotArrangement({view, columns, onChange, onClose}: {
  view: SnapshotStatusView; columns: TableColumn[]; onChange: (view: SnapshotStatusView) => void; onClose: () => void;
}) {
  const sortOptions: [string, string][] = [[unsetSnapshotField, "Stable identity"], ...columns.filter(column =>
    !column.kinds?.length || column.kinds.some(kind => kind !== "array" && kind !== "object")).map(column => [column.path, column.name] as [string, string])];
  const shadeOptions: [string, string][] = [[unsetSnapshotField, "None"], ...numericSnapshotFields(columns).map(column => [column.path, column.name] as [string, string])];
  return <RecordDialog title="Arrange tasks" className="sv-arrange-popover" onClose={onClose}>
    <div className="snapshot-status-controls">
      <label className="field">Sort by<SelectControl label="Sort by" options={sortOptions} value={view.sort?.path ?? unsetSnapshotField} onChange={path => {
        const next = {...view}; if (path === unsetSnapshotField) delete next.sort; else next.sort = {path, direction: view.sort?.direction ?? "asc"}; onChange(next);
      }} /></label>
      <label className="field">Direction<SelectControl label="Sort direction" options={[["asc", "Ascending"], ["desc", "Descending"]]} value={view.sort?.direction ?? "asc"}
        disabled={!view.sort} onChange={direction => {if (view.sort) onChange({...view, sort: {...view.sort, direction: direction === "asc" ? "asc" : "desc"}});}} /></label>
      <label className="field">Shade by<SelectControl label="Shade by" options={shadeOptions} value={view.shadePath ?? unsetSnapshotField} onChange={path => {
        const next = {...view}; if (path === unsetSnapshotField) delete next.shadePath; else next.shadePath = path; onChange(next);
      }} /></label>
      <label className="field">Scale<SelectControl label="Shade scale" options={[["log", "Logarithmic"], ["linear", "Linear"]]} value={view.shadeScale ?? "log"}
        disabled={view.shadePath === undefined} onChange={scale => onChange({...view, shadeScale: scale === "linear" ? "linear" : "log"})} /></label>
      {([["columns", "Columns", ""], ["cellSize", "Cell size", view.density === "compact" ? 15 : 23], ["gap", "Gap", 5]] as const).map(([key, label, defaultValue]) => {
        const [min, max] = statusLayoutLimits[key];
        const options: [string, string][] = Array.from({length: max - min + 1}, (_, index) => [String(min + index), `${min + index}${key === "columns" ? "" : " px"}`]);
        if (key === "columns") options.unshift(["", "Auto"]);
        return <label className="field" key={key}>{label}<SelectControl label={label} options={options} value={String(view[key] ?? defaultValue)} onChange={value => {
          const next = {...view}; if (value === "") delete next[key]; else next[key] = Number(value); onChange(next);
        }} /></label>;
      })}
    </div>
  </RecordDialog>;
}

export function SnapshotStatus({records, counts, view, names, onOpen, onColorChange, active}: {
  records: SnapshotRecordsResponse; counts: SnapshotAggregateResponse; view: SnapshotStatusView; names: VisualNames;
  onOpen: (task: StatusTask) => void; onColorChange: (raw: string, color: string) => void; active: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null), buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusTarget = useRef<string | null>(null);
  const [dimensions, setDimensions] = useState({width: 500, height: 320, expanded: false});
  const [top, setTop] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const tasks = useMemo(() => statusTasks(records, view), [records, view]);
  const totals = useMemo(() => statusTotals(counts), [counts]);
  const shadeDomain = useMemo(() => view.shadePath === undefined ? null : statusShadeDomain(counts, view.shadeScale ?? "log"), [counts, view.shadePath, view.shadeScale]);
  const snapshots = useMemo(() => new Map(records.snapshots.map(snapshot => [snapshot.snapshot_id, snapshot])), [records]);
  useEffect(() => {
    const node = viewport.current;
    if (!node || !active) return;
    const resize = new ResizeObserver(() => setDimensions({width: Math.max(1, node.clientWidth - 8), height: node.clientHeight || 320, expanded: Boolean(node.closest(".is-expanded"))}));
    resize.observe(node); return () => resize.disconnect();
  }, [active]);
  const layout = useMemo(() => {
    const geometry = gridGeometry(dimensions.width, dimensions.height, view, dimensions.expanded, tasks.length);
    const groups: {key: string; label: string; y: number; run: string}[] = [], placements: {task: StatusTask; x: number; y: number; size: number; index: number}[] = [];
    const sourceCounts = new Map<string, number>();
    for (const snapshot of snapshots.values()) sourceCounts.set(snapshot.run_id, (sourceCounts.get(snapshot.run_id) ?? 0) + 1);
    let current = "", y = 4, local = 0;
    for (const [index, task] of tasks.entries()) {
      if (current !== task.group) {
        if (current) y += Math.ceil(local / geometry.columns) * geometry.pitch + 10;
        current = task.group; local = 0;
        const snapshot = snapshots.get(task.record.snapshot_id), peers = sourceCounts.get(task.record.run_id) ?? 0;
        const owner = names.runName(task.record.run_id) + (peers > 1 ? ` · ${snapshot?.label ?? task.record.source_id}` : "");
        groups.push({key: task.group, label: `${view.groupPath !== undefined ? `${names.fieldName(view.groupPath)}: ${task.groupLabel} · ` : ""}${owner}`, y, run: task.record.run_id});
        y += 30;
      }
      placements.push({task, x: 4 + local % geometry.columns * geometry.pitch, y: y + Math.floor(local / geometry.columns) * geometry.pitch, size: geometry.size, index});
      local++;
    }
    return {...geometry, groups, placements, height: Math.max(y + Math.ceil(local / geometry.columns) * geometry.pitch + 4, tasks.length ? 60 : 90)};
  }, [tasks, snapshots, dimensions, view, names]);
  const selection = selected && tasks.some(task => task.key === selected) ? selected : tasks[0]?.key ?? null;
  const mountBudget = dimensions.expanded ? 1800 : 800;
  const visible = tasks.length <= mountBudget ? layout.placements : layout.placements.filter(placement =>
    placement.y >= top - layout.pitch * 2 && placement.y <= top + dimensions.height + layout.pitch * 2 || placement.task.key === selection);
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const index = tasks.findIndex(task => task.key === selection);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tasks.length - 1
      : Math.max(0, Math.min(tasks.length - 1, index + (event.key === "ArrowDown" ? layout.columns : event.key === "ArrowUp" ? -layout.columns : event.key === "ArrowRight" ? 1 : -1)));
    const placement = layout.placements[next]!;
    focusTarget.current = placement.task.key; setSelected(placement.task.key);
    const node = viewport.current;
    if (node) {
      if (placement.y < node.scrollTop) node.scrollTop = placement.y;
      else if (placement.y + placement.size > node.scrollTop + node.clientHeight) node.scrollTop = placement.y + placement.size - node.clientHeight;
      setTop(node.scrollTop);
    }
  }
  useEffect(() => {
    const node = viewport.current;
    if (focusTarget.current || node?.contains(document.activeElement)) {
      const target = buttons.current.get(focusTarget.current ?? selection ?? "");
      if (target) {target.focus({preventScroll: true}); focusTarget.current = null;}
    }
  }, [selection, top]);
  const shadeLabel = shadeDomain ? `${names.fieldName(view.shadePath!)} · ${shadeDomain.bounds
    ? shadeDomain.bounds.span === 0n ? fieldCellText(view.shadePath!, {kind: "number", text: shadeDomain.bounds.minimum.text, truncated: false})
      : `${fieldCellText(view.shadePath!, {kind: "number", text: shadeDomain.bounds.minimum.text, truncated: false})} – ${fieldCellText(view.shadePath!, {kind: "number", text: shadeDomain.bounds.maximum.text, truncated: false})}` : "No numeric values"} · ${shadeDomain.scale === "log" ? "Log" : "Linear"}${shadeDomain.unavailable ? ` · ${shadeDomain.unavailable} unavailable` : ""}` : "";
  return <div className="sv-status">
    <div className="sv-status-legend" aria-label="Full filtered task status counts">{counts.groups.map(group => {
      const state = group.cells[0] ?? missingCell, editable = state.kind !== "missing" && state.kind !== "null" && !state.truncated && !state.text.includes("\0") && new TextEncoder().encode(state.text).length <= 256;
      return <label className="sv-state-key" key={group.key} data-kind={state.kind} style={{"--sv-state": statusColor(state, view.colors)} as CSSProperties}
        title={`${cellText(state)} · ${totals.get(group.key)} tasks across the full filtered dataset\n${group.series.map(series => `${names.runName(series.run_id)} · Source ${series.source_id}: ${series.measures.count?.value.text ?? "missing"}`).join("\n")}`}>
        {editable ? <StateColorInput label={`Color for ${cellText(state)}`} value={statusColor(state, view.colors)} onChange={color => onColorChange(state.text, color)} />
          : <i className="sv-state-swatch" />}<span className="sv-state-name">{cellText(state)}</span><span className="sv-state-count">{totals.get(group.key)}</span>
      </label>;
    })}{shadeDomain && <span className="sv-shade-key" data-scale={shadeDomain.scale} title={`${shadeLabel}\nRange across all filtered tasks and Sources. A corner dot marks unavailable shading.`}>
      <span className="sv-shade-ramp">{[24, 42, 60, 78, 96].map(intensity => <i key={intensity} style={{"--sv-shade-step": `${intensity}%`} as CSSProperties} />)}</span><span className="sv-shade-label">{shadeLabel}</span>
    </span>}</div>
    <div className="sv-status-viewport" ref={viewport} tabIndex={0} role="group" aria-label={`Task status grid · ${tasks.length} tasks on this page · ${records.total} total`}
      aria-description="Each cell is one task. Arrow keys move between tasks. Home and End move to page edges. Enter opens task details."
      style={{"--sv-content-height": `${Math.max(100, Math.min(360, layout.height))}px`} as CSSProperties} onScroll={event => setTop(event.currentTarget.scrollTop)} onKeyDown={navigate}>
      <div className="sv-status-canvas" style={{height: layout.height}} data-columns={layout.columns} data-total={records.total}>
        {layout.groups.filter(group => group.y + 30 >= top - layout.pitch * 2 && group.y <= top + dimensions.height + layout.pitch * 2).map(group =>
          <h3 className="sv-task-group" key={group.key} title={group.label} style={{top: group.y, "--run-color": names.colorFor(group.run)} as CSSProperties}>{group.label}</h3>)}
        {visible.map(({task, x, y, size}) => {
          const snapshot = snapshots.get(task.record.snapshot_id), shade = shadeDomain ? statusShade(task.record.cells[view.shadePath!], shadeDomain) : undefined;
          return <SnapshotTooltip key={task.key} title={task.label} rows={[
            [names.fieldName(view.statusPath), cellText(task.state)],
            ...view.idPaths.filter(path => path !== view.labelPath && path !== view.statusPath)
              .map((path): [string, string] => [names.fieldName(path), cellText(task.record.cells[path])]),
            ...(view.valuePath !== undefined ? [[names.fieldName(view.valuePath), fieldCellText(view.valuePath, task.record.cells[view.valuePath])] as [string, string]] : []),
            ...(view.shadePath !== undefined && ![view.valuePath, view.statusPath, ...view.idPaths].includes(view.shadePath)
              ? [[names.fieldName(view.shadePath), fieldCellText(view.shadePath, task.record.cells[view.shadePath])] as [string, string]] : []),
            ...(shade === null ? [["Shade", "Unavailable"] as [string, string]] : []),
            ...provenance(task.record.run_id, task.record.source_id, snapshot, names),
          ]}>
            <button type="button" className="sv-task-cell" ref={node => {if (node) buttons.current.set(task.key, node); else buttons.current.delete(task.key);}}
              data-task-key={task.key} data-identity={task.identity} data-status={task.state.text} data-kind={task.state.kind} data-run={task.record.run_id}
              data-source={task.record.source_id} data-snapshot-id={task.record.snapshot_id} data-row-key={task.record.row_key}
              data-shade={shade === undefined ? "none" : shade === null ? "unavailable" : "numeric"}
              tabIndex={selection === task.key ? 0 : -1} aria-label={`${task.label} · ${cellText(task.state)} · ${names.runName(task.record.run_id)} · Source ${snapshot?.label ?? task.record.source_id}`}
              style={{transform: `translate(${x}px, ${y}px)`, width: size, height: size, "--sv-state": statusColor(task.state, view.colors),
                ...(shade !== undefined ? {"--sv-shade": `${shade === null ? 55 : 24 + shade * 72}%`} : {})} as CSSProperties}
              onFocus={() => setSelected(task.key)} onClick={() => {setSelected(task.key); onOpen(task);}} />
          </SnapshotTooltip>;
        })}
        {!tasks.length && <p className="sv-empty muted">No tasks match this snapshot query.</p>}
      </div>
    </div>
  </div>;
}
