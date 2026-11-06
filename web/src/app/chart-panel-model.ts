import uPlot from "uplot";
import type {ChartMetric, SnapshotQuerySeries} from "../domain/snapshots";
import type {ExperimentRun} from "../domain/types";
import {formatNumber, metricName, pointId, reporters, type ChartPresentation} from "./model";
import {elapsedTick} from "./time";
import {cursorCoordinates, type CursorCoordinates} from "./chart-projection";
export {alignedData, cursorCoordinates, nearestIndex, smoothValues} from "./chart-projection";

export interface ChartTrace {
  series: SnapshotQuerySeries;
  metric: ChartMetric;
  label: string;
  color: string;
  dash: number[];
  coordinates: ReturnType<typeof cursorCoordinates>;
}
export interface ChartRow {
  key: string;
  label: string;
  color: string;
  dashed: boolean;
  state: string;
  legendState: string;
  trace?: ChartTrace;
}

export function chartRows(metrics: ChartMetric[], series: SnapshotQuerySeries[], runs: ExperimentRun[],
  pending: boolean, colorFor: (id: string) => string, labelFor: (run: ExperimentRun) => string,
  coordinates?: ReadonlyMap<SnapshotQuerySeries, CursorCoordinates> | null): ChartRow[] {
  return metrics.flatMap((metric, metricIndex) => runs.flatMap(run => {
    const runName = labelFor(run), color = colorFor(run.id);
    const sources = reporters(metric, run.id);
    const prefix = metrics.length > 1 ? `${metricName(metric)} · ` : "";
    if (!metric.run_ids.includes(run.id) || !sources.length) {
      const state = pending ? "loading" : "not recorded";
      return [{key: JSON.stringify([metric.path, run.id]), label: prefix + runName, color, dashed: false, state, legendState: state}];
    }
    return sources.map((source, index) => {
      const item = series.find(item => item.path === metric.path && item.run_id === run.id && item.source_id === source.source_id);
      const reporter = sources.length > 1
        ? `${runs.length > 1 || metrics.length > 1 ? `${runName} · ` : ""}${source.label}${sources.filter(s => s.label === source.label).length > 1 ? ` (${source.role} ${index + 1})` : ""}`
        : runName;
      const label = prefix + reporter;
      const dash = metricIndex ? [6 + metricIndex * 2, 3, ...(index ? [2, 3] : [])] : index ? [3, 3] : [];
      return {
        key: JSON.stringify([metric.path, run.id, source.source_id]), label, color, dashed: Boolean(dash.length),
        state: pending ? "loading" : "no observations in range",
        legendState: pending && !item ? "loading" : item?.values.some(value => value !== null) ? "" : "no numeric values",
        ...(item?.axes.length ? {trace: {series: item, metric, label, color, dash,
          coordinates: coordinates === undefined ? cursorCoordinates(item.axes) : coordinates?.get(item) ?? {axes: [], indices: []}}} : {}),
      };
    });
  }));
}

const shortDate = new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric", year: "numeric"});
const shortClock = new Intl.DateTimeFormat(undefined, {hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"});
const preciseClock = new Intl.DateTimeFormat(undefined, {hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23"});

export function coordinateText(axis: string, value: number, reference?: number): string {
  if (axis === "elapsed") return elapsedTick(value / 1e9);
  if (axis !== "wall_time") return String(value);
  const ms = value / 1e6, date = new Date(ms);
  const sameDay = reference !== undefined && date.toDateString() === new Date(reference / 1e6).toDateString();
  return `${sameDay ? "" : `${shortDate.format(ms)} · `}${date.getMilliseconds() ? preciseClock.format(ms) : shortClock.format(ms)}`;
}

export function pointText(trace: ChartTrace, index: number, reference: number, axis: string): {value: string; time: string; id: string} {
  const {series, metric} = trace, value = series.values[index], coordinate = series.axes[index]!;
  let time = "";
  if (coordinate !== reference) {
    const label = coordinateText(axis, coordinate, reference);
    time = axis === "wall_time" && label === coordinateText(axis, reference, reference)
      ? `${coordinate > reference ? "+" : "−"}${elapsedTick(Math.abs(coordinate - reference) / 1e9)}`
      : `at ${label}`;
  }
  return {
    value: `${value === null ? "null" : value === undefined ? "missing" : formatNumber(value)}${typeof value === "number" && metric.unit ? ` ${metric.unit}` : ""}`,
    time, id: pointId(series, index),
  };
}

export function chartYRange(min: number, max: number, display?: ChartPresentation, logarithmic = false): [number, number] {
  if (logarithmic) {
    const explicitLower = display?.yMin !== undefined && display.yMin > 0 ? display.yMin : undefined;
    let lower = explicitLower ?? (Number.isFinite(min) && min > 0 ? Math.max(Number.MIN_VALUE, min / 1.1) : .1);
    let upper = display?.yMax !== undefined && display.yMax > 0 ? display.yMax
      : Number.isFinite(max) && max > 0 ? Math.min(Number.MAX_VALUE, max * 1.1) : Math.min(Number.MAX_VALUE, lower * 10);
    if (lower >= upper) {
      if (explicitLower === undefined) lower = Math.max(Number.MIN_VALUE, upper / 10);
      else upper = Math.min(Number.MAX_VALUE, lower * 10);
    }
    if (lower >= upper) {
      if (upper === Number.MIN_VALUE) upper *= 10;
      else lower /= 10;
    }
    return [lower, upper];
  }
  const auto = Number.isFinite(min) && Number.isFinite(max) ? uPlot.rangeNum(min, max, .1, true) : [0, 1];
  let lower = display?.yMin ?? auto[0] ?? 0, upper = display?.yMax ?? auto[1] ?? 1;
  if (lower >= upper) {
    if (display?.yMin === undefined) lower = upper - Math.max(Math.abs(upper) * .1, 1);
    else upper = lower + Math.max(Math.abs(lower) * .1, 1);
  }
  return [lower, upper];
}
