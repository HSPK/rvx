import {describe, expect, it, vi} from "vitest";
import {alignedData} from "./chart-controller";
import {chronological, diffValue, escapePointerToken, jsonPreview, numericFields, validPointer} from "./snapshot-utils";
import {SnapshotStore} from "./query-store";
import type {SnapshotQueryRequest, StoredSnapshot} from "../domain/snapshots";

describe("structured state contracts", () => {
  it("discovers numbers recursively using RFC 6901, including array indices", () => {
    expect(numericFields({metrics: {"cpu/percent": 4, "a~b": 1}, workers: [{rank: 0}], bool: true, nullable: null}).paths)
      .toEqual(["/metrics/cpu~1percent", "/metrics/a~0b", "/workers/0/rank"]);
    expect(escapePointerToken("~/")).toBe("~0~1");
    expect(validPointer("/metrics/cpu~1percent")).toBe(true);
    expect(validPointer("/bad~2field")).toBe(false);
    expect(validPointer("not/a/pointer")).toBe(false);
  });

  it("bounds discovery and raw preview without altering the state", () => {
    const state = {items: [1, 2, 3], enabled: true, empty: null, text: "<b>not markup</b>"};
    expect(numericFields(state, 2).truncated).toBe(true);
    expect(jsonPreview(state, 10)).toEqual({text: JSON.stringify(state, null, 2).slice(0, 10), truncated: true});
    expect(state.enabled).toBe(true);
  });

  it("keeps absent and null distinct in every diff direction", () => {
    expect(diffValue({after: null}, "before")).toBe("(absent)");
    expect(diffValue({after: null}, "after")).toBe("null");
    expect(diffValue({before: null}, "after")).toBe("(absent)");
    expect(diffValue({before: false}, "before")).toBe("false");
  });

  it("replays a bounded page by observation time, not storage ID or ingestion", () => {
    const page = [{id: 20, observed_at_ns: 3}, {id: 19, observed_at_ns: 1}, {id: 18, observed_at_ns: 2}] as StoredSnapshot[];
    expect(chronological(page).map(snapshot => snapshot.id)).toEqual([19, 18, 20]);
    expect(page[0]!.id).toBe(20);
  });

  it("aligns numeric projections with explicit null gaps and no carry-forward", () => {
    expect(alignedData([
      {source_id: "a", label: "a", axes: [1, 2, 4], values: [7, null, 9]},
      {source_id: "b", label: "b", axes: [2, 3, 4], values: [null, 0, null]},
    ], "optimizer_step")).toEqual([[1, 2, 3, 4], [7, null, undefined, 9], [undefined, null, 0, null]]);
  });

  it("does not invent gaps between interleaved Source observations", () => {
    expect(alignedData([
      {source_id: "a", label: "a", axes: [0, 2, 4], values: [10, null, 30]},
      {source_id: "b", label: "b", axes: [1, 3, 5], values: [40, 50, 60]},
    ], "optimizer_step")).toEqual([
      [0, 1, 2, 3, 4, 5],
      [10, undefined, null, undefined, 30, undefined],
      [undefined, 40, undefined, 50, undefined, 60],
    ]);
  });

  it("keeps per-path downsampling holes distinct from explicit null captures", () => {
    expect(alignedData([
      {source_id: "a", label: "pathA", axes: [1, 2], values: [null, 20]},
      {source_id: "a", label: "pathB", axes: [0, 2], values: [10, 20]},
    ], "optimizer_step")).toEqual([
      [0, 1, 2],
      [undefined, null, 20],
      [10, undefined, 20],
    ]);
  });

  it("aligns two Sources and two independently sampled paths without filling observations", () => {
    expect(alignedData([
      {source_id: "a", label: "pathA", axes: [1e9, 2e9], values: [null, 20]},
      {source_id: "a", label: "pathB", axes: [0, 2e9], values: [10, 20]},
      {source_id: "b", label: "pathA", axes: [5e8, 15e8, 25e8], values: [30, null, 40]},
      {source_id: "b", label: "pathB", axes: [5e8, 25e8], values: [50, 60]},
    ], "wall_time")).toEqual([
      [0, 0.5, 1, 1.5, 2, 2.5],
      [undefined, undefined, null, undefined, 20, undefined],
      [10, undefined, undefined, undefined, 20, undefined],
      [undefined, 30, undefined, null, undefined, 40],
      [undefined, 50, undefined, undefined, undefined, 60],
    ]);
  });
});

describe("snapshot cached read transports", () => {
  it("deduplicates cross-Run projection requests with a nullable value contract", async () => {
    const query = vi.fn(async (_request: SnapshotQueryRequest) => ({axis: "wall_time", series: []}));
    const store = new SnapshotStore({
      snapshotQuery: query,
      snapshotLatest: vi.fn(async () => ({snapshots: [], next_source_id: null})),
      snapshotHistory: vi.fn(async () => ({snapshots: [], next_before_id: null})),
      snapshotDiff: vi.fn(async request => ({...request, changes: [], truncated: false})),
    });
    const request = {run_ids: ["a", "b"], paths: ["/metrics/cpu~1percent"], axis: "wall_time", max_points: 1600};
    await Promise.all([store.query.query(request), store.query.query(request)]);
    await store.query.query(request);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toEqual(request);
    store.clear();
  });
});
