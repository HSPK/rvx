import {describe, expect, it, vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {Tooltip} from "radix-ui";
import type {ChartMetric, SnapshotQuerySeries} from "../domain/snapshots";
import type {ExperimentRun} from "../domain/types";
import {parseExactJson} from "../core/exact-json";
import {ChartPanel} from "./chart-panel";
import {PanelInteractionsContext} from "./panel-frame";
import type {ChartPanelProps} from "./panel-types";
import {alignedData, chartRows, chartYRange, cursorCoordinates, pointText, smoothValues} from "./chart-panel-model";

const metric: ChartMetric = {path: "/loss", name: "Loss", unit: "ms", group: "Training", run_ids: ["run"],
  sources: [{run_id: "run", source_id: "a", label: "Learner", role: "learner", rank: 0, node_id: null,
    primary: true, latest_value: 2, observed_at_ns: 2e9}]};
const run: ExperimentRun = {id: "run", experiment_id: "experiment", name: "Baseline", status: "running",
  config_json: "{}", created_at_ns: 0, updated_at_ns: 2e9};
const series = (axes: number[], values: (number | null)[], source_id = "a"): SnapshotQuerySeries =>
  ({run_id: "run", source_id, path: "/loss", snapshot_ids: axes.map((_, index) => index + 1), sequences: axes,
    axes, observed_at_ns: axes, source_session_ids: axes.map(() => "session"), values});
const color = () => "#123456", label = (run: ExperimentRun) => run.name;

describe("React chart data and readouts", () => {
  it("smooths actual observations while preserving null gaps and absent alignment slots", () => {
    const first = series([0, 2, 4, 6], [10, 20, null, 40]);
    const second = series([1, 3], [100, 200], "b");
    expect(smoothValues(first.values, .5)).toEqual([10, 15, null, 40]);
    expect(alignedData([first, second], "step", .5)).toEqual([
      [0, 1, 2, 3, 4, 6], [10, undefined, 15, undefined, null, 40], [undefined, 100, undefined, 150, undefined, undefined],
    ]);
    expect(first.values).toEqual([10, 20, null, 40]);
  });

  it("navigates the last actual observation at repeated logical coordinates", () => {
    expect(cursorCoordinates([10, 20, 0, 10])).toEqual({axes: [0, 10, 20], indices: [2, 3, 1]});
    expect(alignedData([series([10, 20, 0, 10], [1, 2, 3, 4])], "step")).toEqual([[0, 10, 20], [3, 4, 2]]);
    expect(alignedData([series([1e9, 2e9], [1, 2])], "elapsed")[0]).toEqual([1, 2]);
  });

  it("separates unavailable runs, primary reporters, and actual null observations", () => {
    const absent = {...run, id: "absent", name: "Not recorded"};
    const input = series([0, 1e9], [null, 2]);
    const secondary = {...metric.sources[0]!, source_id: "secondary", primary: false};
    const rows = chartRows([{...metric, sources: [...metric.sources, secondary]}], [input], [run, absent], false, color, label);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.trace?.series).toBe(input);
    expect(rows[0]!.legendState).toBe("");
    expect(rows[1]!.state).toBe("not recorded");
    expect(pointText(rows[0]!.trace!, 0, 0, "elapsed").value).toBe("null");
    expect(pointText(rows[0]!.trace!, 1, 0, "elapsed")).toMatchObject({value: "2 ms", time: "at 1s", id: "2"});
  });

  it("keeps ambiguous reporters distinct and retains exact snapshot IDs in raw readouts", () => {
    const ambiguous = {...metric, sources: [{...metric.sources[0]!, primary: false},
      {...metric.sources[0]!, source_id: "b", primary: false}]};
    const input = parseExactJson<SnapshotQuerySeries>(JSON.stringify(series([0], [3])).replace('"snapshot_ids":[1]', '"snapshot_ids":[9007199254740993]'));
    const rows = chartRows([ambiguous], [input, series([1], [4], "b")], [run], false, color, label);
    expect(rows[0]!.label).toBe("Learner (learner 1)");
    expect(rows[1]!.label).toBe("Learner (learner 2)");
    expect(rows[1]!.dashed).toBe(true);
    expect(pointText(rows[0]!.trace!, 0, 0, "step").id).toBe("9007199254740993");
  });

  it("uses explicit Y bounds and valid positive log ranges without changing stored values", () => {
    expect(chartYRange(1, 5, {yMin: 0, yMax: 10})).toEqual([0, 10]);
    expect(chartYRange(1, 5, {yMin: 10})).toEqual([10, 11]);
    expect(chartYRange(NaN, NaN, undefined, true)).toEqual([.1, 1]);
    const log = chartYRange(1, 2, {yMin: 10}, true);
    expect(log[0]).toBe(10); expect(log[1]).toBeGreaterThan(log[0]);
    expect(chartYRange(100, 200, {yMax: 1}, true)).toEqual([.1, 1]);
    const extreme = chartYRange(Number.MIN_VALUE, Number.MAX_VALUE, undefined, true);
    expect(extreme).toEqual([Number.MIN_VALUE, Number.MAX_VALUE]);
    const input = series([0, 1, 2], [-1, 0, 2]);
    expect(alignedData([input], "step", 0, true)).toEqual([[0, 1, 2], [null, null, 2]]);
    expect(input.values).toEqual([-1, 0, 2]);
  });
});

describe("React-owned chart surface", () => {
  function render(overrides: Partial<ChartPanelProps["data"]> = {}) {
    const reads = {query: vi.fn()};
    const props = {
      spec: {kind: "chart", id: "chart", sectionId: "section", path: "/loss", size: "normal"},
      catalog: {runs: [], metrics: [metric], defaults: ["/loss"], axes: ["elapsed"], truncated: false},
      runs: [run], range: {axis: "elapsed", window: "all"}, reads,
      colorFor: color, labelFor: label, active: true, refreshRevision: 0,
      onAction: vi.fn(), onChange: vi.fn(), onRetry: vi.fn(),
      data: {metrics: [metric], series: [], axis: "elapsed", pending: false, error: null, unavailable: false, truncated: false, ...overrides},
    } as unknown as ChartPanelProps;
    const html = renderToStaticMarkup(<Tooltip.Provider>
      <PanelInteractionsContext value={{workspace: true, register: () => {}, handle: () => ({}), expanded: null,
        dragging: null, dropBefore: null, dropAfter: null, hidden: new Set()}}>
        <ChartPanel {...props} />
      </PanelInteractionsContext>
    </Tooltip.Provider>);
    expect(reads.query).not.toHaveBeenCalled();
    return html;
  }
  it("renders loading and chart controls without constructing a legacy DOM renderer or querying", () => {
    const html = render({pending: true});
    expect(html).toContain('data-panel-id="chart"');
    expect(html).toContain("Loading observations");
    expect(html).toContain('aria-label="Chart settings"');
    expect(html).not.toContain("chart-failed");
  });
  it("distinguishes partial-catalog unavailability from a retryable request failure", () => {
    expect(render({unavailable: true, truncated: true})).toContain("unavailable in the partial catalog");
    const html = render({error: "Network unavailable"});
    expect(html).toContain("chart-failed");
    expect(html).toContain("Network unavailable");
    expect(html).toContain(">Retry<");
  });
});
