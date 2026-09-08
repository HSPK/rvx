import {afterEach, describe, expect, it, vi} from "vitest";
import {copyLayout, type WorkspaceLayout, type WorkspaceSet} from "./panels";
import {layoutSignature, WorkspaceState} from "./workspace-state";
import {initialRange, rangeBounds, timeWindowChoices, workspaceUrl} from "./model";

const layout = (): WorkspaceLayout => ({
  sections: [{id: "section", name: "Training", collapsed: false}],
  panels: [{id: "chart", kind: "chart", sectionId: "section", path: "/loss", size: "normal"}],
});
const saved = (): WorkspaceSet => ({id: "saved", name: "Training overview", experimentId: "experiment", ...layout()});
afterEach(() => vi.unstubAllGlobals());

describe("workspace identity and persistence truth", () => {
  it("distinguishes generated defaults, saved layouts, real edits and a full undo", () => {
    const state = new WorkspaceState(), current = layout();
    state.open(current, "experiment");
    expect(state.status).toBe("default");
    expect(state.dirty).toBe(false);
    state.open(current, "experiment", saved());
    expect(state.status).toBe("saved");
    current.panels[0]!.size = "wide"; state.changed(current);
    expect(state.status).toBe("unsaved");
    expect(state.name).toBe("Training overview");
    current.panels[0]!.size = "normal"; state.changed(current);
    expect(state.status).toBe("saved");
    state.failed(); expect(state.status).toBe("failed");
    state.open(current, "experiment", saved()); expect(state.status).toBe("saved");
  });
  it("compares configuration rather than object property insertion order", () => {
    const first = layout(), second = copyLayout(first);
    second.panels = [{size: "normal", sectionId: "section", path: "/loss", kind: "chart", id: "chart"}];
    expect(layoutSignature(first)).toBe(layoutSignature(second));
    second.sections[0]!.collapsed = true;
    expect(layoutSignature(first)).not.toBe(layoutSignature(second));
  });
  it("keeps deleted active layouts as unsaved drafts and retains their scope", () => {
    const state = new WorkspaceState();
    state.open(layout(), "other", saved()); state.detach();
    expect(state.id).toBeNull(); expect(state.dirty).toBe(true);
    expect(state.name).toBe("Untitled"); expect(state.scope).toBe("experiment");
    state.changed(layout()); expect(state.dirty).toBe(true);
  });
  it("ignores empty table browse defaults and reporter order without hiding real filters", () => {
    const first = layout();
    first.panels = [{id: "table", kind: "snapshot-table", path: "/tasks", size: "wide", sectionId: "section", sourceIds: ["a", "b"]}];
    const second = copyLayout(first);
    const panel = second.panels[0]!;
    if (panel.kind === "chart") throw new Error("Expected table fixture");
    panel.sourceIds = ["b", "a"]; panel.query = {search: "", filters: []}; panel.title = "";
    expect(layoutSignature(first)).toBe(layoutSignature(second));
    panel.query.filters = [{path: "/name", op: "eq", value: ""}];
    expect(layoutSignature(first)).not.toBe(layoutSignature(second));
  });
  it("accepts only the submitted snapshot when the user keeps editing during a save", () => {
    const state = new WorkspaceState(), current = layout(), submitted = saved();
    state.open(current, "experiment", submitted);
    current.panels[0]!.size = "wide";
    state.saved(submitted, current);
    expect(state.dirty).toBe(true);
    current.panels[0]!.size = "normal"; state.changed(current);
    expect(state.status).toBe("saved");
  });
});

describe("concise extended time ranges", () => {
  it("shares every preset between URL restoration and the picker", () => {
    expect(timeWindowChoices.map(([, label]) => label)).toEqual(["15m", "1h", "6h", "24h", "3d", "7d", "All", "Custom…"]);
    vi.stubGlobal("location", {origin: "https://rvx"});
    for (const [window] of timeWindowChoices) {
      const range = initialRange(new URL(`https://rvx/rvx?range=${window}&live=0`));
      expect(range.window).toBe(window);
      expect(new URL(workspaceUrl(["run"], range), "https://rvx").searchParams.get("range")).toBe(window);
    }
    expect(initialRange(new URL("https://rvx/rvx?axis=step&range=604800")).window).toBe("all");
  });
  it("uses true 24-hour, 3-day and 7-day bounds instead of falling back to all observations", () => {
    const catalog = {metrics: [], defaults: [], axes: ["elapsed", "wall_time"], truncated: false,
      runs: [{run_id: "run", snapshot_count: 20, first_observed_at_ns: 100e9, last_observed_at_ns: 900100e9}]};
    for (const window of ["86400", "259200", "604800"]) {
      expect(rangeBounds({axis: "elapsed", window}, catalog)).toEqual({from: (900000 - Number(window)) * 1e9, to: 900000e9});
      expect(rangeBounds({axis: "wall_time", window}, catalog)).toEqual({from: (900100 - Number(window)) * 1e9, to: 900100e9});
    }
  });
});
