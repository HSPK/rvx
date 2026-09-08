import type {Locator, Page} from "@playwright/test";
import type {ChartCatalog, ChartMetric, ChartMetricSource, SnapshotQuerySeries} from "../src/domain/snapshots";
import type {ExperimentRun} from "../src/domain/types";
import type {SummaryRow, TableCell, TableDataRow, TableDefinition, TableSource} from "../src/domain/tables";
import type {ChartSpec} from "../src/app/model";
import type {WorkspaceSet} from "../src/app/panels";
import type {BrowserPreferences, WorkspaceDocument} from "../src/app/preferences";
import type {BrowserContext} from "@playwright/test";

export interface MockUiServer {
  workspaces: WorkspaceDocument;
  browsers: Map<BrowserContext, BrowserPreferences>;
  initialBrowser: Omit<BrowserPreferences, "revision">;
  mutations: Map<string, {body: string; result: WorkspaceDocument | BrowserPreferences}>;
}
const servers = new WeakMap<Page, MockUiServer>();
export function uiServer(page: Page): MockUiServer {
  let server = servers.get(page);
  if (!server) {
    server = {workspaces: {revision: 0, sets: []}, browsers: new Map(), initialBrowser: {theme: "light", sidebar_width: 280, selected: {}, run_colors: {}}, mutations: new Map()};
    servers.set(page, server);
  }
  return server;
}
/** Seed the authoritative mock server, never browser localStorage. */
export async function seedUiState(page: Page, value: {sets: WorkspaceSet[]; selected?: Record<string, string>; theme?: "light" | "dark"; sidebar_width?: number; run_colors?: Record<string, string>}): Promise<void> {
  const server = uiServer(page);
  server.workspaces = {revision: 1, sets: structuredClone(value.sets)};
  server.initialBrowser = {theme: value.theme ?? "light", sidebar_width: value.sidebar_width ?? 280, selected: {...value.selected}, run_colors: {...value.run_colors}};
}
export async function serverState(page: Page): Promise<{workspaces: WorkspaceDocument; browser: BrowserPreferences}> {
  return page.evaluate(async () => (await fetch("/api/ui/state")).json());
}

export async function selectAddType(editor: Locator, kind: string): Promise<void> {
  const labels: Record<string, string> = {chart: "Chart", "metric-table": "Metric table", "snapshot-table": "Snapshot", section: "Section"};
  const label = labels[kind];
  if (!label) throw new Error(`Unknown Add type in browser fixture: ${kind}`);
  await editor.getByRole("tab", {name: label, exact: true}).click();
}

export function selectedObservation(chart: Locator): Locator {
  return chart.locator(".chart-tooltip-row.is-selected");
}

export async function seedWorkspace(page: Page, charts: ChartSpec[], name = "Saved analysis"): Promise<void> {
  await seedUiState(page, {
    theme: "light", selected: {"experiment-1": "test-set"},
    sets: [{id: "test-set", name, experimentId: "experiment-1", sections: [{id: "initial", name: "", collapsed: false}],
      panels: charts.map((chart, index) => ({...chart, id: `seed-${index}`, kind: "chart", sectionId: "initial"}))}],
  });
}

export const firstObservation = 1_788_595_200_000_000_000;
export const exactId = "9007199254740993";
export const runs: ExperimentRun[] = [
  {id: "run-1", experiment_id: "experiment-1", name: "grpo · warm-start", status: "running", config_json: "{}", created_at_ns: firstObservation - 5e12, updated_at_ns: firstObservation + 200e9},
  {id: "run-2", experiment_id: "experiment-1", name: "grpo · baseline", status: "finished", config_json: "{}", created_at_ns: firstObservation - 9e12, updated_at_ns: firstObservation + 180e9},
  {id: "run-3", experiment_id: "experiment-2", name: "ppo · small batch", status: "failed", config_json: "{}", created_at_ns: firstObservation - 2e12, updated_at_ns: firstObservation + 100e9},
  {id: "run-4", experiment_id: "experiment-1", name: "grpo · wider context", status: "finished", config_json: "{}", created_at_ns: firstObservation - 1e12, updated_at_ns: firstObservation + 90e9},
];
const definitions = [
  ["/progress/loss", "Policy loss", "Training", null],
  ["/progress/reward", "Mean reward", "Training", null],
  ["/pipeline/throughput", "Token throughput", "Throughput", "tokens/s"],
  ["/pipeline/queue_depth", "Queue depth", "Pipeline", null],
  ["/resources/gpu_utilization", "GPU utilization", "Resources", "%"],
  ["/resources/memory", "Memory usage", "Resources", "GB"],
  ["/quality/score", "Evaluation score", "Training", null],
  ["/workers/throughput", "Worker throughput", "Throughput", "samples/s"],
] as const;
export interface FixtureOptions {
  runCount?: number;
  mode?: "waiting" | "nonnumeric" | "ambiguous" | "nondefault";
  failQueries?: boolean;
  failCatalog?: boolean;
  missingMetadata?: boolean;
  points?: number;
  omittedPaths?: string[];
  emptyRuns?: string[];
  metricValues?: Record<string, Record<string, number | null | ((index: number) => number | null)>>;
  logicalAxes?: number[];
  observationOrigins?: Record<string, number>;
  tableRows?: number;
  tableVersion?: number;
  failTables?: boolean;
  uiServer?: MockUiServer;
}
export interface CapturedRequest {path: string; body: Record<string, unknown> | null}
export async function mockApi(page: Page, options: FixtureOptions = {}): Promise<CapturedRequest[]> {
  const requests: CapturedRequest[] = [];
  const ui = options.uiServer ?? uiServer(page); servers.set(page, ui);
  await page.routeWebSocket("**/api/ui/connection", socket => {
    socket.onMessage(message => {
      const value = JSON.parse(String(message));
      if (value.type === "ping") socket.send(JSON.stringify({type: "pong", id: value.id}));
    });
  });
  const allRuns = options.runCount ? Array.from({length: options.runCount}, (_, index) => ({...runs[0]!, id: `large-${index}`, name: `training-${String(index).padStart(5, "0")}`, updated_at_ns: firstObservation - index * 1e9})) : runs;
  const info = (runId: string) => {
    const offset = runId === "run-2" ? 2e12 : 0;
    const origin = options.observationOrigins?.[runId] ?? firstObservation + offset;
    const empty = options.mode === "waiting" || options.emptyRuns?.includes(runId);
    return {run_id: runId, snapshot_count: empty ? 0 : options.points ?? 180,
      first_observed_at_ns: empty ? null : origin,
      last_observed_at_ns: empty ? null : origin + ((options.points ?? 180) - 1) * 60e9};
  };
  const source = (runId: string, ambiguous = false, index = 0): ChartMetricSource => ({
    run_id: runId, source_id: `${runId}-source-${index}`, label: ambiguous ? `Rollout worker ${index}` : "Learner",
    role: ambiguous ? "rollout" : "learner", rank: index, node_id: "node-a", primary: !ambiguous,
    latest_value: .23, observed_at_ns: info(runId).last_observed_at_ns ?? firstObservation,
  });
  const catalog = (ids: string[]): ChartCatalog => {
    const metrics: ChartMetric[] = options.mode === "waiting" || options.mode === "nonnumeric" ? [] : definitions.map(([path, name, group, unit]) => {
      const metricRuns = ids.filter(id => !options.emptyRuns?.includes(id) && !(path === "/resources/memory" && id === "run-2"));
      const ambiguous = path === "/workers/throughput" || options.mode === "ambiguous";
      return {path, name, group, unit, run_ids: metricRuns, sources: metricRuns.flatMap(id => ambiguous ? [source(id, true), source(id, true, 1)] : [source(id)]).map(reporter => ({
        ...reporter, latest_value: valueFor(path, (options.points ?? 180) - 1, reporter.run_id, reporter.rank ?? 0),
      }))};
    }).filter(metric => metric.run_ids.length && !options.omittedPaths?.includes(metric.path));
    return {runs: options.missingMetadata ? [] : ids.map(info), metrics, defaults: options.mode === "nondefault" ? [] : metrics.slice(0, 6).map(metric => metric.path), axes: ["wall_time", "elapsed", "optimizer_step"], truncated: false};
  };
  const valueFor = (path: string, index: number, runId: string, sourceIndex: number): number | null => {
    const overrides = options.metricValues?.[runId];
    if (overrides && Object.hasOwn(overrides, path)) {
      const value = overrides[path]!;
      return typeof value === "function" ? value(index) : value;
    }
    if (path === "/quality/score" || (index >= 90 && index < 95)) return null;
    const phase = runId === "run-2" ? .5 : 0;
    if (path.endsWith("loss")) return 1.2 * Math.exp(-index / 80) + .04 * Math.sin(index * .8 + phase) + phase * .15;
    if (path.endsWith("reward")) return .1 + .75 * (1 - Math.exp(-index / 70)) + .025 * Math.sin(index / 5 + phase) - phase * .1;
    if (path.endsWith("queue_depth")) return Math.round(28 + 12 * Math.sin(index / 9 + phase));
    if (path.endsWith("gpu_utilization")) return 76 + 10 * Math.sin(index / 15 + phase);
    if (path.endsWith("memory")) return 24 + 4 * Math.sin(index / 30);
    return 12000 + 1500 * Math.sin(index / 20 + phase) + sourceIndex * 4000;
  };
  const tableSnapshots = new Map<string, {runId: string; version: number}>();
  const tableSource = (runId: string, version: number, count: number): TableSource => {
    const id = String(9007199254742000n + BigInt(allRuns.findIndex(run => run.id === runId) * 100 + version));
    tableSnapshots.set(id, {runId, version});
    return {run_id: runId, source_id: `${runId}-source-0`, label: "Learner", role: "learner", rank: 0, node_id: "node-a", snapshot_id: id, observed_at_ns: firstObservation + version * 1e9, row_count: count};
  };
  const tableDefinitions = (ids: string[]): TableDefinition[] => [
    {path: "/tasks", name: "Tasks", columns: [{path: "$key", name: "Key"}, ...["name", "load", "counter", "healthy", "nullable", "nested"].map(name => ({path: `/${name}`, name}))], sources: ids.map(id => tableSource(id, options.tableVersion ?? 0, options.tableRows ?? 10000))},
    {path: "/queues", name: "Queues", columns: [{path: "$key", name: "Key"}, {path: "/ready", name: "Ready"}], sources: ids.map(id => tableSource(id, options.tableVersion ?? 0, 2))},
    {path: "/samples", name: "Samples", columns: [{path: "$key", name: "Key"}, {path: "$value", name: "Value"}], sources: ids.map(id => tableSource(id, options.tableVersion ?? 0, 3))},
    {path: "", name: "State fields", columns: [{path: "$key", name: "Key"}, {path: "$value", name: "Value"}], sources: ids.map(id => tableSource(id, options.tableVersion ?? 0, 2))},
  ];
  const valueCell = (value: string, kind: TableCell["kind"] = "string", truncated = false): TableCell => ({kind, text: value, truncated});
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postData() ? route.request().postDataJSON() : null;
    if (path === "/api/auth/session") return route.fulfill({json: {authenticated: true, authentication_required: false}});
    requests.push({path, body});
    if (path.startsWith("/api/ui/")) {
      let browser = ui.browsers.get(page.context());
      if (!browser) {browser = {revision: 0, ...structuredClone(ui.initialBrowser)}; ui.browsers.set(page.context(), browser);}
      if (path === "/api/ui/state") return route.fulfill({json: {workspaces: ui.workspaces, browser},
        headers: {"Set-Cookie": "rvx_browser=mock-browser; HttpOnly; SameSite=Strict; Path=/", "Cache-Control": "no-store"}});
      const text = route.request().postData()!;
      const mutation = ui.mutations.get(body.mutation_id);
      if (mutation) return route.fulfill(mutation.body === text ? {json: mutation.result} : {status: 409, json: {error: "Mutation reused", current: path.endsWith("workspaces") ? ui.workspaces : browser}});
      if (path === "/api/ui/workspaces") {
        if (body.revision !== ui.workspaces.revision) return route.fulfill({status: 409, json: {error: "Workspace revision conflict", current: ui.workspaces}});
        ui.workspaces = {revision: body.revision + 1, sets: body.sets};
        for (const prefs of ui.browsers.values()) for (const [experiment, id] of Object.entries(prefs.selected)) {
          if (!ui.workspaces.sets.some(set => set.id === id && set.experimentId === experiment)) {delete prefs.selected[experiment]; prefs.revision++;}
        }
        ui.mutations.set(body.mutation_id, {body: text, result: structuredClone(ui.workspaces)});
        return route.fulfill({json: ui.workspaces});
      }
      if (path === "/api/ui/browser") {
        if (body.revision !== browser.revision) return route.fulfill({status: 409, json: {error: "Browser revision conflict", current: browser}});
        browser = {revision: body.revision + 1, theme: body.theme, sidebar_width: body.sidebar_width, selected: body.selected, run_colors: body.run_colors};
        ui.browsers.set(page.context(), browser); ui.mutations.set(body.mutation_id, {body: text, result: structuredClone(browser)});
        return route.fulfill({json: browser});
      }
    }
    if (path === "/api/experiments/projects") return route.fulfill({json: {projects: [{id: "project-1", name: "Reasoning models", created_at_ns: firstObservation}]}});
    if (path === "/api/experiments/experiments") return route.fulfill({json: {experiments: [{id: "experiment-1", project_id: "project-1", name: "GRPO research", created_at_ns: firstObservation}, {id: "experiment-2", project_id: "project-1", name: "PPO research", created_at_ns: firstObservation}]}});
    if (path === "/api/experiments/runs") return route.fulfill({json: {runs: allRuns}});
    if (path === "/api/experiments/sources") return route.fulfill({json: {sources: []}});
    if (path === "/api/experiments/stats") return route.fulfill({json: {projects: 1, experiments: 2, runs: allRuns.length, sources: 3, active_sources: 1, snapshots: 540, cursor_gaps: 0, scrape_failures: 0}});
    if (path.startsWith("/api/tables/") && options.failTables) return route.fulfill({status: 503, json: {error: "Table read temporarily unavailable"}});
    if (path === "/api/tables/summary") {
      const rows: SummaryRow[] = [];
      for (const metric of catalog(body.run_ids).metrics.filter(metric => body.paths.includes(metric.path))) for (const reporter of metric.sources) {
        if (body.source_ids && !body.source_ids.includes(reporter.source_id)) continue;
        const points = Array.from({length: options.points ?? 180}, (_, index) => {
          const observed = info(reporter.run_id).first_observed_at_ns! + index * 60e9;
          const axis = body.axis === "wall_time" ? observed : body.axis === "optimizer_step" ? options.logicalAxes?.[index] ?? index * 10 : index * 60e9;
          return {index, observed, axis, value: valueFor(metric.path, index, reporter.run_id, reporter.rank ?? 0)};
        }).filter(point => (body.from === undefined || point.axis >= body.from) && (body.to === undefined || point.axis <= body.to));
        const values = points.flatMap(point => point.value === null ? [] : [point.value]).sort((a, b) => a - b);
        const last = points.at(-1);
        rows.push({run_id: reporter.run_id, source_id: reporter.source_id, path: metric.path, observations: points.length, count: values.length, missing: points.length - values.length,
          current: last?.value ?? null, minimum: values[0] ?? null, maximum: values.at(-1) ?? null,
          average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
          p95: values[Math.ceil(.95 * values.length) - 1] ?? null,
          snapshot_id: last ? reporter.run_id === "run-1" && reporter.rank === 0 && last.index === 179 ? exactId : String(allRuns.findIndex(run => run.id === reporter.run_id) * 100000 + (reporter.rank ?? 0) * 10000 + last.index + 1) : null,
          observed_at_ns: last?.observed ?? null});
      }
      return route.fulfill({json: {axis: body.axis ?? "elapsed", rows}});
    }
    if (path === "/api/tables/catalog") return route.fulfill({json: {tables: tableDefinitions(body.run_ids).map(table => ({...table, sources: table.sources.filter(source => !body.source_ids || body.source_ids.includes(source.source_id))})), truncated: false}});
    if (path === "/api/tables/rows") {
      const definition = tableDefinitions(body.run_ids).find(table => table.path === body.path);
      if (!definition) return route.fulfill({status: 400, body: "Unknown collection"});
      const sources: TableSource[] = body.snapshot_ids ? body.snapshot_ids.map((id: string) => {
        const snapshot = tableSnapshots.get(id);
        return snapshot ? tableSource(snapshot.runId, snapshot.version, definition.sources.find(source => source.run_id === snapshot.runId)?.row_count ?? 0) : null;
      }) : definition.sources;
      if (sources.some(source => !source || !body.run_ids.includes(source.run_id))) return route.fulfill({status: 400, body: "Snapshot ownership mismatch"});
      const columns = definition.columns.filter(column => !body.columns || body.columns.includes(column.path));
      const selectedSources = sources.filter(source => !body.source_ids || body.source_ids.includes(source.source_id));
      let rows: TableDataRow[] = selectedSources.flatMap(source => {
        const version = tableSnapshots.get(source.snapshot_id)!.version;
        return Array.from({length: source.row_count}, (_, index) => {
          const key = body.path === "/queues" ? ["learner", "rollout"][index]! : body.path === "" ? ["phase", "counter"][index]! : String(index);
          const cells: Record<string, TableCell> = {"$key": valueCell(key)};
          if (body.path === "/tasks") Object.assign(cells, {
            "/name": valueCell(`worker-${String(index).padStart(5, "0")}`), "/load": valueCell(String(index + version * 10000), "number"),
            "/counter": valueCell(String(18446744073709551615n - BigInt(index)), "number"), "/healthy": valueCell(String(index % 2 === 0), "boolean"),
            "/nullable": index % 3 ? valueCell("missing", "missing") : valueCell("null", "null"),
            "/nested": valueCell(index === 0 ? '{"payload":"preview"}' : '{"phase":"ready"}', "object", index === 0),
          });
          else if (body.path === "/queues") cells["/ready"] = valueCell(index ? "10" : "2", "number");
          else if (body.path === "/samples") cells.$value = valueCell(["1", "10", "2"][index]!, "number");
          else cells.$value = key === "phase" ? valueCell("training") : valueCell("18446744073709551615", "number");
          return {run_id: source.run_id, source_id: source.source_id, snapshot_id: source.snapshot_id, row_key: key, cells};
        });
      });
      rows = rows.filter(row => (!body.search || Object.values(row.cells).some(cell => cell.text.toLowerCase().includes(body.search.toLowerCase()))) && (body.filters ?? []).every((filter: {path: string; op: string; value: string}) => {
        const cell = row.cells[filter.path]; if (!cell) return false;
        if (filter.op === "contains") return cell.text.toLowerCase().includes(filter.value.toLowerCase());
        if (filter.op === "eq") return cell.text === filter.value;
        return cell.kind === "number" && (filter.op === "gt" ? Number(cell.text) > Number(filter.value) : Number(cell.text) < Number(filter.value));
      }));
      if (body.sort) rows.sort((a, b) => {
        const left = a.cells[body.sort.path], right = b.cells[body.sort.path];
        let difference = 0;
        if (left?.kind === "number" && right?.kind === "number" && /^-?\d+$/.test(left.text) && /^-?\d+$/.test(right.text)) difference = BigInt(left.text) < BigInt(right.text) ? -1 : BigInt(left.text) > BigInt(right.text) ? 1 : 0;
        else difference = (left?.text ?? "").localeCompare(right?.text ?? "", undefined, {numeric: true});
        return (body.sort.direction === "desc" ? -difference : difference) || Number(a.row_key) - Number(b.row_key);
      });
      const total = rows.length, offset = body.offset ?? 0, limit = body.limit ?? 75;
      return route.fulfill({json: {columns, rows: rows.slice(offset, offset + limit).map(row => ({...row, cells: Object.fromEntries(columns.map(column => [column.path, row.cells[column.path]]))})), total, offset, limit, snapshots: selectedSources}});
    }
    if (path === "/api/charts/catalog") {
      if (!body.run_ids.length) return route.fulfill({status: 400, body: "Choose at least one run."});
      if (options.failCatalog) return route.fulfill({status: 503, body: "Catalog temporarily unavailable"});
      return route.fulfill({json: catalog(body.run_ids)});
    }
    if (path === "/api/snapshots/query") {
      if (!body.run_ids.length || !body.paths.length) return route.fulfill({status: 400, body: "Choose runs and indexed paths."});
      if (options.failQueries) return route.fulfill({status: 503, body: "Projection temporarily unavailable"});
      const cat = catalog(body.run_ids);
      if (body.paths.some((path: string) => !cat.metrics.some(metric => metric.path === path))) {
        return route.fulfill({status: 400, body: "A requested path is not indexed for the selected runs."});
      }
      const series: SnapshotQuerySeries[] = [];
      for (const metric of cat.metrics.filter(metric => body.paths.includes(metric.path))) {
        for (const reporter of metric.sources.filter(source => !body.source_ids?.length || body.source_ids.includes(source.source_id))) {
          const first = info(reporter.run_id).first_observed_at_ns!;
          let points = Array.from({length: options.points ?? 180}, (_, index) => {
            const observed = first + index * 60e9;
            const axis = body.axis === "elapsed" ? index * 60e9 : body.axis === "optimizer_step" ? options.logicalAxes?.[index] ?? index * 10 : observed;
            return {index, axis, observed};
          }).filter(point => (body.from === undefined || point.axis >= body.from) && (body.to === undefined || point.axis <= body.to))
            .sort((a, b) => a.axis - b.axis || a.observed - b.observed);
          if (points.length > body.max_points) {
            const selected = new Set(Array.from({length: body.max_points}, (_, index) => Math.round(index * (points.length - 1) / (body.max_points - 1))));
            points = points.filter((_point, index) => selected.has(index));
          }
          series.push({
            run_id: reporter.run_id, source_id: reporter.source_id, path: metric.path,
            axes: points.map(point => point.axis), observed_at_ns: points.map(point => point.observed),
            source_session_ids: points.map(() => `${reporter.source_id}-session`),
            sequences: points.map(point => point.index),
            snapshot_ids: points.map(point => reporter.run_id === "run-1" && reporter.rank === 0 && point.index === 179 ? "EXACT_ID" as unknown as number : allRuns.findIndex(run => run.id === reporter.run_id) * 100_000 + (reporter.rank ?? 0) * 10_000 + point.index + 1),
            values: points.map(point => valueFor(metric.path, point.index, reporter.run_id, reporter.rank ?? 0)),
          });
        }
      }
      return route.fulfill({contentType: "application/json", body: JSON.stringify({axis: body.axis, series}).replaceAll('"EXACT_ID"', exactId)});
    }
    return route.fulfill({status: 404, body: "Unrecognized API in test"});
  });
  return requests;
}
