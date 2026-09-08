import {describe, expect, it} from "vitest";
import {cellText, finiteNumber} from "./details";
import {gridGeometry, statusTotals} from "./status";
import type {SnapshotAggregateResponse} from "../../domain/snapshot-views";

describe("snapshot visual frame integrity", () => {
  it("keeps numeric previews and empty strings distinct without interpreting truncated values", () => {
    const preview = {kind: "number" as const, text: "123456789", truncated: true};
    expect(cellText(preview, 2)).toBe("123456789 [preview]");
    expect(finiteNumber(preview)).toBeNull();
    expect(cellText({kind: "string", text: "", truncated: false})).toBe('""');
    expect(cellText({kind: "missing", text: "", truncated: false})).toBe("missing");
    expect(gridGeometry(1440, 1000, {type: "status-grid", idPaths: ["/id"], statusPath: "/status", density: "compact"}, true, 1000).pitch).toBe(20);
  });
  it("rejects incomplete full-scope counts before a new status frame is painted", () => {
    const empty: SnapshotAggregateResponse = {groups: [], total_groups: 0, matched_rows: 0, offset: 0, limit: 128, snapshots: []};
    expect(statusTotals(empty).size).toBe(0);
    expect(() => statusTotals({...empty, matched_rows: 1})).toThrow("full filtered dataset");
    expect(() => statusTotals({...empty, total_groups: 1})).toThrow("incomplete");
    const malformed: SnapshotAggregateResponse = {...empty, total_groups: 1, matched_rows: 1, groups: [{
      key: "running", cells: [{kind: "string", text: "Running", truncated: false}],
      series: [{run_id: "run", source_id: "source", snapshot_id: "1", measures: {}}],
    }]};
    expect(() => statusTotals(malformed)).toThrow("counts are invalid");
  });
});
