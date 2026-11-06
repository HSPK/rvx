import {describe, expect, it} from "vitest";
import type {ChartCatalog} from "../domain/snapshots";
import type {TableDefinition} from "../domain/tables";
import {panelEditorError, panelEditorReady, panelsFromEditor, validEditorPanels, type PanelEditorDraft} from "./panel-editor-model";
import {panelLimit, sectionLimit, type PanelSpec, type WorkspaceLayout} from "./panels";
import {suggestSnapshotViews} from "./snapshot-config";

const catalog: ChartCatalog = {
  axes: ["elapsed"], defaults: [], runs: [], truncated: false,
  metrics: ["/a", "/b"].map(path => ({path, name: path === "/a" ? "Loss" : "Reward", group: "Training", unit: null, run_ids: ["run"],
    sources: [{run_id: "run", source_id: "source", label: "Trainer", role: "trainer", rank: null, node_id: null, primary: true, latest_value: 1, observed_at_ns: 1}]})),
};
const layout: WorkspaceLayout = {panels: [], sections: [{id: "section", name: "", collapsed: false}]};
const draft: PanelEditorDraft = {
  kind: "chart", paths: ["/a", "/b"], combined: false, sectionId: "section", size: "normal", title: "Training",
  style: "line", lineWidth: "1.8", points: "auto", legend: "auto", yMin: "", yMax: "", smoothing: "0", logarithmic: false, collectionPath: null, sourceIds: null,
};

describe("React panel editor transactions", () => {
  it("preserves the first edited identity and makes independent split charts with per-field titles", () => {
    const existing: PanelSpec = {kind: "chart", id: "saved", sectionId: "section", size: "normal", path: "/a"};
    const panels = panelsFromEditor(draft, catalog, existing);
    expect(panels).toHaveLength(2);
    expect(panels[0]).toMatchObject({id: "saved", path: "/a", presentation: {title: "Training · Loss"}});
    expect(panels[1]).toMatchObject({path: "/b", presentation: {title: "Training · Reward"}});
    expect(panels[1]!.id).not.toBe("saved");
    expect(validEditorPanels(panels)).toBe(true);
    expect(panelsFromEditor({...draft, combined: true}, catalog, existing)[0]).toMatchObject({id: "saved", paths: ["/a", "/b"], presentation: {title: "Training"}});
  });
  it("enforces limits against replacements instead of counting edited panels twice", () => {
    const existing: PanelSpec = {kind: "chart", id: "saved", sectionId: "section", size: "normal", path: "/a"};
    const full = {...layout, panels: Array.from({length: panelLimit}, (_, index) => ({...existing, id: String(index)}))};
    expect(panelEditorError({...draft, combined: true}, catalog, full, existing)).toBe("");
    expect(panelEditorError(draft, catalog, full, existing)).toContain(`${panelLimit} panels`);
    const sections = {...layout, sections: Array.from({length: sectionLimit}, (_, index) => ({id: String(index), name: "", collapsed: false}))};
    expect(panelEditorError({...draft, kind: "section", paths: Array.from({length: 65}, (_, index) => `/${index}`)}, catalog, sections)).toContain(`${sectionLimit} sections`);
    expect(panelEditorReady({...draft, kind: "section", title: "  "})).toBe(false);
  });
  it("rejects incompatible combined units and invalid numeric presentation without losing separate-chart support", () => {
    const units = {...catalog, metrics: catalog.metrics.map((metric, index) => ({...metric, unit: index ? "s" : "%"}))};
    expect(panelEditorError({...draft, combined: true}, units, layout)).toContain("Different units");
    expect(panelEditorError(draft, units, layout)).toBe("");
    expect(panelEditorError({...draft, lineWidth: ""}, catalog, layout)).toContain("Line width");
    expect(panelEditorError({...draft, yMin: "NaN"}, catalog, layout)).toContain("finite");
    expect(panelEditorError({...draft, yMin: "2", yMax: "1"}, catalog, layout)).toContain("less than");
    expect(panelEditorError({...draft, smoothing: "1"}, catalog, layout)).toContain("EMA");
    expect(panelEditorError({...draft, logarithmic: true, yMin: "0"}, catalog, layout)).toContain("greater than zero");
  });
  it("retains detached table interactions, exact root identity and explicit reporter selections", () => {
    const tableDraft: PanelEditorDraft = {...draft, kind: "snapshot-table", collectionPath: "", sourceIds: ["source"], columns: [{id: "$key", width: 120}],
      query: {search: "task", sort: {path: "/name", direction: "desc"}}, view: suggestSnapshotViews(null).bar};
    const table: TableDefinition = {path: "", name: "State", columns: [], sources: [], collection_kinds: ["array"]};
    tableDraft.view = {...suggestSnapshotViews(null).status, idPaths: ["$key"], statusPath: "/status"};
    expect(panelEditorError(tableDraft, catalog, layout, undefined, table)).toContain("array positions");
    delete tableDraft.view;
    expect(panelEditorError(tableDraft, catalog, layout, undefined, table)).toBe("");
    const panel = panelsFromEditor(tableDraft, catalog)[0]!;
    expect(panel).toMatchObject({kind: "snapshot-table", path: "", sourceIds: ["source"], query: {search: "task"}});
    if (panel.kind !== "chart") {panel.columns![0]!.width = 200; panel.query!.sort!.path = "/changed";}
    expect(tableDraft.columns![0]!.width).toBe(120);
    expect(tableDraft.query!.sort!.path).toBe("/name");
    expect(panelEditorError({...tableDraft, sourceIds: []}, catalog, layout)).toContain("at least one reporter");
  });
});
