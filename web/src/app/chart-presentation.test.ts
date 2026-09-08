import {afterEach, describe, expect, it, vi} from "vitest";
import {copyChart, validChartSpec, type ChartSpec} from "./model";
import {PreferencesStore, type UiState} from "./preferences";
import {chartPanel, emptyLayout} from "./panels";

afterEach(() => vi.unstubAllGlobals());

describe("typed chart presentation", () => {
  const spec: ChartSpec = {path: "/loss", size: "wide", presentation: {title: "Policy objective", style: "area", lineWidth: 2.5, points: true, legend: "show", yMin: -1, yMax: 5}};
  it("accepts current flat sets both with and without optional presentation fields", () => {
    expect(validChartSpec({path: "/loss", size: "normal"})).toBe(true);
    expect(validChartSpec(spec)).toBe(true);
    expect(validChartSpec({...spec, presentation: {yMin: 0}})).toBe(true);
    expect(validChartSpec({...spec, presentation: {yMax: 0, points: false, legend: "auto"}})).toBe(true);
  });
  it.each([
    {style: "smoothed"}, {lineWidth: 0}, {lineWidth: Infinity}, {points: "yes"}, {legend: ["auto"]},
    {yMin: Infinity}, {yMax: NaN}, {yMin: 1, yMax: 1}, {yMin: 2, yMax: 1}, {title: " "}, {transform: "log"},
  ])("rejects invalid or unsupported display options: %j", presentation => {
    expect(validChartSpec({...spec, presentation})).toBe(false);
  });
  it("copies nested presentation options rather than mutating saved or live records", () => {
    const draft = copyChart(spec);
    draft.presentation!.title = "Not committed";
    draft.presentation!.yMin = 0;
    expect(spec.presentation?.title).toBe("Policy objective");
    expect(spec.presentation?.yMin).toBe(-1);
  });
  it("persists display options without retaining callers' mutable draft references", async () => {
    const data: UiState = {workspaces: {revision: 0, sets: []}, browser: {revision: 0, theme: "light", sidebar_width: 280, selected: {}, run_colors: {}}};
    vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
      if (!init?.body) return new Response(JSON.stringify(data));
      const body = JSON.parse(String(init.body));
      if (path.endsWith("workspaces")) {data.workspaces = {revision: body.revision + 1, sets: body.sets}; return new Response(JSON.stringify(data.workspaces));}
      data.browser = {...body, revision: body.revision + 1}; return new Response(JSON.stringify(data.browser));
    });
    const store = new PreferencesStore();
    await store.bootstrap();
    const draft = copyChart(spec);
    const layout = emptyLayout(); layout.panels.push(chartPanel(draft, layout.sections[0]!.id));
    expect(await store.save("Display study", "experiment", layout)).not.toBeNull();
    draft.presentation!.style = "line";
    const saved = store.selected("experiment")?.panels[0];
    expect(saved?.kind === "chart" && saved.presentation?.style).toBe("area");
    const other = new PreferencesStore(); await other.bootstrap();
    const restored = other.selected("experiment")?.panels[0];
    expect(restored).toMatchObject(spec);
    store.destroy(); other.destroy();
  });
});
