import {describe, expect, it, vi} from "vitest";
import type {RecordPanelProps} from "./panel-types";
import type {TableCell, TableRowsResponse, TableSource} from "../domain/tables";
import type {SnapshotAggregateResponse, SnapshotRecordsResponse, SnapshotStatusView} from "../domain/snapshot-views";
import {readRecordFrame, summaryViewRows} from "./record-panel-model";
import {compareCells, filterSummaryRows, pageCsv} from "./data-table-model";
import {barGeometry, cellText, statusColor, statusTasks, validateStatusFrame} from "./snapshot-visual/react-model";

const cell = (text: string, kind: TableCell["kind"] = "number"): TableCell => ({kind, text, truncated: false});
const source: TableSource = {run_id: "r", source_id: "s", label: "Reporter", role: "worker", rank: 0, node_id: null,
  snapshot_id: "immutable-1", observed_at_ns: 1, row_count: 1};
const page: TableRowsResponse = {columns: [], rows: [{run_id: "r", source_id: "s", snapshot_id: source.snapshot_id, row_key: "row",
  cells: {"/id": cell("18446744073709551615"), "/status": cell("Running", "string")}}], total: 1, offset: 0, limit: 75, snapshots: [source]};
const records: SnapshotRecordsResponse = {...page, limit: 1000, identities: ["exact:18446744073709551615"]};
const counts: SnapshotAggregateResponse = {groups: [{key: "running", cells: [cell("Running", "string")], series: [{
  run_id: "r", source_id: "s", snapshot_id: source.snapshot_id, measures: {count: {value: cell("1"), count: 1, missing: 0, non_numeric: 0, approximate: false}},
}]}], total_groups: 1, matched_rows: 1, offset: 0, limit: 128, snapshots: [source]};
const status: SnapshotStatusView = {type: "status-grid", idPaths: ["/id"], statusPath: "/status", density: "compact"};
function setup() {
  const reads = {
    tables: vi.fn().mockResolvedValue({tables: [{path: "/tasks", name: "Tasks", columns: [
      {path: "$key", name: "Key"}, {path: "/id", name: "ID", kinds: ["number"]}, {path: "/status", name: "Status", kinds: ["string"]},
    ], sources: [source, {...source, source_id: "unselected", run_id: "another"}]}], truncated: false}),
    rows: vi.fn().mockResolvedValue(page), records: vi.fn().mockResolvedValue(records), aggregate: vi.fn().mockResolvedValue(counts),
    summary: vi.fn(), sources: vi.fn(),
  };
  const props = {
    spec: {id: "p", sectionId: "section", kind: "snapshot-table", path: "/tasks", size: "normal"},
    runs: [{id: "r"}], range: {axis: "elapsed", window: "all"}, catalog: {axes: ["elapsed"], metrics: []},
    reads, active: true, refreshRevision: 0, colorFor: () => "#123456", labelFor: () => "Run",
    onChange: () => {}, onAction: () => {},
  } as unknown as RecordPanelProps;
  return {reads, props, signal: new AbortController().signal};
}

describe("React record request protocol", () => {
  it("uses only actual selected publishers and retries an out-of-range page with temporary immutable pins", async () => {
    const {reads, props, signal} = setup();
    const result = await readRecordFrame(props, 150, signal, true);
    expect(result.kind).toBe("table");
    expect(reads.rows.mock.calls[0]![0]).toMatchObject({run_ids: ["r"], source_ids: ["s"], offset: 150, limit: 75});
    expect(reads.rows.mock.calls[0]![0]).not.toHaveProperty("snapshot_ids");
    expect(reads.rows.mock.calls[1]![0]).toMatchObject({offset: 0, snapshot_ids: ["immutable-1"]});
    await readRecordFrame(props, 0, signal, true);
    expect(reads.rows.mock.calls[2]![0]).not.toHaveProperty("snapshot_ids");
  });
  it("retains disabled rules locally, combines selected groups, and requests hidden sort/filter dependencies", async () => {
    const {reads, props, signal} = setup();
    props.spec = {...props.spec, columns: [{id: "/id", hidden: true}], query: {filters: [
      {path: "/id", op: "eq", value: "18446744073709551615", enabled: false}, {path: "/id", op: "gt", value: "18446744073709551614"},
    ], filterGroups: [{id: "state", name: "State", path: "/status", display: "select", options: [{label: "Running", value: "Running"}], selected: "Running"}],
    sort: {path: "/id", direction: "desc"}}};
    await readRecordFrame(props, 0, signal, true);
    expect(reads.rows.mock.calls[0]![0]).toMatchObject({
      columns: ["$key", "/status", "/id"], filters: [{path: "/id", op: "gt", value: "18446744073709551614"}, {path: "/status", op: "eq", value: "Running"}],
      sort: {path: "/id", direction: "desc"},
    });
  });
  it("pins full-dataset status counts to the displayed records and keeps browser pages latest", async () => {
    const {reads, props, signal} = setup();
    props.spec = {...props.spec, kind: "snapshot-table", path: "/tasks", view: status};
    await readRecordFrame(props, 0, signal, true);
    expect(reads.records.mock.calls[0]![0]).toMatchObject({identity_paths: ["/id"], columns: ["/id", "/status"], offset: 0, limit: 1000});
    expect(reads.records.mock.calls[0]![0]).not.toHaveProperty("snapshot_ids");
    expect(reads.aggregate.mock.calls[0]![0]).toMatchObject({snapshot_ids: ["immutable-1"], group_by: ["/status"], measures: [{id: "count", op: "count"}], limit: 128});
  });
  it("rejects mismatched counts, malformed identities and incomplete totals before publishing any visual frame", async () => {
    const {reads, props, signal} = setup();
    props.spec = {...props.spec, kind: "snapshot-table", path: "/tasks", view: status};
    reads.aggregate.mockResolvedValue({...counts, matched_rows: 2});
    await expect(readRecordFrame(props, 0, signal, true)).rejects.toThrow("pinned record observation");
    expect(() => validateStatusFrame({...records, identities: []}, counts, status)).toThrow("aligned");
    expect(() => validateStatusFrame(records, {...counts, groups: []}, status)).toThrow("incomplete");
    expect(() => validateStatusFrame(records, {...counts, total_groups: 129}, status)).toThrow("Choose a categorical status field");
  });
  it("exposes partial catalog absence without querying unrecorded rows", async () => {
    const {reads, props, signal} = setup();
    reads.tables.mockResolvedValue({tables: [], truncated: true});
    expect(await readRecordFrame(props, 0, signal, true)).toEqual({kind: "table", definition: null, response: null, partial: true});
    expect(reads.rows).not.toHaveBeenCalled();
    props.spec = {...props.spec, kind: "snapshot-table", path: "/tasks", view: status};
    await expect(readRecordFrame(props, 0, signal, true)).rejects.toThrow("partial catalog");
  });
  it("does not interpret an explicitly empty reporter selection as all publishers", async () => {
    const {reads, props, signal} = setup();
    props.spec = {...props.spec, sourceIds: []};
    await expect(readRecordFrame(props, 0, signal, true)).rejects.toThrow("at least one reporter");
    props.spec = {...props.spec, kind: "snapshot-table", path: "/tasks", view: status};
    await expect(readRecordFrame(props, 0, signal, true)).rejects.toThrow("Select at least one Source");
    expect(reads.tables).not.toHaveBeenCalled();
  });
  it("requests authoritative summaries with the shared range and fills registered reporter metadata without inventing statistics", async () => {
    const {reads, props, signal} = setup();
    props.spec = {id: "summary", sectionId: "main", size: "normal", kind: "metric-table", paths: ["/loss", "/unavailable"]};
    props.range = {axis: "elapsed", window: "custom", from: 10, to: 20};
    props.catalog = {...props.catalog, metrics: [{path: "/loss", name: "Loss", group: "", unit: null, run_ids: ["r"], sources: []}]};
    reads.summary.mockResolvedValue({axis: "elapsed", rows: [{run_id: "r", source_id: "registered", path: "/loss",
      observations: 4, count: 3, missing: 1, current: null, minimum: 1, average: 2, p95: 3, maximum: 3, snapshot_id: null, observed_at_ns: null}]});
    reads.sources.mockResolvedValue([{id: "registered", role: "rollout", rank: 1, node_id: null}]);
    const frame = await readRecordFrame(props, 75, signal, true);
    expect(reads.summary.mock.calls[0]![0]).toMatchObject({run_ids: ["r"], paths: ["/loss"], axis: "elapsed", from: 10, to: 20});
    expect(frame.kind).toBe("summary");
    if (frame.kind !== "summary") throw new Error("Expected summary");
    expect(frame.unavailable).toEqual(["/unavailable"]);
    expect(summaryViewRows(frame, props)[0]?.cells).toMatchObject({
      current: {kind: "null", text: "null"}, count: {kind: "number", text: "3"}, missing: {kind: "number", text: "1"},
      "@source": {text: "Rollout 1"},
    });
    expect(reads.tables).not.toHaveBeenCalled();
  });
  it("does not issue summary reads for unavailable paths or unrecorded alignments", async () => {
    const {reads, props, signal} = setup();
    props.spec = {id: "summary", sectionId: "main", size: "normal", kind: "metric-table", paths: ["/unavailable"]};
    expect(await readRecordFrame(props, 0, signal, true)).toMatchObject({kind: "summary", rows: [], unavailable: ["/unavailable"]});
    props.range = {...props.range, axis: "unrecorded"};
    await expect(readRecordFrame(props, 0, signal, true)).rejects.toThrow("alignment is not recorded");
    expect(reads.summary).not.toHaveBeenCalled();
  });
});

describe("React exact-cell presentation", () => {
  it("sorts and filters adjacent u64 integers without floating-point rounding", () => {
    const low = cell("18446744073709551614"), high = cell("18446744073709551615");
    expect(compareCells(low, high)).toBe(-1);
    const rows = [low, high].map((value, index) => ({key: String(index), snapshotId: null, title: "", cells: {value}}));
    expect(filterSummaryRows(rows, {filters: [{path: "value", op: "gt", value: low.text}]}).map(row => row.key)).toEqual(["1"]);
    expect(cellText(high, 2)).toBe("18446744073709551615.00");
    expect(pageCsv([{id: "value", label: "Value"}], rows)).toContain('"18446744073709551615"');
  });
  it("preserves typed missing/null/previews and guards exported source strings against spreadsheet formulas", () => {
    expect(cellText({...cell("18446744073709551615"), truncated: true}, 2)).toBe("18446744073709551615 [preview]");
    expect(cellText(cell("", "string"))).toBe('""');
    expect(cellText(cell("", "missing"))).toBe("missing");
    const csv = pageCsv([{id: "value", label: "Value"}], [{key: "r", title: "", snapshotId: null, cells: {value: cell("=SUM(1,2)", "string")}}]);
    expect(csv).toContain(`"'=SUM(1,2)"`);
  });
  it("retains publisher-separated signed stacks and source-owned task identities", () => {
    const view = {type: "bar" as const, categoryPath: "/status", valuePaths: ["/a", "/b"], aggregation: "sum" as const,
      layout: "stacked" as const, orientation: "horizontal" as const, order: "label" as const, limit: 10};
    const measure = (value: string) => ({value: cell(value), count: 1, missing: 0, non_numeric: 0, approximate: false});
    const geometry = barGeometry([{key: "state", cells: [], series: [
      {run_id: "r", source_id: "s", snapshot_id: "1", measures: {m0: measure("1e308"), m1: measure("-1e308")}},
      {run_id: "r", source_id: "other", snapshot_id: "2", measures: {m0: measure("1e308"), m1: measure("1e308")}},
    ]}], view);
    expect(geometry.minimum).toBe(-1); expect(geometry.maximum).toBe(2);
    expect(statusTasks(records, status)[0]!.identity).toBe("exact:18446744073709551615");
    expect(statusColor(cell("constructor", "string"))).toBe("#75889b");
  });
});
