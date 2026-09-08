import {describe, expect, it} from "vitest";
import {copyPanel, validPanel, type SnapshotTablePanel} from "./panels";
import {copySnapshotView, snapshotViewError, suggestSnapshotViews, validSnapshotView} from "./snapshot-config";
import type {SnapshotBarView, SnapshotStatusView} from "../domain/snapshot-views";
import type {TableDefinition} from "../domain/tables";

const bar: SnapshotBarView = {type: "bar", categoryPath: "/queue", valuePaths: ["/running_gpus"],
  aggregation: "sum", orientation: "horizontal", layout: "grouped", order: "value-desc", limit: 20};
const status: SnapshotStatusView = {type: "status-grid", idPaths: ["/id"], statusPath: "/status", density: "compact",
  sort: {path: "/running_gpus", direction: "desc"}, columns: 12, cellSize: 20, gap: 4, colors: {Running: "#15917d"}};
const table: TableDefinition = {path: "/tasks", name: "Tasks", sources: [], collection_kinds: ["array"], columns: [
  {path: "$key", name: "Key", kinds: ["string"]}, {path: "/id", name: "ID", kinds: ["string"]},
  {path: "/name", name: "Name", kinds: ["string"]}, {path: "/status", name: "Status", kinds: ["string"]},
  {path: "/running_gpus", name: "Running GPUs", kinds: ["number"]},
]};

describe("typed snapshot visual configurations", () => {
  it("preserves old table records while validating supported bar and task bindings", () => {
    const panel: SnapshotTablePanel = {kind: "snapshot-table", id: "panel", sectionId: "main", size: "normal", path: "/tasks"};
    expect(validPanel(panel)).toBe(true);
    expect(validPanel({...panel, view: bar})).toBe(true);
    expect(validPanel({...panel, view: status})).toBe(true);
    expect(validPanel({...panel, view: null})).toBe(false);
    expect(validPanel({...panel, kind: "metric-table", paths: ["/loss"], view: bar})).toBe(false);
    expect(copyPanel(panel)).toEqual(panel);
  });
  it("deep-copies all mutable visual binding and palette state", () => {
    const first = copySnapshotView(bar);
    if (first.type === "bar") first.valuePaths.push("/pending_gpus");
    expect(bar.valuePaths).toEqual(["/running_gpus"]);
    const copy = copyPanel({kind: "snapshot-table", id: "panel", sectionId: "main", size: "normal", path: "/tasks", view: status});
    if (copy.kind === "snapshot-table" && copy.view?.type === "status-grid") {
      copy.view.idPaths.push("/name"); copy.view.colors!.Running = "#ffffff"; copy.view.sort!.direction = "asc";
    }
    expect(status.idPaths).toEqual(["/id"]); expect(status.colors!.Running).toBe("#15917d");
    expect(status.sort!.direction).toBe("desc");
  });
  it("requires bounded category counts, explicit measures and unique stable ID fields", () => {
    for (const limit of [0, 51, NaN, 2.5]) expect(validSnapshotView({...bar, limit})).toBe(false);
    expect(validSnapshotView({...bar, aggregation: "count", valuePaths: []})).toBe(true);
    expect(validSnapshotView({...bar, aggregation: "count"})).toBe(false);
    expect(validSnapshotView({...bar, valuePaths: ["/value", "/value"]})).toBe(false);
    expect(validSnapshotView({...bar, decimals: 21})).toBe(false);
    expect(validSnapshotView({...bar, smoothing: 1})).toBe(false);
    expect(validSnapshotView({...bar, categoryPath: "/a~2"})).toBe(false);
    expect(validSnapshotView({...bar, orientation: ["horizontal"]})).toBe(false);
    expect(validSnapshotView({...bar, aggregation: ["sum"]})).toBe(false);
    expect(validSnapshotView({...status, idPaths: []})).toBe(false);
    expect(validSnapshotView({...status, idPaths: ["/id", "/id"]})).toBe(false);
    expect(validSnapshotView({...status, colors: {Running: "url(unsafe)"}})).toBe(false);
    expect(snapshotViewError({...status, idPaths: []})).toContain("identity");
  });
  it("validates native-compatible sorting and responsive layout bounds without migrating old views", () => {
    const legacy: SnapshotStatusView = {type: "status-grid", idPaths: ["/id"], statusPath: "/status", density: "comfortable"};
    expect(validSnapshotView(legacy)).toBe(true);
    expect(copySnapshotView(legacy)).toEqual(legacy);
    for (const [key, min, max] of [["columns", 1, 64], ["cellSize", 12, 40], ["gap", 2, 12]] as const) {
      for (const value of [min, max]) expect(validSnapshotView({...status, [key]: value})).toBe(true);
      for (const value of [min - 1, max + 1, 2.5, null, "12", Infinity]) expect(validSnapshotView({...status, [key]: value})).toBe(false);
    }
    for (const path of ["", "$key", "$value", "/a~1b"]) expect(validSnapshotView({...status, sort: {path, direction: "asc"}})).toBe(true);
    for (const shadePath of ["", "$value", "/running_gpus"]) expect(validSnapshotView({...status, shadePath})).toBe(true);
    for (const shadePath of [null, 12, {}, "/bad~2", "/bad\0"]) expect(validSnapshotView({...status, shadePath})).toBe(false);
    for (const shadeScale of ["linear", "log"]) expect(validSnapshotView({...status, shadeScale})).toBe(true);
    for (const shadeScale of [null, "sqrt", 1, {}]) expect(validSnapshotView({...status, shadeScale})).toBe(false);
    for (const sort of [null, {}, {path: "/x"}, {path: "/x", direction: "up"}, {path: "/x", direction: "asc", extra: 1},
      {path: "/x\0", direction: "asc"}, {path: "/a~2", direction: "asc"}]) expect(validSnapshotView({...status, sort})).toBe(false);
  });
  it("recommends declared fields without turning array positions into task identity", () => {
    const recommended = suggestSnapshotViews(table);
    expect(recommended.bar.valuePaths).toEqual(["/running_gpus"]);
    expect(recommended.status).toMatchObject({idPaths: ["/id"], statusPath: "/status", labelPath: "/name"});
    const scalar = {...table, columns: [{path: "$key", name: "Key", kinds: ["string" as const]}, {path: "$value", name: "Value", kinds: ["string" as const]}]};
    expect(suggestSnapshotViews(scalar).status.idPaths).toEqual([]);
    expect(suggestSnapshotViews(scalar).bar).toMatchObject({categoryPath: "$value", aggregation: "count", valuePaths: []});
    expect(suggestSnapshotViews({...scalar, collection_kinds: ["object"]}).status.idPaths).toEqual(["$key"]);
  });
});
