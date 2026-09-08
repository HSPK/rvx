import {describe, expect, it} from "vitest";
import type {SnapshotAggregateGroup, SnapshotAggregateValue, SnapshotBarView, SnapshotRecordsResponse, SnapshotStatusView} from "../../domain/snapshot-views";
import type {TableCell} from "../../domain/tables";
import type {SnapshotVisualPanelSpec} from "../panels";
import {barGeometry, barMeasures} from "./bar";
import {cellText, finiteNumber} from "./details";
import {nativeFilters, visualQueryKey} from "./panel";
import {gridGeometry, statusColor, statusKey, statusTasks} from "./status";

const cell = (text: string, kind: TableCell["kind"] = "number"): TableCell => ({kind, text, truncated: false});
const aggregate = (text: string, kind: TableCell["kind"] = "number"): SnapshotAggregateValue => ({value: cell(text, kind), count: 1, missing: 0, non_numeric: 0, approximate: false});
const bar: SnapshotBarView = {type: "bar", categoryPath: "/queue", valuePaths: ["/a", "/b"], aggregation: "sum", orientation: "horizontal", layout: "stacked", order: "value-desc", limit: 10};
const status: SnapshotStatusView = {type: "status-grid", idPaths: ["/id"], statusPath: "/status", density: "compact"};
const spec: SnapshotVisualPanelSpec = {id: "s", sectionId: "s", kind: "snapshot-table", size: "normal", path: "/tasks", view: status};
const groups: SnapshotAggregateGroup[] = [{key: "a", cells: [cell("Queue A", "string")], series: [
  {run_id: "run-1", source_id: "worker-0", snapshot_id: "1", measures: {m0: aggregate("10"), m1: aggregate("-5")}},
  {run_id: "run-1", source_id: "worker-1", snapshot_id: "2", measures: {m0: aggregate("4"), m1: aggregate("3")}},
  {run_id: "run-2", source_id: "worker-2", snapshot_id: "3", measures: {m0: aggregate("100"), m1: aggregate("-30")}},
]}];
const records: SnapshotRecordsResponse = {columns: [], snapshots: [], offset: 0, limit: 1000, total: 2, identities: ["string:z", "string:a"],
  rows: [
    {run_id: "r", source_id: "s", snapshot_id: "1", row_key: "0", cells: {"/id": cell("z", "string"), "/status": cell("Pending", "string")}},
    {run_id: "r", source_id: "s", snapshot_id: "1", row_key: "1", cells: {"/id": cell("a", "string"), "/status": cell("Running", "string")}},
  ]};

describe("native snapshot bar geometry", () => {
  it("stacks value fields within a publisher, never across Sources or Runs", () => {
    const result = barGeometry(groups, bar);
    expect(result.segments.get(JSON.stringify(["a", "run-1", "worker-1", "m1"]))).toMatchObject({start: .04, end: .07});
    expect(result.segments.get(JSON.stringify(["a", "run-2", "worker-2", "m0"]))).toMatchObject({start: 0, end: 1});
    expect(result.segments.get(JSON.stringify(["a", "run-1", "worker-0", "m1"]))).toMatchObject({start: 0, end: -.05});
    expect(result.minimum).toBe(-.3); expect(result.maximum).toBe(1);
  });
  it("starts every grouped value field at the zero baseline", () => {
    expect([...barGeometry(groups, {...bar, layout: "grouped"}).segments.values()].every(segment => segment.start === 0)).toBe(true);
  });
  it("normalizes finite large values before summation and retains exact integer labels", () => {
    const huge = structuredClone(groups);
    huge[0]!.series[0]!.measures = {m0: aggregate("1e308"), m1: aggregate("1e308")};
    const result = barGeometry(huge, bar);
    expect(Number.isFinite(result.maximum)).toBe(true); expect(result.maximum).toBe(2);
    expect(cellText(cell("18446744073709551615"))).toBe("18446744073709551615");
    expect(cellText(cell("18446744073709551615"), 2)).toBe("18446744073709551615.00");
  });
  it("keeps zero, missing, null, nonnumeric and nonfinite geometry distinct", () => {
    for (const kind of ["missing", "null", "string"] as const) expect(finiteNumber(cell("0", kind))).toBeNull();
    expect(finiteNumber(cell("0"))).toBe(0); expect(finiteNumber(cell("1e400"))).toBeNull();
    expect(cellText(cell("null", "null"))).toBe("null"); expect(cellText(undefined)).toBe("missing");
    const missing = structuredClone(groups); delete missing[0]!.series[0]!.measures.m0;
    expect(barGeometry(missing, bar).segments.get(JSON.stringify(["a", "run-1", "worker-0", "m0"]))?.value).toBeNull();
  });
  it("does not invent absent publisher/category series", () => {
    expect(barGeometry(groups, bar).segments.has(JSON.stringify(["b", "run-1", "worker-0", "m0"]))).toBe(false);
  });
  it("uses a single pathless count measure independently of configured value fields", () => {
    expect(barMeasures({...bar, aggregation: "count"})).toEqual([{id: "count"}]);
    expect(barMeasures({...bar, valuePaths: [""]})).toEqual([{id: "m0", path: ""}]);
  });
});

describe("stable task state matrices", () => {
  it("retains native identity order rather than reinterpreting identities or array positions", () => {
    const first = statusTasks(records, status), update = structuredClone(records);
    update.rows[0]!.cells["/status"] = cell("Failed", "string"); update.rows[0]!.row_key = "changed-position";
    expect(statusTasks(update, status).map(task => task.key)).toEqual(first.map(task => task.key));
    expect(first.map(task => task.identity)).toEqual(records.identities);
  });
  it("preserves native field sorting within each group, even when numeric previews are identical", () => {
    const ordered = structuredClone(records);
    for (const row of ordered.rows) row.cells["/value"] = {...cell("1844674407370955"), truncated: true};
    expect(statusTasks(ordered, {...status, sort: {path: "/value", direction: "desc"}}).map(task => task.identity)).toEqual(ordered.identities);
    const grouped = {...ordered, rows: [...ordered.rows, {...ordered.rows[0]!, source_id: "other"}], identities: [...ordered.identities, "other"]};
    expect(statusTasks(grouped, {...status, sort: {path: "/value", direction: "desc"}})
      .filter(task => task.record.source_id === "s").map(task => task.identity)).toEqual(ordered.identities);
  });
  it("keeps Run and Source identities separate and rejects misalignment or duplicates", () => {
    const other = structuredClone(records); other.identities = ["same", "same"];
    expect(() => statusTasks(other, status)).toThrow("not unique");
    other.rows[1]!.source_id = "other"; expect(statusTasks(other, status)).toHaveLength(2);
    expect(() => statusTasks({...records, identities: []}, status)).toThrow("aligned");
  });
  it("recognizes native states while keeping unknown/null/missing states explicit", () => {
    expect(statusColor(cell("RUNNING", "string"))).toBe(statusColor(cell("Running", "string")));
    expect(statusColor(cell("Completed", "string"))).toBe(statusColor(cell("Succeeded", "string")));
    expect(statusColor(cell("custom", "string"))).not.toBe(statusColor(cell("Completed", "string")));
    expect(statusKey(cell("missing", "string"))).not.toBe(statusKey(cell("missing", "missing")));
    expect(statusTasks({...records, rows: records.rows.map(row => ({...row, cells: {"/id": cell("x", "string")}}))}, status)[0]!.state.kind).toBe("missing");
  });
  it("uses only validated own-property raw-state colors", () => {
    expect(statusColor(cell("Running", "string"), {Running: "#112233"})).toBe("#112233");
    expect(statusColor(cell("Running", "string"), {Running: "url(external)"})).toBe("#427fc4");
    expect(statusColor(cell("missing", "missing"), {missing: "#112233"})).not.toBe("#112233");
    expect(statusColor(cell("toString", "string"), {})).toBe("#75889b");
    expect(statusColor(cell("constructor", "string"), {})).toBe("#75889b");
  });
  it("retains explicit root-path label and group mappings rather than treating them as absent", () => {
    const root = structuredClone(records); root.rows[0]!.cells[""] = cell("root value", "string");
    const task = statusTasks(root, {...status, labelPath: "", groupPath: "", valuePath: ""}).find(task => task.identity === "string:z")!;
    expect(task.label).toBe("root value"); expect(task.groupLabel).toBe("root value");
  });
  it.each([[320, 360, false], [1400, 360, false], [4000, 1200, true], [800, 600, true]] as const)(
    "bounds visible and overscan cells at %i×%i, expanded=%s", (width, height, expanded) => {
      const {pitch, columns, size} = gridGeometry(width, height, status, expanded);
      expect(columns * (Math.ceil(height / pitch) + 5)).toBeLessThan(expanded ? 1800 : 800);
      expect((columns - 1) * pitch + size).toBeLessThanOrEqual(width);
    });
  it("uses fixed columns, cell size and spacing while adapting to narrow viewports without mutating preferences", () => {
    const view = {...status, columns: 12, cellSize: 24, gap: 6};
    expect(gridGeometry(600, 360, view, false)).toEqual({columns: 12, size: 24, pitch: 30});
    expect(gridGeometry(200, 360, view, false)).toEqual({columns: 6, size: 24, pitch: 30});
    expect(gridGeometry(5, 360, view, false)).toEqual({columns: 1, size: 5, pitch: 30});
    expect(view.columns).toBe(12); expect(view.cellSize).toBe(24); expect(view.gap).toBe(6);
  });
});

describe("snapshot visual query ownership", () => {
  it("retains disabled configuration but strips disabled conditions and enabled flags on the wire", () => {
    const query = {filters: [{path: "/status", op: "eq" as const, value: "Running", enabled: true}, {path: "/id", op: "eq" as const, value: "x", enabled: false}]};
    expect(nativeFilters({...spec, query})).toEqual([{path: "/status", op: "eq", value: "Running"}]);
    expect(query.filters).toHaveLength(2);
  });
  it("does not refetch for density, colors, bar geometry, decimal precision or unit", () => {
    expect(visualQueryKey({...spec, view: {...status, density: "comfortable", columns: 12, cellSize: 24, gap: 6,
      colors: {Running: "#112233"}}})).toBe(visualQueryKey(spec));
    expect(visualQueryKey({...spec, view: {...status, shadePath: "/value", shadeScale: "log"}}))
      .toBe(visualQueryKey({...spec, view: {...status, shadePath: "/value", shadeScale: "linear"}}));
    expect(visualQueryKey({...spec, view: {...bar, orientation: "vertical", layout: "grouped", decimals: 3, unit: "GPU"}})).toBe(visualQueryKey({...spec, view: bar}));
    expect(visualQueryKey({...spec, sourceIds: []})).not.toBe(visualQueryKey(spec));
    expect(visualQueryKey({...spec, view: {...status, shadePath: "/value"}})).not.toBe(visualQueryKey(spec));
    expect(visualQueryKey({...spec, view: {...bar, limit: 5}})).not.toBe(visualQueryKey({...spec, view: bar}));
  });
  it("retains Table sort preferences without applying them to native visual query identity", () => {
    const sorted = {...spec, query: {sort: {path: "/status", direction: "desc" as const}}};
    expect(visualQueryKey(sorted)).toBe(visualQueryKey(spec));
    expect(visualQueryKey({...sorted, view: bar})).toBe(visualQueryKey({...spec, view: bar}));
    expect(sorted.query.sort).toEqual({path: "/status", direction: "desc"});
    expect(visualQueryKey({...spec, view: {...status, sort: {path: "/status", direction: "desc"}}})).not.toBe(visualQueryKey(spec));
    expect(visualQueryKey({...spec, view: {...status, sort: {path: "/status", direction: "asc"}}}))
      .not.toBe(visualQueryKey({...spec, view: {...status, sort: {path: "/status", direction: "desc"}}}));
  });
});
