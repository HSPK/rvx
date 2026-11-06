import {useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties} from "react";
import {Info, ListFilter, Search} from "lucide-react";
import {Checkbox} from "@/components/ui/checkbox";
import {Input} from "@/components/ui/input";
import {filteredRuns, humanize, type RunFilters} from "./model";
import type {ExperimentRun, ExperimentRecord, ProjectRecord} from "../domain/types";
import type {ChartRunInfo} from "../domain/snapshots";
import {runObservationState} from "./run-context";
import {IconButton, Message, SelectControl, Tooltip} from "./react-ui";

export interface RunMetadata {projects: ProjectRecord[]; experiments: ExperimentRecord[]; runs: ExperimentRun[]}
const rowHeight = 44;

export function RunSelector({metadata, observations, runIds, filters, compact, mobileCompact, refreshing, suspended, colorFor, labelFor, onToggle, onFilters, onDetails}: {
  metadata: RunMetadata; runIds: string[]; filters: RunFilters; compact: boolean; mobileCompact: boolean;
  observations: ChartRunInfo[];
  refreshing: boolean; suspended: boolean; colorFor: (id: string) => string; labelFor: (run: ExperimentRun) => string;
  onToggle: (id: string) => void; onFilters: (filters: RunFilters, replace: boolean) => void; onDetails: (id: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const [window, setWindow] = useState({top: 0, height: 500, gutter: 0});
  const selected = useMemo(() => new Set(runIds), [runIds]);
  const filtered = useMemo(() => filteredRuns(metadata.runs, metadata.experiments, filters), [metadata, filters]);
  const matching = useMemo(() => new Set(filtered.map(run => run.id)), [filtered]);
  const rows = compact ? metadata.runs : [...metadata.runs.filter(run => selected.has(run.id) && !matching.has(run.id)), ...filtered];
  const start = mobileCompact ? 0 : Math.max(0, Math.floor(window.top / rowHeight) - 3);
  const count = Math.min(32, Math.ceil(window.height / rowHeight) + 6);
  const visible = mobileCompact ? [...metadata.runs.filter(run => selected.has(run.id)), ...filtered.filter(run => !selected.has(run.id))].slice(0, 16)
    : rows.slice(start, start + count);
  const outside = runIds.filter(id => !filtered.some(run => run.id === id)).length;
  const filterKey = JSON.stringify(filters);
  useLayoutEffect(() => {
    const node = viewport.current!;
    const resize = new ResizeObserver(() => setWindow(old => ({...old, height: node.clientHeight || 500, gutter: node.offsetWidth - node.clientWidth})));
    resize.observe(node);
    return () => {resize.disconnect(); cancelAnimationFrame(frame.current);};
  }, []);
  useEffect(() => {
    viewport.current?.scrollTo({top: 0});
    setWindow(old => ({...old, top: 0}));
  }, [filterKey, compact, mobileCompact]);
  return <section className="runs-selector" id="rvx-run-selector" aria-label="Run selector" aria-busy={refreshing}
    data-compact={compact} data-mobile-compact={mobileCompact} data-run-count={filtered.length}
    style={{"--run-row-height": `${rowHeight}px`, "--rail-gutter": `${window.gutter}px`} as CSSProperties}>
    <div className="run-filters">
      <div className="run-search-row">
        <label className="search-box"><Search aria-hidden="true" /><Input type="search" aria-label="Search runs"
          placeholder={refreshing ? "Refreshing runs…" : "Find a run…"} value={filters.search}
          onChange={event => onFilters({...filters, search: event.target.value}, true)} /></label>
        <SelectControl label="Status" icon={<ListFilter aria-hidden="true" />} className={`run-status-filter ${filters.status ? "is-filtered" : ""}`} value={filters.status}
          options={[["", "Any status"], ...["running", "finished", "failed", "created", "cancelled"].map(value => [value, humanize(value)] as const)]}
          onChange={status => onFilters({...filters, status}, false)} />
      </div>
      <SelectControl label="Project" options={[["", "Projects"], ...metadata.projects.map(project => [project.id, project.name] as const)]}
        value={filters.project} onChange={project => onFilters({...filters, project, experiment: ""}, false)} />
      <SelectControl label="Experiment" options={[["", "Experiments"], ...metadata.experiments.filter(experiment => !filters.project || experiment.project_id === filters.project)
        .map(experiment => [experiment.id, experiment.name] as const)]} value={filters.experiment}
        onChange={experiment => onFilters({...filters, experiment}, false)} />
    </div>
    <span className="muted run-count sr-only" data-unit={filtered.length === 1 ? " run" : " runs"}>{filtered.length.toLocaleString()}</span>
    <span className="refresh-state sr-only" role="status">{refreshing ? "Refreshing runs…" : ""}</span>
    <span className="selection-count sr-only" role="status">{runIds.length} selected{outside ? ` · ${outside} outside filters` : ""}</span>
    <p className="selection-limit sr-only" hidden={runIds.length < 4}>Up to 4 runs keeps overlaid curves readable.</p>
    {runIds.filter(id => !metadata.runs.some(run => run.id === id)).map(id => <label key={id} className="unavailable-selected-run">
      <Checkbox aria-label={`Select unavailable run ${id}`} checked disabled={suspended} onCheckedChange={() => onToggle(id)} />
      <span>{id} · unavailable</span>
    </label>)}
    <div className="run-viewport" ref={viewport} tabIndex={0} aria-label="Scrollable run list"
      style={{"--run-list-height": `${Math.min(filtered.length, 8) * rowHeight}px`} as CSSProperties}
      onScroll={() => {
        if (frame.current || suspended) return;
        frame.current = requestAnimationFrame(() => {frame.current = 0; setWindow(old => ({...old, top: viewport.current?.scrollTop ?? 0}));});
      }}>
      <div className="run-rows" style={{height: mobileCompact ? undefined : rows.length * rowHeight}}>
        {!visible.length && <Message title={metadata.runs.length ? "No matching runs" : "No runs yet"} />}
        {visible.map((run, index) => {
          const label = labelFor(run), checked = selected.has(run.id);
          const observation = runObservationState(run, observations.find(info => info.run_id === run.id), Date.now());
          const state = observation === "stale" ? "No recent data" : observation === "empty" ? "No data" : "";
          const outside = checked && !matching.has(run.id);
          return <Tooltip key={run.id} side={compact ? "right" : "top"} label={[label, humanize(run.status), state, outside ? "outside filters" : ""].filter(Boolean).join(" · ")}>
            <div className={`run-row ${checked ? "selected" : ""}`} data-run-id={run.id}
              style={{transform: `translateY(${(start + index) * rowHeight}px)`, "--run-color": colorFor(run.id)} as CSSProperties}>
              <label className="run-choice">
                <Checkbox className="run-checkbox" checked={checked} disabled={suspended || selected.size >= 4 && !checked}
                  aria-label={`Select ${label}`} onCheckedChange={() => onToggle(run.id)}
                  style={{borderColor: colorFor(run.id), backgroundColor: checked ? colorFor(run.id) : undefined}} />
                <span className={`run-status status-${run.status}`} role="img" aria-label={humanize(run.status)} />
                <span className="run-name"><strong>{label}</strong>{(state || outside) && <small className={`run-observation ${observation === "stale" ? "stale-text" : "muted"}`}>
                  {[state, outside ? "outside filters" : ""].filter(Boolean).join(" · ")}
                </small>}</span>
              </label>
              <IconButton label={`Run details for ${label}`} className="run-detail-button" data-run-details={run.id} onClick={() => onDetails(run.id)}><Info /></IconButton>
            </div>
          </Tooltip>;
        })}
      </div>
    </div>
  </section>;
}
