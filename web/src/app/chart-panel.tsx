import {useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent} from "react";
import {Popover} from "radix-ui";
import {Settings2} from "lucide-react";
import uPlot from "uplot";
import {Button} from "../components/ui/button";
import {axisLabel, compatibleMetrics, duration, formatNumber, formatTime, metricName, pointId, reporters} from "./model";
import type {ChartPanelProps} from "./panel-types";
import {PanelFrame} from "./panel-frame";
import {cancelPlot, schedulePlot} from "./plot-scheduler";
import {endpointTicks} from "./chart-ticks";
import {elapsedIncrements, elapsedTick, wallTimeLabels} from "./time";
import {chartRows, chartYRange, coordinateText, nearestIndex, pointText, type ChartRow, type ChartTrace} from "./chart-panel-model";
import {chartPanelPng} from "./chart-panel-export";
import {useChartProjection} from "./use-chart-projection";

type Selection = {key: string; id: string; index: number; runId: string};
type Hover = {x: number; y: number; heading: string; rows: ReadoutRow[]; start: number; total: number; keyboard: boolean; visible: boolean};
type ReadoutRow = {key: string; label: string; color: string; dashed: boolean; selected: boolean; index: number; value: string; time: string; id?: string};
type LocalSettings = {smoothing: number; logarithmic: boolean};
const axisFont = "11px system-ui, sans-serif";
const keyboardHelp = "Use left/right for observations and up/down for Run or reporter traces. Fullscreen is in chart options. Drag the plot to zoom; Shift-drag to pan; double-click to reset.";

function runStyle(color: string): CSSProperties {return {"--run-color": color} as CSSProperties;}

function ChartTooltip({hover, id}: {hover: Hover; id: string}) {
  const ref = useRef<HTMLDivElement>(null);
  const [boundary, setBoundary] = useState<HTMLElement | null>(null);
  const anchor = useRef({getBoundingClientRect: () => new DOMRect(hover.x, hover.y, 0, 0)});
  anchor.current = {getBoundingClientRect: () => new DOMRect(hover.x, hover.y, 0, 0)};
  const viewport = window.visualViewport;
  const width = Math.min(viewport?.width ?? innerWidth, boundary?.clientWidth ?? Infinity);
  const height = Math.min(viewport?.height ?? innerHeight, boundary?.clientHeight ?? Infinity);
  useLayoutEffect(() => {
    setBoundary(ref.current?.closest<HTMLElement>(".editor-preview-pane") ?? null);
  }, []);
  return <Popover.Root open={hover.visible}>
    <Popover.Anchor virtualRef={anchor} />
    <Popover.Content forceMount ref={ref} id={id} role="tooltip" aria-label="Chart values" className="chart-tooltip"
      side="right" align="start" sideOffset={16} collisionPadding={8} collisionBoundary={boundary ?? []} sticky="always"
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      style={{position: "relative", inset: "auto", zIndex: 1000, display: hover.visible ? "block" : "none",
        maxWidth: Math.max(0, Math.min(380, width - 16)), maxHeight: Math.max(0, height - 16), pointerEvents: "none"}}>
      <div className="chart-tooltip-header">
        <span className="chart-tooltip-heading">{hover.heading}</span>
        {hover.rows.length < hover.total && <span className="chart-tooltip-count"
          aria-label={`Traces ${hover.start + 1} through ${hover.start + hover.rows.length} of ${hover.total}. Use up/down for other traces.`}>
          {hover.start + 1}–{hover.start + hover.rows.length}/{hover.total} · ↑↓
        </span>}
      </div>
      {hover.rows.map(row => <div key={row.key} role="group" aria-label={row.selected ? "Selected trace" : "Trace"}
        className={`chart-tooltip-row${row.dashed ? " dashed" : ""}${row.selected ? " is-selected" : ""}`}
        data-trace-index={row.index} data-snapshot-id={row.id} style={runStyle(row.color)}>
        <span className="chart-tooltip-dot" /><span className="chart-tooltip-label">{row.label}</span>
        <strong className="chart-tooltip-value">{row.value}</strong><span className="chart-tooltip-time">{row.time}</span>
      </div>)}
    </Popover.Content>
  </Popover.Root>;
}

/** React owns every surface except uPlot's canvas and its engine-managed plotting nodes. */
export function ChartPanel(props: ChartPanelProps) {
  const {spec, data, runs, range, active, colorFor, labelFor, onAction, onRetry} = props;
  const evidence = useRef<{axis: string; metrics: typeof data.metrics; series: typeof data.series} | null>(null);
  if (!data.pending && !data.error && !data.unavailable) evidence.current = {axis: data.axis, metrics: data.metrics, series: data.series};
  const retained = !data.unavailable && (data.pending || data.error) && evidence.current?.axis === data.axis ? evidence.current : null;
  const metrics = data.metrics.length ? data.metrics : retained?.metrics ?? data.metrics;
  const series = data.series.length ? data.series : retained?.series ?? data.series;
  const title = spec.presentation?.title ?? (metrics.length ? metrics.map(metricName).join(" / ") : spec.path);
  const unit = metrics.find(metric => metric.sources.length)?.unit ?? metrics[0]?.unit;
  const incompatible = !compatibleMetrics(metrics.filter(metric => metric.sources.length));
  const local = useMemo<LocalSettings>(() => props.viewSettings ?? {smoothing: 0, logarithmic: false}, [props.viewSettings]);
  const numericRows = useMemo(() => data.unavailable ? [] : chartRows(metrics, series, runs, data.pending, colorFor, labelFor, null),
    [metrics, series, runs, data.pending, data.unavailable, colorFor, labelFor]);
  const numericSeries = useMemo(() => numericRows.flatMap(row => row.trace ? [row.trace.series] : []), [numericRows]);
  const projected = useChartProjection(numericSeries, data.axis, local.smoothing, local.logarithmic, active && !data.unavailable && !incompatible);
  const coordinates = useMemo(() => new Map(projected.series.map((series, index) =>
    [series, projected.projection?.coordinates[index] ?? {axes: [], indices: []}] as const)), [projected.series, projected.projection]);
  const pending = data.pending || projected.pending;
  const error = data.error ?? projected.error ?? (incompatible ? "These metrics use different units. Edit this panel to separate them." : null);
  const rows = useMemo(() => data.unavailable
    ? runs.map(run => ({key: run.id, label: labelFor(run), color: colorFor(run.id), dashed: false,
      state: data.truncated ? "unavailable" : "not recorded", legendState: data.truncated ? "unavailable" : "not recorded"} as ChartRow))
    : chartRows(metrics, projected.series, runs, pending, colorFor, labelFor, coordinates),
  [metrics, projected.series, pending, data.unavailable, data.truncated, runs, colorFor, labelFor, coordinates]);
  const traces = useMemo(() => rows.flatMap(row => row.trace ? [row.trace] : []), [rows]);
  const [hover, setHover] = useState<Hover | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [axisExtra, setAxisExtra] = useState(0);
  const [description, setDescription] = useState("");
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const download = useRef<HTMLAnchorElement>(null);
  const plot = useRef<uPlot | null>(null);
  const scheduler = useRef({});
  const signature = useRef("");
  const axis = useRef(data.axis);
  const selection = useRef<Selection | null>(null);
  const interacted = useRef(false);
  const zoom = useRef(false);
  const hoverMode = useRef<"pointer" | "keyboard" | null>(null);
  const pointer = useRef({x: 0, y: 0});
  const hoverFrame = useRef(0);
  const touch = useRef<{x: number; y: number; moved: boolean} | null>(null);
  const pan = useRef<{left: number; min: number; max: number} | null>(null);
  const tooltipStart = useRef(0);
  const lastSuccess = useRef<number | null>(null);
  const tooltipId = useId();
  const latest = useRef({props, rows, traces, local, projected});
  latest.current = {props, rows, traces, local, projected};
  const drawRef = useRef<() => void>(() => {});
  const restoreRef = useRef<() => void>(() => {});
  const factor = () => axis.current === "wall_time" || axis.current === "elapsed" ? 1e9 : 1;
  const hasNumeric = traces.some(trace => trace.series.values.some(value => value !== null));
  const canExport = projected.ready && !pending && !data.unavailable && !incompatible && traces.length > 0;
  useEffect(() => {props.onExportReady?.(canExport);}, [canExport, props.onExportReady]);
  const automaticLegend = metrics.length === 1 && runs.length === 1 && reporters(metrics[0]!, runs[0]!.id).length === 1;
  const legendHidden = spec.presentation?.legend === "hide" || (spec.presentation?.legend ?? "auto") === "auto" && automaticLegend && !data.unavailable;

  function hideHover() {
    cancelAnimationFrame(hoverFrame.current); hoverFrame.current = 0;
    hoverMode.current = null;
    setHover(previous => previous?.visible ? {...previous, visible: false} : previous);
  }
  function setZoom(value: boolean) {zoom.current = value; setZoomed(value);}
  function resetZoom() {
    hideHover(); setZoom(false);
    if (plot.current && latest.current.projected.projection) plot.current.setData(latest.current.projected.projection.data);
  }
  function retry() {
    setRetrying(true); hideHover();
    if (projected.error) projected.retry();
    if (data.error || !projected.error) onRetry();
  }
  function choose(row: ChartRow, index: number, explicit = true) {
    if (!row.trace || index < 0 || !row.trace.series.snapshot_ids[index]) return;
    if (explicit) interacted.current = true;
    selection.current = {key: row.key, id: pointId(row.trace.series, index), index, runId: row.trace.series.run_id};
  }
  function renderHover(x: number, screenX: number, screenY: number, pointerSelection: boolean, left = 0, top = 0) {
    const chart = plot.current;
    if (!chart || !latest.current.props.active) return;
    const currentRows = latest.current.rows;
    let best: {row: ChartRow; index: number} | undefined, missing: typeof best;
    let distance = Infinity, missingDistance = Infinity;
    const width = chart.over.clientWidth, height = chart.over.clientHeight;
    const samples = currentRows.map(row => {
      const trace = row.trace;
      if (!trace || x < trace.coordinates.axes[0]! || x > trace.coordinates.axes.at(-1)!) return -1;
      const index = trace.coordinates.indices[nearestIndex(trace.coordinates.axes, x)]!;
      if (!pointerSelection) return index;
      const px = chart.valToPos(trace.series.axes[index]! / factor(), "x"), value = trace.series.values[index];
      if (px < 0 || px > width) return index;
      const horizontal = Math.abs(px - left);
      if (value == null) {
        if (horizontal < missingDistance) {missing = {row, index}; missingDistance = horizontal;}
      } else {
        const py = chart.valToPos(value, "y");
        if (Number.isFinite(py) && py >= 0 && py <= height) {
          const next = horizontal + Math.abs(py - top) * .25;
          if (next < distance) {best = {row, index}; distance = next;}
        }
      }
      return index;
    });
    const candidate = best ?? missing;
    if (candidate) choose(candidate.row, candidate.index);
    const selectedRow = currentRows.findIndex((row, index) => row.key === selection.current?.key && samples[index] === selection.current.index);
    const referenceRow = selectedRow >= 0 ? selectedRow : currentRows.findIndex((row, index) => row.trace && samples[index]! >= 0);
    const reference = referenceRow >= 0 ? currentRows[referenceRow]!.trace!.series.axes[samples[referenceRow]!]! : x;
    const availableHeight = Math.min(window.visualViewport?.height ?? innerHeight, host.current?.closest(".editor-preview-pane")?.clientHeight ?? Infinity);
    const capacity = Math.min(currentRows.length, Math.max(1, Math.min(12, Math.floor((availableHeight - 60) / 72))));
    let start = Math.min(tooltipStart.current, Math.max(0, currentRows.length - capacity));
    if (selectedRow >= 0 && (selectedRow < start || selectedRow >= start + capacity))
      start = Math.max(0, Math.min(selectedRow - Math.floor(capacity / 2), currentRows.length - capacity));
    tooltipStart.current = start;
    const title = axis.current === "elapsed" ? "Elapsed" : axis.current === "wall_time" ? "" : axisLabel(axis.current);
    setHover({
      x: screenX, y: screenY, heading: `${title ? `${title} · ` : ""}${coordinateText(axis.current, reference)}${latest.current.local.smoothing ? ` · EMA ${latest.current.local.smoothing}` : ""}`,
      start, total: currentRows.length, keyboard: !pointerSelection, visible: true,
      rows: currentRows.slice(start, start + capacity).map((row, index) => {
        const at = samples[start + index]!;
        return {key: row.key, label: row.label, color: row.color, dashed: row.dashed,
          index: start + index, selected: start + index === selectedRow,
          ...(!row.trace ? {value: row.state === "no observations in range" ? "no data" : row.state, time: ""}
            : at < 0 ? {value: "outside span", time: ""} : pointText(row.trace, at, reference, axis.current))};
      }),
    });
  }
  function showKeyboardHover() {
    cancelAnimationFrame(hoverFrame.current); hoverFrame.current = 0;
    const chart = plot.current, selected = selection.current;
    const row = latest.current.rows.find(row => row.key === selected?.key);
    if (!chart || !selected || !row?.trace) return;
    const box = chart.over.getBoundingClientRect(), trace = row.trace;
    const x = trace.series.axes[selected.index]!, value = trace.series.values[selected.index];
    const px = Math.max(0, Math.min(box.width, chart.valToPos(x / factor(), "x")));
    const py = value == null ? box.height / 2 : chart.valToPos(value, "y");
    const y = Number.isFinite(py) ? Math.max(0, Math.min(box.height, py)) : box.height / 2;
    renderHover(x, box.left + px, box.top + y, false);
    hoverMode.current = "keyboard";
  }
  function moveObservation(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {hideHover(); return;}
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const navigable = latest.current.rows.filter(row => row.trace);
    let traceIndex = Math.max(0, navigable.findIndex(row => row.key === selection.current?.key));
    let row = navigable[traceIndex];
    if (!row?.trace) return;
    const selected = selection.current;
    const previous = navigable.find(row => row.key === selected?.key)?.trace;
    const x = selected && previous ? previous.series.axes[selected.index]! : row.trace.coordinates.axes.at(-1)!;
    let position: number;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      traceIndex = Math.max(0, Math.min(navigable.length - 1, traceIndex + (event.key === "ArrowDown" ? 1 : -1)));
      row = navigable[traceIndex]!;
      position = nearestIndex(row.trace!.coordinates.axes, x);
    } else position = Math.max(0, Math.min(row.trace.coordinates.axes.length - 1,
      nearestIndex(row.trace.coordinates.axes, x) + (event.key === "ArrowRight" ? 1 : -1)));
    choose(row, row.trace!.coordinates.indices[position]!);
    showKeyboardHover();
  }
  function queueHover(x: number, y: number) {
    if (hoverMode.current === "keyboard" && pointer.current.x === x && pointer.current.y === y) return;
    pointer.current = {x, y};
    if (!plot.current || hoverFrame.current) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const chart = plot.current;
      if (!chart || !latest.current.props.active) return;
      const box = chart.over.getBoundingClientRect(), left = pointer.current.x - box.left, top = pointer.current.y - box.top;
      if (left < 0 || left > box.width || top < 0 || top > box.height) {hideHover(); return;}
      renderHover(chart.posToVal(left, "x") * factor(), pointer.current.x, pointer.current.y, true, left, top);
      hoverMode.current = "pointer";
    });
  }
  restoreRef.current = () => {
    if (hoverMode.current === "pointer") queueHover(pointer.current.x, pointer.current.y);
    else if (hoverMode.current === "keyboard" && document.activeElement === host.current) showKeyboardHover();
  };
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    hideHover();
    if (event.pointerType === "touch") touch.current = {x: event.clientX, y: event.clientY, moved: false};
    const chart = plot.current;
    if (event.shiftKey && chart && chart.scales.x?.min !== undefined && chart.scales.x.max !== undefined) {
      event.preventDefault(); event.stopPropagation();
      pan.current = {left: event.clientX, min: chart.scales.x.min, max: chart.scales.x.max};
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (pan.current && plot.current) {
      const origin = pan.current, chart = plot.current;
      const delta = (event.clientX - origin.left) * (origin.max - origin.min) / Math.max(1, chart.over.clientWidth);
      chart.setScale("x", {min: origin.min - delta, max: origin.max - delta}); setZoom(true); return;
    }
    if (event.pointerType === "touch") {
      if (touch.current && Math.hypot(event.clientX - touch.current.x, event.clientY - touch.current.y) > 8) touch.current.moved = true;
      return;
    }
    if (!event.buttons) queueHover(event.clientX, event.clientY);
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (pan.current) {
      pan.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (event.pointerType !== "touch" || touch.current && !touch.current.moved) queueHover(event.clientX, event.clientY);
    touch.current = null;
  }
  async function exportPng() {
    setExportError(null);
    try {
      if (!latest.current.projected.ready || latest.current.props.data.pending) throw new Error("Wait for the chart to finish loading.");
      drawRef.current();
      const chart = plot.current;
      if (!chart) throw new Error("Wait for the chart to finish loading.");
      const view = [local.smoothing ? `EMA ${local.smoothing}` : "", local.logarithmic ? "Log Y" : "", zoom.current ? "Local zoom" : ""].filter(Boolean).join(" · ");
      const blob = await chartPanelPng(chart, title, rows, view);
      if (host.current) setExportUrl(URL.createObjectURL(blob));
    } catch (error) {
      if (host.current) setExportError(error instanceof Error ? error.message : "Could not export chart.");
    }
  }
  useImperativeHandle(props.ref, () => ({exportPng}));

  drawRef.current = () => {
    const element = host.current;
    const {props: current, traces: currentTraces, local: settings, projected: numeric} = latest.current;
    if (!element || !current.active || !numeric.ready || !numeric.projection
      || !compatibleMetrics(current.data.metrics.filter(metric => metric.sources.length))) return;
    const previousScale = zoom.current && axis.current === current.data.axis && plot.current
      ? {min: plot.current.scales.x?.min, max: plot.current.scales.x?.max} : null;
    const changedAxis = axis.current !== current.data.axis;
    if (changedAxis) {setZoom(false); hideHover();}
    axis.current = current.data.axis;
    if (current.data.unavailable || !currentTraces.length) return;
    const data = numeric.projection.data;
    const nextSignature = JSON.stringify([currentTraces.map(trace => [trace.series.path, trace.series.run_id, trace.series.source_id, trace.label, trace.color, trace.dash]),
      current.spec.presentation?.style, current.spec.presentation?.lineWidth, current.spec.presentation?.points, settings.logarithmic]);
    const width = element.clientWidth;
    const height = Number.parseFloat(getComputedStyle(element).height) || 244;
    if (!width || height <= 0) return;
    const seriesOptions = (trace: ChartTrace): uPlot.Series => {
      const display = latest.current.props.spec.presentation;
      return {label: trace.label, stroke: trace.color, width: display?.lineWidth ?? 1.8, dash: trace.dash,
        ...(display?.style === "area" ? {fill: `${trace.color}24`, fillTo: settings.logarithmic ? (_chart: uPlot, _series: number, min: number) => min : 0} : {}),
        points: {show: display?.points ?? currentTraces.every(item => item.series.axes.length <= 2), size: 5}, spanGaps: false};
    };
    if (!plot.current) {
      const color = (name: string) => getComputedStyle(element).getPropertyValue(name).trim();
      let yWidth = 12, rightPadding = 10;
      plot.current = new uPlot({
        width, height, padding: [8, () => rightPadding, 0, 0],
        legend: {show: false},
        cursor: {drag: {x: true, y: false, dist: 6}, points: {size: 9, width: 2, stroke: () => color("--surface")}},
        scales: {
          x: {time: true, range: (_chart, min, max) => Number.isFinite(min) && Number.isFinite(max)
            ? min < max ? [min, max] : [min - 1, max + 1] : [0, 1]},
          y: {distr: 100, fwd: value => latest.current.local.logarithmic ? Math.log10(Math.max(Number.MIN_VALUE, value)) : value,
            bwd: value => latest.current.local.logarithmic ? 10 ** value : value,
            range: (_chart, min, max) => chartYRange(min, max, latest.current.props.spec.presentation, latest.current.local.logarithmic)},
        },
        axes: [
          {font: axisFont, size: (chart, values) => {
            let lines = 1;
            rightPadding = 10;
            if (axis.current === "wall_time" && values) {
              let last: string | undefined;
              for (const value of values) if (value != null) {last = String(value); lines = Math.max(lines, last.split("\n").length);}
              if (last != null) {
                chart.ctx.save(); chart.ctx.font = axisFont;
                for (const line of last.split("\n")) rightPadding = Math.max(rightPadding, Math.ceil(chart.ctx.measureText(line).width / 2 + 4));
                chart.ctx.restore();
              }
            }
            const size = Math.max(28, Math.ceil(5 + 11 + (lines - 1) * 11 * 1.5 + 6));
            setAxisExtra(previous => previous === size - 28 ? previous : size - 28);
            return size;
          }, gap: 4, space: 80, lineGap: 1.5, stroke: () => color("--muted"), grid: {show: false},
          ticks: {show: true, size: 4, stroke: () => color("--chart-line")}, border: {show: true, stroke: () => color("--chart-line")},
          },
          {font: axisFont, size: (chart, values, _index, cycle) => {
            chart.ctx.save(); chart.ctx.font = axisFont;
            let width = 12;
            for (const label of values ?? []) width = Math.max(width, chart.ctx.measureText(label ?? "").width + 12);
            chart.ctx.restore();
            yWidth = cycle <= 1 ? Math.ceil(width) : Math.max(yWidth, Math.ceil(width));
            return yWidth;
          }, gap: 4, space: 36, stroke: () => color("--muted"),
          values: (_chart, values) => values.map(formatNumber), filter: (_chart, values) => values,
          grid: {stroke: () => color("--chart-line"), width: 1},
          ticks: {show: true, size: 4, stroke: () => color("--chart-line")}, border: {show: true, stroke: () => color("--chart-line")}},
        ],
        series: [{}, ...currentTraces.map(seriesOptions)],
        hooks: {
          init: [chart => {
            const x = chart.axes[0]!, y = chart.axes[1]!;
            const wallSplits = x.splits, wallIncrements = x.incrs, wallValues = x.values;
            const numericSplits = y.splits, numericIncrements = y.incrs;
            if (typeof wallIncrements === "function" && typeof numericIncrements === "function")
              x.incrs = (chart, index, min, max, dimension, space) => axis.current === "elapsed" ? elapsedIncrements
                : (axis.current === "wall_time" ? wallIncrements : numericIncrements)(chart, index, min, max, dimension, space);
            if (typeof wallSplits === "function" && typeof numericSplits === "function") {
              x.splits = (chart, index, min, max, increment, space) => endpointTicks(
                (axis.current === "wall_time" ? wallSplits : numericSplits)(chart, index, min, max, increment, space),
                chart.data[0][0] ?? NaN, chart.data[0].at(-1) ?? NaN,
                min, max, (max - min) * 64 / Math.max(1, chart.bbox.width / devicePixelRatio || chart.width));
              y.splits = (chart, index, min, max, increment, space) => {
                if (!latest.current.local.logarithmic) return numericSplits(chart, index, min, max, increment, space);
                const start = Math.ceil(Math.log10(min)), end = Math.floor(Math.log10(max));
                const step = Math.max(1, Math.ceil((end - start + 1) / 12));
                const ticks = Array.from({length: 12}, (_, index) => 10 ** (start + index * step))
                  .filter(value => Number.isFinite(value) && value >= min && value <= max);
                return ticks.length ? ticks : [min, max];
              };
            }
            if (typeof wallValues === "function") x.values = (chart, splits, index, space, increment) => {
              if (axis.current === "elapsed") return splits.map(elapsedTick);
              if (axis.current !== "wall_time") return splits.map(formatNumber);
              const format = latest.current.props.range.timeFormat ?? "auto";
              return format === "auto" ? wallValues(chart, splits, index, space, increment) : wallTimeLabels(splits, format, increment);
            };
            chart.scales.x!.time = axis.current === "wall_time";
          }],
          setSelect: [chart => {if (chart.select.width >= 6) {setZoom(true); hideHover();}}],
          setScale: [(chart, scale) => {
            if (scale !== "x") return;
            const {min, max} = chart.scales.x!;
            if (min === undefined || max === undefined) return;
            const label = (value: number) => axis.current === "elapsed" ? duration(value * 1e9) : axis.current === "wall_time" ? formatTime(value * 1e9) : formatNumber(value);
            setDescription(`${axisLabel(axis.current)}: ${label(min)} to ${label(max)}.`);
          }],
        },
      }, data, element);
      signature.current = nextSignature;
      if (previousScale?.min !== undefined && previousScale.max !== undefined) plot.current.setScale("x", {min: previousScale.min, max: previousScale.max});
    } else {
      const chart = plot.current, min = chart.scales.x!.min, max = chart.scales.x!.max;
      chart.batch(() => {
        chart.scales.x!.time = axis.current === "wall_time";
        if (signature.current !== nextSignature) {
          while (chart.series.length > 1) chart.delSeries(1);
          currentTraces.forEach(trace => chart.addSeries(seriesOptions(trace)));
          signature.current = nextSignature;
        }
        chart.setData(data);
        if (!changedAxis && zoom.current && min !== undefined && max !== undefined) chart.setScale("x", {min, max});
      });
      if (chart.width !== width || chart.height !== height) chart.setSize({width, height});
      chart.redraw(true, true);
    }
    restoreRef.current();
  };

  useLayoutEffect(() => {
    const previous = selection.current;
    const retained = previous && rows.find(row => row.key === previous.key)?.trace?.series;
    const index = retained && previous ? retained.snapshot_ids.findIndex((id, index) => id === Number(previous.id) && pointId(retained, index) === previous.id) : -1;
    if (retained && previous && index >= 0 && interacted.current) selection.current = {...previous, index};
    else if (previous && interacted.current && runs.some(run => run.id === previous.runId)
      && (pending || data.unavailable || !traces.length)) {
      // Scope changes may briefly have no catalog/query evidence; retain the exact editing target.
    }
    else {
      interacted.current = false;
      const first = rows.find(row => row.trace);
      if (first?.trace) choose(first, first.trace.series.axes.length - 1, false);
      else selection.current = null;
    }
    if (!pending && !error && !data.unavailable) lastSuccess.current = Date.now();
    if (pending && !traces.length || error || data.unavailable || !active) hideHover();
    schedulePlot(scheduler.current, () => drawRef.current());
  }, [rows, data.axis, pending, data.unavailable, error, active, spec.presentation, local, range.timeFormat, props.refreshRevision, projected.ready, projected.projection]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = new ResizeObserver(() => schedulePlot(scheduler.current, () => drawRef.current()));
    resize.observe(element);
    const abort = new AbortController();
    const signal = abort.signal;
    const theme = () => schedulePlot(scheduler.current, () => drawRef.current());
    const outside = (event: globalThis.PointerEvent) => {if (event.target instanceof Node && !element.contains(event.target)) hideHover();};
    window.addEventListener("rvx:theme", theme, {signal});
    document.addEventListener("pointerdown", outside, {capture: true, signal});
    document.addEventListener("visibilitychange", hideHover, {signal});
    window.addEventListener("scroll", hideHover, {capture: true, signal});
    window.addEventListener("resize", () => {restoreRef.current();}, {signal});
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ["class", "data-theme", "style"]});
    return () => {
      abort.abort(); observer.disconnect(); resize.disconnect(); cancelPlot(scheduler.current);
      cancelAnimationFrame(hoverFrame.current); plot.current?.destroy(); plot.current = null;
    };
  }, []);
  useEffect(() => {if (!pending) setRetrying(false);}, [pending, error]);
  useEffect(() => {
    if (!exportUrl) return;
    download.current?.click();
    return () => URL.revokeObjectURL(exportUrl);
  }, [exportUrl]);

  const unrecorded = rows.filter(row => row.legendState === "not recorded").length;
  const status = retrying && pending ? "Retrying…" : error ? lastSuccess.current ? "Refresh failed" : "Request failed" : pending
    ? traces.length ? "" : "Loading…" : data.unavailable ? data.truncated ? "Unavailable" : "Not recorded"
    : legendHidden && unrecorded ? `${unrecorded} not recorded` : "";
  const empty = !runs.length ? "Select runs to show observations." : pending && !traces.length ? "Loading observations…"
    : data.unavailable ? data.truncated ? "This field is unavailable in the partial catalog." : "No numeric observations recorded for this field."
    : error && !traces.length ? error : traces.length ? "No numeric values in this range" : "No observations in this range";
  const announcement = hover?.keyboard ? `${hover.heading}. ${hover.rows.map(row => `${row.selected ? "Selected. " : ""}${row.label}: ${row.value}${row.time ? `, ${row.time}` : ""}.`).join(" ")}` : "";
  return <PanelFrame spec={spec} title={title} unit={unit ?? (metrics.length > 1 ? "unit not declared" : null)}
    status={status} path={spec.path} loaded={!pending}
    menuActions={zoomed && traces.length ? [{label: "Reset zoom", onSelect: resetZoom}] : []}
    refreshing={pending} className={`react-chart-panel${error ? " chart-failed" : ""}`} onAction={action => {hideHover(); onAction(action);}}
    actions={<>
      {zoomed && <span className="chart-zoom-state" title="Local zoom · double-click the plot to reset">Zoomed</span>}
      <Button variant="ghost" size="icon-xs" aria-label="Chart settings" title="Edit chart" onClick={() => {hideHover(); onAction("edit");}}><Settings2 /></Button>
    </>}>
    <>
      <div className="chart-legend" hidden={legendHidden}>
        {rows.map(row => <span key={row.key} className={`legend-item${row.dashed ? " dashed" : ""}`} style={runStyle(row.color)}>
          <i className="legend-swatch" /><span>{row.label}</span>
          {row.legendState && <span className="muted" data-pending={row.legendState === "loading" ? "true" : undefined}>{row.legendState}</span>}
        </span>)}
      </div>
      <div ref={host} className="chart-host" role="img" tabIndex={0} aria-label={`${title} chart. ${keyboardHelp}`}
        aria-description={description || undefined} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
        aria-describedby={hover?.visible ? tooltipId : undefined} hidden={!traces.length || data.unavailable}
        style={{"--chart-axis-extra": `${axisExtra}px`} as CSSProperties}
        onKeyDown={moveObservation} onDoubleClick={resetZoom} onBlur={hideHover}
        onPointerDownCapture={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
        onPointerCancel={() => {touch.current = null; pan.current = null; hideHover();}}
        onPointerLeave={event => {if (event.pointerType !== "touch" && hoverMode.current !== "keyboard" && !pan.current) hideHover();}} />
      {(!hasNumeric || data.unavailable) && <div className="chart-empty">{empty}</div>}
      {error && !(retrying && pending) && <div className="chart-feedback" role="status">
        <span>{lastSuccess.current ? `Last loaded ${new Date(lastSuccess.current).toLocaleTimeString()} · ` : ""}{error}</span>
        <Button variant="ghost" size="sm" className="text-button" onClick={retry}>Retry</Button>
      </div>}
      {exportError && <p className="chart-feedback" role="alert">{exportError}</p>}
      <span className="chart-announcement" role="status" aria-atomic="true">{announcement}</span>
      {exportUrl && <a ref={download} className="text-button" href={exportUrl} download={`${title.replace(/[^a-z0-9._-]+/gi, "-") || "chart"}.png`}
        onClick={() => setTimeout(() => setExportUrl(null), 0)}>Download chart PNG</a>}
      {hover && <ChartTooltip hover={hover} id={tooltipId} />}
    </>
  </PanelFrame>;
}
