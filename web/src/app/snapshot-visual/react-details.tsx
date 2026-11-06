import {Fragment, useEffect, useState, type ReactNode} from "react";
import {ChevronLeft, ChevronRight} from "lucide-react";
import {Tooltip as TooltipPrimitive} from "radix-ui";
import {Button} from "../../components/ui/button";
import type {TableDataRow, TableSource} from "../../domain/tables";
import type {MetricCatalogQueryCoordinator} from "../coordinator";
import {RecordDialog} from "../data-table";
import {IconButton} from "../react-ui";
import {formatTime, observedTime} from "../model";
import {fieldCellText} from "./react-model";

export interface VisualNames {
  runName: (id: string) => string;
  fieldName: (path: string) => string;
  colorFor: (id: string) => string;
}
export type Readout = [label: string, value: string][];
export function provenance(run: string, sourceId: string, snapshot: TableSource | undefined, names: VisualNames): Readout {
  return [["Run", names.runName(run)], ["Reporter", snapshot?.label ?? sourceId], ["Observed", observedTime(snapshot?.observed_at_ns)]];
}
export function ReadoutList({rows, className = ""}: {rows: Readout; className?: string}) {
  return <dl className={`sv-readout ${className}`}>{rows.map(([label, value], index) => <Fragment key={`${label}-${index}`}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>;
}
export function SnapshotTooltip({title, rows, children, clickReadout = false}: {title: string; rows: Readout; children: ReactNode; clickReadout?: boolean}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const hide = () => setOpen(false);
    window.addEventListener("scroll", hide, true); window.addEventListener("resize", hide);
    return () => {window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide);};
  }, [open]);
  return <TooltipPrimitive.Root open={open} onOpenChange={setOpen} delayDuration={100} disableHoverableContent>
    <TooltipPrimitive.Trigger asChild onTouchStart={() => setOpen(true)}
      onClick={event => {if (clickReadout) {event.preventDefault(); setOpen(true);}}}>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal><TooltipPrimitive.Content className="rvx-tooltip" sideOffset={8} collisionPadding={8}>
      <strong className="sv-tooltip-title">{title}</strong><ReadoutList rows={rows} />
    </TooltipPrimitive.Content></TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
}
export interface DetailSelection {record: TableDataRow; snapshot: TableSource | undefined; title: string}
export function SnapshotDetails({path, selection, reads, names, onClose, onPrevious, onNext}: {
  path: string; selection: DetailSelection; reads: MetricCatalogQueryCoordinator; names: VisualNames; onClose: () => void;
  onPrevious?: (() => void) | undefined; onNext?: (() => void) | undefined;
}) {
  const {record, snapshot, title} = selection;
  const identity = JSON.stringify([record.run_id, record.source_id, record.snapshot_id, record.row_key]);
  const [detail, setDetail] = useState<{identity: string; cells: TableDataRow["cells"]} | null>(null);
  const [state, setState] = useState("Loading remaining fields…"), [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    setState("Loading remaining fields…");
    void reads.rows({run_ids: [record.run_id], source_ids: [record.source_id], path, snapshot_ids: [record.snapshot_id],
      filters: [{path: "$key", op: "eq", value: record.row_key}], limit: 1}, request.signal, retry > 0).then(response => {
      if (request.signal.aborted) return;
      const row = response.rows.find(row => row.snapshot_id === record.snapshot_id && row.run_id === record.run_id
        && row.source_id === record.source_id && row.row_key === record.row_key);
      if (!row) {setState("This task is unavailable in the selected observation."); return;}
      setDetail({identity, cells: row.cells}); setState("");
    }).catch(error => {if (!request.signal.aborted) setState(error instanceof Error ? error.message : String(error));});
    return () => request.abort();
  }, [reads, path, identity, retry]);
  const cells = detail?.identity === identity ? detail.cells : record.cells;
  return <RecordDialog title={title} label="Task details" className="sv-task-drawer" onClose={onClose}
    style={{inset: "0 0 0 auto", top: 0, left: "auto", transform: "none", translate: "none", maxHeight: "100dvh"}}>
    <ReadoutList className="sv-task-provenance" rows={[...provenance(record.run_id, record.source_id, snapshot, names).map(([label, value]): [string, string] =>
      [label, label === "Observed" ? formatTime(snapshot?.observed_at_ns) : value]), ["Source ID", record.source_id], ["Snapshot", record.snapshot_id]]} />
    <div className="sv-detail-navigation">
      <IconButton label="Previous task details" disabled={!onPrevious} onClick={onPrevious}><ChevronLeft /></IconButton>
      <IconButton label="Next task details" disabled={!onNext} onClick={onNext}><ChevronRight /></IconButton>
    </div>
    <dl className="sv-task-fields">{Object.entries(cells).slice(0, 131).map(([path, cell]) => <Fragment key={path}>
      <dt title={path}>{names.fieldName(path)}</dt><dd className="sv-task-value" data-kind={cell.kind}
        title={`${cell.kind}${cell.truncated ? " · truncated preview" : ""}: ${cell.text}`}>{fieldCellText(path, cell)}</dd>
    </Fragment>)}</dl>
    {state && <span className="muted sv-detail-state" role="status">{state}
      {state !== "Loading remaining fields…" && <Button variant="ghost" onClick={() => setRetry(retry + 1)}>Retry</Button>}
    </span>}
  </RecordDialog>;
}
