import type uPlot from "uplot";

export interface NumericChartSeries {axes: number[]; values: (number | null)[]}
export interface CursorCoordinates {axes: number[]; indices: number[]}
export interface ChartProjection {data: uPlot.AlignedData; coordinates: CursorCoordinates[]}
export interface ChartProjectionRequest {
  type: "project";
  generation: number;
  series: NumericChartSeries[];
  axis: string;
  smoothing: number;
  logarithmic: boolean;
}
export type ChartProjectionMessage = ChartProjectionRequest | {type: "cancel"; generation: number};
export type ChartProjectionResponse = {type: "projected"; generation: number; projection: ChartProjection}
  | {type: "error"; generation: number; error: string};

export function nearestIndex(values: number[], target: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1; else hi = mid;
  }
  if (!lo) return 0;
  if (lo === values.length) return lo - 1;
  return target - values[lo - 1]! <= values[lo]! - target ? lo - 1 : lo;
}

export function cursorCoordinates(axes: number[]): CursorCoordinates {
  const last = new Map(axes.map((axis, index) => [axis, index]));
  const sorted = [...last.keys()].sort((a, b) => a - b);
  return {axes: sorted, indices: sorted.map(axis => last.get(axis)!)};
}

/** Reset smoothing at actual null observations, not another reporter's alignment slots. */
export function smoothValues(values: (number | null)[], smoothing: number): (number | null)[] {
  if (smoothing <= 0) return values;
  let previous: number | null = null;
  const weight = Math.min(.99, smoothing);
  return values.map(value => {
    if (value === null) {previous = null; return null;}
    previous = previous === null ? value : previous * weight + value * (1 - weight);
    return previous;
  });
}

export function alignedData(series: NumericChartSeries[], axis: string, smoothing = 0, logarithmic = false): uPlot.AlignedData {
  const axes = [...new Set(series.flatMap(item => item.axes))].sort((a, b) => a - b);
  return [
    axes.map(value => axis === "wall_time" || axis === "elapsed" ? value / 1e9 : value),
    ...series.map(item => {
      const smoothed = smoothValues(item.values, smoothing);
      const values = new Map(item.axes.map((x, index) => [x, smoothed[index] ?? null]));
      return axes.map(x => {
        const value = values.get(x);
        return logarithmic && value != null && value <= 0 ? null : value;
      });
    }),
  ];
}

/** Only numeric arrays cross the worker boundary; exact provenance stays on the main thread. */
export function projectionRequest(generation: number, series: NumericChartSeries[], axis: string,
  smoothing: number, logarithmic: boolean): ChartProjectionRequest {
  return {type: "project", generation, series: series.map(({axes, values}) => ({axes, values})), axis, smoothing, logarithmic};
}

export function projectChart(request: ChartProjectionRequest): ChartProjection {
  if (!Number.isFinite(request.smoothing) || request.smoothing < 0 || request.smoothing > .99)
    throw new Error("EMA smoothing must be between 0 and 0.99.");
  for (const series of request.series) {
    if (series.axes.some(axis => !Number.isFinite(axis)) || series.values.some(value => value !== null && !Number.isFinite(value)))
      throw new Error("Chart projection requires finite numeric coordinates and values.");
  }
  return {
    data: alignedData(request.series, request.axis, request.smoothing, request.logarithmic),
    coordinates: request.series.map(series => cursorCoordinates(series.axes)),
  };
}
