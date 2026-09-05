import uPlot from "uplot";

export interface ChartSeries {
  source_id: string;
  axes: number[];
  values: Array<number | null>;
  label: string;
}

export type ChartSize = "compact" | "large" | "section";

interface ChartBinding {
  host: HTMLElement;
  header: HTMLElement;
  title: string;
  legend: HTMLElement;
  labels: string;
  size: ChartSize;
  axis: string;
  plot: uPlot | null;
  observer: ResizeObserver | null;
  seriesCount: number;
}

type QuerySeries = ChartSeries[];

/**
 * Owns chart DOM, uPlot instances, resize observers, and aligned data updates.
 */
export class ChartController {
  private readonly bindings = new Map<string, ChartBinding>();
  private disposed = false;

  constructor(
    private readonly labelForSeries: (series: QuerySeries[number]) => string = series => series.label,
  ) {}

  /** Creates one chart card and schedules its first plot update. */
  create(
    title: string,
    axis: string,
    series: QuerySeries,
    size: ChartSize = "compact",
    key = title,
    showHeader = true,
  ): HTMLElement {
    const card = document.createElement("section");
    card.className = `rvx-chart rvx-chart-${size}`;
    const header = document.createElement("header");
    header.textContent = `${title} · ${axis}`;
    const legend = document.createElement("div");
    legend.className = "rvx-chart-legend";
    for (const [index, item] of series.entries()) {
      const label = document.createElement("span");
      label.style.setProperty("--rvx-series-color", chartColor(index));
      label.textContent = this.labelForSeries(item);
      legend.append(label);
    }
    const host = document.createElement("div");
    host.className = "rvx-chart-host";
    card.append(
      ...(showHeader ? [header] : []),
      legend,
      host,
    );
    this.bindings.set(key, {
      host,
      header,
      title,
      legend,
      labels: JSON.stringify(series.map(item => this.labelForSeries(item))),
      size,
      axis,
      plot: null,
      observer: null,
      seriesCount: 0,
    });
    requestAnimationFrame(() => this.update(key, series, axis));
    return card;
  }

  /** Updates one plot in place or rebuilds it when its shape changes. */
  update(key: string, series: QuerySeries, axis: string): void {
    const binding = this.bindings.get(key);
    if (!binding || this.disposed) return;
    binding.header.textContent = `${binding.title} · ${axis === "wall_time" ? "observed time" : axis}`;
    const labels = JSON.stringify(series.map(item => this.labelForSeries(item)));
    if (labels !== binding.labels) {
      binding.labels = labels;
      binding.legend.replaceChildren(...series.map((item, index) => {
        const label = document.createElement("span");
        label.style.setProperty("--rvx-series-color", chartColor(index));
        label.textContent = this.labelForSeries(item);
        return label;
      }));
    }
    if (!series.length) {
      binding.observer?.disconnect();
      binding.observer = null;
      binding.plot?.destroy();
      binding.plot = null;
      binding.seriesCount = 0;
      binding.host.textContent = "No data";
      return;
    }
    const data = alignedData(series, axis);
    if (
      binding.plot &&
      binding.seriesCount === series.length &&
      binding.axis === axis
    ) {
      binding.plot.setData(data);
      return;
    }
    binding.observer?.disconnect();
    binding.plot?.destroy();
    binding.host.replaceChildren();
    const plot = new uPlot(
      {
        width: Math.max(220, binding.host.clientWidth),
        height: chartHeight(binding),
        legend: {show: false},
        cursor: {drag: {x: true, y: false}},
        scales: {x: {time: axis === "wall_time"}},
        axes: [
          {
            font: "9px ui-monospace, monospace",
            size: 28,
            space: 65,
            stroke: "#8493a7",
            grid: {stroke: "#263549", width: 1},
            ticks: {stroke: "#3b4d66", width: 1},
          },
          {
            font: "9px ui-monospace, monospace",
            size: 46,
            stroke: "#8493a7",
            grid: {stroke: "#263549", width: 1},
            ticks: {stroke: "#3b4d66", width: 1},
          },
        ],
        series: [
          {},
          ...series.map((item, index) => ({
            label: this.labelForSeries(item),
            stroke: chartColor(index),
            width: 1.2,
            points: {show: false},
            spanGaps: false,
          })),
        ],
      },
      data,
      binding.host,
    );
    binding.plot = plot;
    binding.axis = axis;
    binding.seriesCount = series.length;
    binding.observer = new ResizeObserver(() => {
      plot.setSize({
        width: Math.max(220, binding.host.clientWidth),
        height: chartHeight(binding),
      });
    });
    binding.observer.observe(binding.host);
  }

  /** Destroys all plots and observers owned by this controller. */
  destroy(): void {
    this.disposed = true;
    for (const binding of this.bindings.values()) {
      binding.observer?.disconnect();
      binding.plot?.destroy();
    }
    this.bindings.clear();
  }
}

/** Aligns sparse series on one sorted axis for uPlot. */
export function alignedData(series: QuerySeries, axis: string): uPlot.AlignedData {
  const axes = [...new Set(series.flatMap(item => item.axes))]
    .sort((left, right) => left - right);
  const normalizedAxes = normalizeAxisValues(axis, axes);
  return [
    normalizedAxes,
    ...series.map(item => {
      const values = new Map(
        item.axes.map((value, index) => [value, item.values[index] ?? null]),
      );
      // uPlot skips undefined alignment slots; only actual null observations break lines.
      return axes.map(value => values.get(value));
    }),
  ];
}

/** Converts wall-time nanoseconds to the seconds expected by uPlot. */
export function normalizeAxisValues(
  axis: string,
  values: number[],
): number[] {
  return axis === "wall_time"
    ? values.map(value => value / 1_000_000_000)
    : [...values];
}

/** Returns the stable palette color for one series index. */
function chartColor(index: number): string {
  return ["#8fa9bc", "#7eaa94", "#c2a26d", "#a699b3", "#bd8585"][
    index % 5
  ]!;
}

/** Computes the plot height from its card size contract. */
function chartHeight(binding: ChartBinding): number {
  if (binding.size === "large") return 300;
  if (binding.size === "section") {
    return Math.max(90, binding.host.clientHeight);
  }
  return 140;
}
