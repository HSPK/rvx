import {describe, expect, it, vi, afterEach} from "vitest";
import {alignedData, cursorCoordinates, nearestIndex} from "./chart";
import {axisLabel, defaultCharts, filteredRuns, filtersFrom, initialRange, metricName, partitionCatalogPaths, pointId, rangeBounds, reporters, routeFrom, RunColors, runColor, workspaceUrl} from "./model";
import {matchingMetrics, metricEntries} from "./metric-catalog";
import {parseExactJson} from "../core/exact-json";
import type {ChartCatalog, ChartMetric, SnapshotQuerySeries} from "../domain/snapshots";

const metric: ChartMetric = {path: "/loss", name: "Loss", unit: null, group: "Training", run_ids: ["r"],
  sources: [{run_id: "r", source_id: "a", label: "Learner", role: "learner", rank: 0, node_id: null, primary: true, latest_value: .2, observed_at_ns: 8e12}]};
const catalog: ChartCatalog = {runs: [{run_id: "r", first_observed_at_ns: 1e12, last_observed_at_ns: 8e12, snapshot_count: 20}], metrics: [metric], defaults: ["/loss"], axes: ["wall_time", "elapsed", "step"], truncated: false};
const series = (axes: number[], values: (number | null)[]): SnapshotQuerySeries => ({run_id: "r", source_id: "a", path: "/loss", snapshot_ids: axes, sequences: axes, axes, observed_at_ns: axes, source_session_ids: axes.map(() => "session"), values});
afterEach(() => vi.unstubAllGlobals());

describe("charts-first data and navigation", () => {
  it("keeps explicit colors across workspaces and avoids case-insensitive automatic collisions", () => {
    const colors = new RunColors(), automatic = runColor("automatic");
    colors.assign(["custom", "automatic"], {custom: automatic.toUpperCase()});
    expect(colors.get("custom")).toBe(automatic.toUpperCase());
    expect(colors.get("automatic").toLowerCase()).not.toBe(automatic);
    colors.assign(["another"]);
    expect(colors.get("custom")).toBe(automatic.toUpperCase());
    colors.assign(["custom"], {});
    expect(colors.get("custom")).toBe(runColor("custom"));
  });
  it("shows declared units once without inventing metric labels", () => {
    expect(metricName({name: "CPU Percent", unit: "%"})).toBe("CPU");
    expect(metricName({name: "Network RX Mbps", unit: "Mbps"})).toBe("Network RX");
    expect(metricName({name: "GPU Memory Used Bytes", unit: "bytes"})).toBe("GPU Memory Used");
    expect(metricName({name: "Percent", unit: "%"})).toBe("Percent");
    expect(metricName({name: "Reward", unit: null})).toBe("Reward");
    expect(metricName({name: "CPU Percent", unit: null})).toBe("CPU Percent");
  });
  it("ranks available metrics before diagnostic and added fields, retaining searchable identity", () => {
    const useful = {...metric, path: "/metrics/gpu~1percent", name: "GPU Percent", group: "Resources", unit: "%"};
    const diagnostic = {...useful, path: "/collectors/gpu/percent"};
    const entries = metricEntries({...catalog, metrics: [diagnostic, useful, metric]}, [{path: "/loss", size: "normal"}]);
    expect(entries.map(entry => entry.group)).toEqual(["Resources", "Diagnostics", "Already added"]);
    expect(entries[0]!.name).toBe("GPU");
    expect(entries[0]!.context).toBe(useful.path);
    expect(entries[1]!.context).toBe(diagnostic.path);
    expect(entries[0]!.search).toContain("/metrics/gpu~1percent");
    expect(entries[0]!.search).toContain("learner");
    expect(entries[2]!.added).toBe(true);
  });
  it("ranks GPU names ahead of queue paths that only incidentally contain GPU", () => {
    const metrics = [
      {...metric, path: "/metrics/cluster_gpu~1queue~1allocated_cpus", name: "Cluster GPU Queue Allocated CPUs", group: "Pipeline"},
      {...metric, path: "/metrics/gpu~10~1memory_percent", name: "GPU 0 Memory Percent", group: "Resources", unit: "%"},
    ];
    const entries = metricEntries({...catalog, metrics}, []);
    expect(matchingMetrics(entries, "gpu").map(entry => entry.name)).toEqual(["GPU 0 Memory", "Cluster GPU Queue Allocated CPUs"]);
    expect(matchingMetrics(entries, "gpu memory")).toHaveLength(1);
    expect(matchingMetrics(entries, "")).toBe(entries);
  });
  it("defaults uniformly to elapsed observations regardless of run count", () => {
    expect(initialRange(new URL("https://rvx/rvx?runs=r"))).toEqual({axis: "elapsed", window: "all"});
    expect(initialRange(new URL("https://rvx/rvx?runs=r,s"))).toEqual({axis: "elapsed", window: "all"});
    expect(initialRange(new URL("https://rvx/rvx?runs="))).toEqual({axis: "elapsed", window: "all"});
    expect(initialRange(new URL("https://rvx/rvx?axis=wall_time&range=3600&live=0"))).toEqual({axis: "wall_time", window: "3600"});
    expect(axisLabel("elapsed")).toBe("Since first observation");
    expect(rangeBounds({axis: "wall_time", window: "3600"}, catalog)).toEqual({from: 4.4e12, to: 8e12});
    expect(rangeBounds({axis: "elapsed", window: "3600"}, catalog)).toEqual({from: 3.4e12, to: 7e12});
  });
  it("never injects time bounds into logical axes", () => {
    expect(rangeBounds({axis: "step", window: "3600"}, catalog)).toEqual({});
    expect(rangeBounds({axis: "step", window: "custom", from: 10, to: 20}, catalog)).toEqual({from: 10, to: 20});
    expect(initialRange(new URL("https://rvx/rvx?axis=step&range=3600")).window).toBe("all");
  });
  it("accepts one workspace route and distinguishes absent, empty, and unavailable selection identities", () => {
    expect(routeFrom(new URL("https://rvx/rvx"))).toEqual({kind: "workspace", runIds: null});
    expect(routeFrom(new URL("https://rvx/rvx?runs="))).toEqual({kind: "workspace", runIds: []});
    for (const path of ["/ryx", "/rvx/system", "/rvx/boards", "/rvx/source/x", "/rvx/projects/x", "/rvx/compare?runs=a,b", "/unknown", "/rvx/runs/a"]) expect(routeFrom(new URL(`https://rvx${path}`))).toEqual({kind: "missing"});
    expect(routeFrom(new URL("https://rvx/rvx?runs=a,b,a"))).toEqual({kind: "workspace", runIds: ["a", "b"]});
    expect(routeFrom(new URL("https://rvx/rvx?runs=unknown"))).toEqual({kind: "workspace", runIds: ["unknown"]});
    expect(routeFrom(new URL("https://rvx/rvx?runs=a,b,c,d,e"))).toEqual({kind: "workspace", runIds: ["a", "b", "c", "d", "e"]});
    vi.stubGlobal("location", {origin: "https://rvx"});
    expect(workspaceUrl(["a", "b"], {axis: "step", window: "custom", from: 10, to: 30}, {project: "p", experiment: "e", status: "", search: "loss"})).toBe("/rvx?runs=a%2Cb&axis=step&range=custom&from=10&to=30&project=p&experiment=e&q=loss");
    expect(workspaceUrl([])).toBe("/rvx?runs=");
    expect(filtersFrom(new URL("https://rvx/rvx?project=p&experiment=e&status=running&q=trial"))).toEqual({project: "p", experiment: "e", status: "running", search: "trial"});
  });
  it("filters candidate runs independently and never falls back outside a requested scope", () => {
    const experiments = [{id: "e1", project_id: "p1", name: "Training", created_at_ns: 0}, {id: "e2", project_id: "p2", name: "Evaluation", created_at_ns: 0}];
    const runs = [
      {id: "r1", experiment_id: "e1", name: "trial one", status: "running" as const, config_json: "{}", created_at_ns: 0, updated_at_ns: 2},
      {id: "r2", experiment_id: "e2", name: "trial two", status: "finished" as const, config_json: "{}", created_at_ns: 0, updated_at_ns: 1},
    ];
    const filters = {project: "", experiment: "e2", status: "", search: ""};
    expect(filteredRuns(runs, experiments, filters).map(run => run.id)).toEqual(["r2"]);
    expect(filteredRuns(runs, experiments, {...filters, project: "p1"})).toEqual([]);
    expect(filteredRuns(runs, experiments, {...filters, experiment: "", search: "training"}).map(run => run.id)).toEqual(["r1"]);
    expect(runs).toHaveLength(2);
  });
  it("selects declared primary reporters, never implicitly averages ambiguous metrics", () => {
    const ambiguous: ChartMetric = {...metric, sources: [{...metric.sources[0]!, primary: false}, {...metric.sources[0]!, source_id: "b", primary: false}]};
    expect(reporters(ambiguous, "r")).toHaveLength(2);
    expect(defaultCharts({...catalog, metrics: [ambiguous]})).toEqual([]);
    expect(defaultCharts(catalog)).toEqual([{path: "/loss", size: "normal"}]);
    expect(reporters({...ambiguous, sources: [metric.sources[0]!, ambiguous.sources[1]!]}, "r").map(source => source.source_id)).toEqual(["a"]);
  });
  it("partitions absent saved fields before constructing a query batch", () => {
    expect(partitionCatalogPaths(["/saved/absent", "/loss"], catalog)).toEqual({metrics: [metric], missing: ["/saved/absent"]});
    expect(partitionCatalogPaths(["/saved/absent"], catalog)).toEqual({metrics: [], missing: ["/saved/absent"]});
  });
  it("preserves null observation gaps separately from undefined interleaving slots", () => {
    expect(alignedData([series([1, 3, 5], [2, null, 4]), series([2, 4], [7, 8])], "step")).toEqual([
      [1, 2, 3, 4, 5], [2, undefined, null, undefined, 4], [undefined, 7, undefined, 8, undefined],
    ]);
    expect(nearestIndex([1, 3, 5], 4.7)).toBe(2);
    expect(nearestIndex([], 1)).toBe(0);
  });
  it("keeps run colors independent of path, reporter and data ordering", () => {
    expect(runColor("run-1")).toBe(runColor("run-1"));
    expect(runColor("run-1")).not.toBe(runColor("run-2"));
    const colors = new RunColors();
    colors.assign(["run-1", "run-7", "run-13", "run-19"]);
    expect(new Set(["run-1", "run-7", "run-13", "run-19"].map(id => colors.get(id))).size).toBe(4);
    const original = colors.get("run-1");
    colors.assign(["run-7", "run-1"]);
    expect(colors.get("run-1")).toBe(original);
  });
  it("selects the actually rendered observation when logical axes reset or repeat", () => {
    expect(cursorCoordinates([10, 20, 0, 10])).toEqual({axes: [0, 10, 20], indices: [2, 3, 1]});
    expect(alignedData([series([10, 20, 0, 10], [1, 2, 3, 4])], "step")).toEqual([[0, 10, 20], [3, 4, 2]]);
  });
  it("preserves actual 64-bit point IDs", () => {
    const value = parseExactJson<SnapshotQuerySeries>('{"snapshot_ids":[9007199254740993]}');
    expect(pointId(value, 0)).toBe("9007199254740993");
  });
});
