import {afterEach, describe, expect, it, vi} from "vitest";
import {chartPanel, copyLayout, emptyLayout, movePanel, removeSection, sectionLimit, tableColumnLimit, validLayout} from "./panels";
import {collectionLabel, compareCells, pageCsv, filterSummaryRows, type ViewRow} from "./table-view";

afterEach(() => vi.unstubAllGlobals());
describe("persistent independent panels and sections", () => {
  it("supports duplicate field usage, stable identities and safe cross-section moves", () => {
    const layout = emptyLayout(), first = layout.sections[0]!.id;
    layout.sections.push({id: "next", name: "Resources", collapsed: true});
    const a = chartPanel({path: "/loss", size: "normal"}, first), b = chartPanel({path: "/loss", size: "wide"}, first);
    layout.panels.push(a, b);
    expect(a.id).not.toBe(b.id);
    expect(validLayout(layout)).toBe(true);
    movePanel(layout, a.id, "next");
    expect(layout.panels.find(panel => panel.id === a.id)?.sectionId).toBe("next");
    removeSection(layout, "next");
    expect(layout.panels).toHaveLength(2);
    expect(layout.panels.every(panel => panel.sectionId === first)).toBe(true);
  });
  it("copies nested table and chart settings and rejects orphaned group references", () => {
    const layout = emptyLayout();
    layout.panels.push({id: "table", kind: "snapshot-table", sectionId: layout.sections[0]!.id, path: "", size: "wide", columns: [{id: "$key", width: 180}]});
    const copy = copyLayout(layout);
    const table = copy.panels[0]!;
    if (table.kind !== "chart") table.columns![0]!.width = 400;
    expect(layout.panels[0]).toMatchObject({columns: [{width: 180}]});
    expect(validLayout({...layout, sections: []})).toBe(false);
    expect(validLayout({...layout, panels: [{...layout.panels[0], sectionId: "orphan"}]})).toBe(false);
  });
  it("accepts the bounded section count and rejects an unsavable overflow", () => {
    const layout = emptyLayout();
    layout.sections = Array.from({length: sectionLimit}, (_, index) => ({id: `section-${index}`, name: `Group ${index}`, collapsed: false}));
    expect(validLayout(layout)).toBe(true);
    layout.sections.push({id: "overflow", name: "Overflow", collapsed: false});
    expect(validLayout(layout)).toBe(false);
  });
  it("preserves all 128 server columns plus the three explicit reporter metadata columns", () => {
    const layout = emptyLayout();
    layout.panels.push({id: "wide-table", kind: "snapshot-table", sectionId: layout.sections[0]!.id, path: "/records", size: "wide",
      columns: [...Array.from({length: 128}, (_, index) => ({id: index ? `/field_${index}` : "$key", hidden: index > 8})),
        ...["@run", "@source", "@observed"].map(id => ({id}))]});
    expect(layout.panels[0]?.kind !== "chart" && layout.panels[0]?.columns?.length).toBe(tableColumnLimit);
    expect(validLayout(layout)).toBe(true);
  });
});
describe("exact typed table views", () => {
  it("shortens raw collection path labels without changing meaningful catalog names", () => {
    expect(collectionLabel({path: "/collectors/cluster/document/workloads", name: "collectors/cluster/document/workloads"})).toBe("Workloads");
    expect(collectionLabel({path: "/queues", name: "Queue capacity"})).toBe("Queue capacity");
    expect(collectionLabel({path: "", name: "Root"})).toBe("Root");
  });
  it("sorts numeric text numerically, including adjacent unsigned 64-bit values", () => {
    expect(compareCells({kind: "number", text: "2", truncated: false}, {kind: "number", text: "10", truncated: false})).toBeLessThan(0);
    expect(compareCells({kind: "number", text: "18446744073709551614", truncated: false}, {kind: "number", text: "18446744073709551615", truncated: false})).toBeLessThan(0);
    expect(compareCells({kind: "null", text: "null", truncated: false}, {kind: "number", text: "0", truncated: false})).toBeGreaterThan(0);
  });
  it("filters full authoritative summary rows before slicing a page", () => {
    const rows = Array.from({length: 100}, (_, index) => ({key: String(index), snapshotId: String(index + 1), title: "row", cells: {value: {kind: "number" as const, text: String(index), truncated: false}}}));
    const result = filterSummaryRows(rows, {search: "", filters: [{path: "value", op: "gt", value: "90"}], sort: {path: "value", direction: "desc"}, offset: 0, limit: 75});
    expect(result).toHaveLength(9);
    expect(result[0]?.cells.value?.text).toBe("99");
    expect(filterSummaryRows(rows, {search: "", filters: [{path: "value", op: "eq", value: "5.0"}], offset: 0, limit: 75})).toHaveLength(1);
    expect(filterSummaryRows(rows, {search: "", filters: [{path: "value", op: "gt", value: "90", enabled: false}], offset: 0, limit: 75})).toHaveLength(100);
  });
  it("sorts 10,000 natural text keys with cached collation and unchanged ordering", () => {
    const rows: ViewRow[] = Array.from({length: 10_000}, (_, index) => ({
      key: String(index), snapshotId: "1", title: "row",
      cells: {value: {kind: "string", text: `worker-${(index * 7919) % 10000}`, truncated: false}},
    }));
    const start = performance.now();
    const oracle = [...rows].sort((a, b) => a.cells.value!.text.localeCompare(b.cells.value!.text, undefined, {numeric: true}) || a.key.localeCompare(b.key));
    const baseline = performance.now() - start, optimizedStart = performance.now();
    const sorted = filterSummaryRows(rows, {search: "", filters: [], sort: {path: "value", direction: "asc"}, offset: 0, limit: 75});
    const optimized = performance.now() - optimizedStart;
    expect(sorted.map(row => row.key)).toEqual(oracle.map(row => row.key));
    console.info(`10,000-row text sort: baseline=${baseline.toFixed(2)}ms cached=${optimized.toFixed(2)}ms`);
  });
  it("exports exact current-page text with honest preview markers and formula protection", () => {
    const csv = pageCsv([{id: "value", label: "Value"}], [{key: "1", snapshotId: "1", title: "row", cells: {value: {kind: "number", text: "18446744073709551615", truncated: false}}},
      {key: "2", snapshotId: "1", title: "row", cells: {value: {kind: "string", text: "=1+1", truncated: true}}}]);
    expect(csv).toContain('"18446744073709551615"');
    expect(csv).toContain("\"'=1+1 [preview]\"");
  });
});
