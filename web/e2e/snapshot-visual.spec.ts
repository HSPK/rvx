import {test, expect, type Page} from "@playwright/test";
import {firstObservation, mockApi, seedUiState, serverState} from "./fixtures";
import type {SnapshotAggregateRequest, SnapshotBarView, SnapshotRecordsRequest, SnapshotStatusView, SnapshotView} from "../src/domain/snapshot-views";
import type {TableCell, TableDataRow, TableRowsRequest, TableSource} from "../src/domain/tables";
import type {SnapshotVisualPanelSpec} from "../src/app/panels";

const cell = (text: string, kind: TableCell["kind"] = "string"): TableCell => ({kind, text, truncated: false});
const barView: SnapshotBarView = {type: "bar", categoryPath: "/queue", valuePaths: ["/value", "/extra"], aggregation: "sum", orientation: "horizontal", layout: "stacked", order: "value-desc", limit: 3};
const statusView: SnapshotStatusView = {type: "status-grid", idPaths: ["/id"], statusPath: "/status", labelPath: "/name", valuePath: "/value", density: "compact"};
const publishers = [
  {run: "run-1", source: "run-1-source-0", label: "Learner"},
  {run: "run-1", source: "run-1-source-1", label: "Rollout 1"},
  {run: "run-2", source: "run-2-source-0", label: "Learner"},
];
const states = [cell("Running"), cell("Pending"), cell("Finished"), cell("unknown-phase"), cell("null", "null"), cell("missing", "missing")];
const extraCell = (index: number, total: number): TableCell => index % 17 === 1 ? cell("", "missing")
  : index % 17 === 2 ? cell("null", "null") : index % 17 === 3 ? cell("7") : cell(String(index === total - 1 ? 200 : index % 101), "number");

/** Mock only native snapshot visual endpoints while retaining the existing shared workspace fixtures. */
async function visualFixture(page: Page, view: SnapshotView, overrides: Partial<SnapshotVisualPanelSpec> = {}) {
  const base = await mockApi(page);
  const state = {version: 0, total: 50_000, reverse: false, tooManyStates: false, identityError: false, sourceCount: 3, badShadeRange: false};
  const calls = {records: [] as SnapshotRecordsRequest[], aggregate: [] as SnapshotAggregateRequest[], rows: [] as TableRowsRequest[]};
  const snapshots = new Map<string, TableSource>(), totals = new Map<string, number>(), savedRows = new Map<string, TableDataRow>();
  let gate: Promise<void> | null = null, release = (): void => {};
  const columns = ["id", "name", "status", "queue", "value", "extra"].map(name => ({path: `/${name}`, name, kinds: [name === "value" || name === "extra" ? "number" : "string"]}));
  const currentSources = (runIds: string[], sourceIds?: string[]) => Array.from({length: state.sourceCount}, (_, index) =>
    publishers[index] ?? {run: "run-1", source: `run-1-extra-${index}`, label: `Worker ${index}`}).flatMap((owner, index) => {
    if (!runIds.includes(owner.run) || sourceIds && !sourceIds.includes(owner.source)) return [];
    const source: TableSource = {run_id: owner.run, source_id: owner.source, snapshot_id: String(1000 + index * 100 + state.version), label: owner.label,
      role: index === 1 ? "rollout" : "learner", rank: index === 1 ? 1 : 0, node_id: "node-a", observed_at_ns: firstObservation + state.version * 1e9, row_count: state.total};
    snapshots.set(source.snapshot_id, source); totals.set(source.snapshot_id, state.total); return [source];
  });
  const scope = (body: {run_ids: string[]; source_ids?: string[]; snapshot_ids?: string[]}) =>
    body.snapshot_ids ? body.snapshot_ids.map(id => snapshots.get(id)!).filter(Boolean) : currentSources(body.run_ids, body.source_ids);
  const selected = {id: "visual", sectionId: "main", size: "normal" as const, kind: "snapshot-table" as const, path: "/tasks", title: "Task snapshots", view, ...overrides};
  await seedUiState(page, {selected: {"experiment-1": "visual-set"}, sets: [{
    id: "visual-set", name: "Snapshot analysis", experimentId: "experiment-1", sections: [{id: "main", name: "", collapsed: false}], panels: [selected],
  }]});
  await page.route("**/api/tables/catalog", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({json: {tables: [{path: "/tasks", name: "Tasks", columns: [{path: "$key", name: "Key"}, ...columns], collection_kinds: ["array"],
      sources: currentSources(body.run_ids, body.source_ids)}], truncated: false}});
  });
  await page.route("**/api/snapshots/records", async route => {
    const body: SnapshotRecordsRequest = route.request().postDataJSON(); calls.records.push(body);
    if (state.identityError) return route.fulfill({status: 400, json: {error: "Identity field /id must be unique across all filtered records."}});
    const sources = scope(body), total = sources.length ? totals.get(sources[0]!.snapshot_id)! : 0, offset = body.offset ?? 0;
    let indices = Array.from({length: total}, (_, index) => index);
    if (body.sort) {
      const {path, direction} = body.sort;
      indices.sort((a, b) => {
        const order = path === "/value" ? (a === b ? 0 : a === 0 ? 1 : b === 0 ? -1 : a - b)
          : `task-${String(a).padStart(6, "0")}`.localeCompare(`task-${String(b).padStart(6, "0")}`);
        return (direction === "desc" ? -order : order) || a - b;
      });
    }
    indices = indices.slice(offset, offset + (body.limit ?? 1000));
    const rows = indices.map(index => {
      const source = sources[index % sources.length]!;
      const id = `task-${String(index).padStart(6, "0")}`, version = Number(source.snapshot_id) % 100;
      const row: TableDataRow = {run_id: source.run_id, source_id: source.source_id, snapshot_id: source.snapshot_id,
        row_key: String(state.reverse ? 100_000 - index : index),
        cells: {"/id": cell(id), "/name": cell(`Task ${index}`), "/queue": cell(index % 2 ? "Long queue / secondary" : "Primary queue"),
          "/status": index === 0 && version > 0 ? cell("Failed") : states[index % states.length]!,
          "/value": cell(index === 0 ? "18446744073709551615" : String(index), "number"), "/extra": extraCell(index, total)}};
      savedRows.set(JSON.stringify([row.snapshot_id, row.source_id, row.row_key]), row); return row;
    });
    return route.fulfill({json: {columns, snapshots: sources, rows, identities: rows.map(row => `string:${row.cells["/id"]!.text}`), offset, limit: body.limit ?? 1000, total}});
  });
  await page.route("**/api/snapshots/aggregate", async route => {
    const body: SnapshotAggregateRequest = route.request().postDataJSON(); calls.aggregate.push(body);
    const sources = scope(body), total = sources.length ? totals.get(sources[0]!.snapshot_id)! : 0;
    if (body.group_by[0] === "/status") {
      if (gate) await gate;
      const version = Number(sources[0]?.snapshot_id ?? 1000) % 100;
      const choices = version ? [...states, cell("Failed")] : states;
      return route.fulfill({json: {groups: choices.map((status, index) => {
        const count = Math.floor(total / choices.length) + Number(index < total % choices.length);
        return {key: JSON.stringify([status.kind, status.text]), cells: [status],
          series: sources.map((source, ownerIndex) => {
            let rowCount = Math.floor(count / sources.length) + Number(ownerIndex < count % sources.length);
            const measures: Record<string, object> = {};
            if (body.measures.some(measure => measure.id === "shade_min")) {
              const indices = Array.from({length: total}, (_, index) => index).filter(index => {
                const current = index === 0 && version ? cell("Failed") : states[index % states.length]!;
                return index % sources.length === ownerIndex && current.kind === status.kind && current.text === status.text;
              });
              rowCount = indices.length;
              const values = indices.map(index => extraCell(index, total)), numeric = values.filter(value => value.kind === "number").map(value => BigInt(value.text));
              const missing = values.filter(value => value.kind === "missing" || value.kind === "null").length;
              for (const [id, smallest] of [["shade_min", true], ["shade_max", false]] as const) {
                if (state.badShadeRange && smallest) continue;
                const magnitudes = numeric.filter(value => value !== 0n).map(value => value < 0n ? -value : value);
                measures[id] = {value: numeric.length ? cell(String(numeric.reduce((a, b) => (smallest ? a < b : a > b) ? a : b)), "number") : cell("", "missing"),
                  ...(smallest ? {minimum_magnitude: magnitudes.length ? cell(String(magnitudes.reduce((a, b) => a < b ? a : b)), "number") : cell("", "missing")} : {}),
                  count: numeric.length, missing, non_numeric: rowCount - numeric.length - missing, approximate: false};
              }
            }
            measures.count = {value: cell(String(rowCount), "number"), count: 0, missing: 0, non_numeric: 0, approximate: false};
            return {run_id: source.run_id, source_id: source.source_id, snapshot_id: source.snapshot_id, measures};
          })};
      }), total_groups: state.tooManyStates ? 129 : choices.length, matched_rows: total, snapshots: sources, offset: 0, limit: body.limit ?? 128}});
    }
    return route.fulfill({json: {groups: ["Primary queue with a long category label that must wrap", "Secondary", "Unavailable"].map((name, index) => ({
      key: `queue-${index}`, cells: [cell(name)],
      series: sources.filter((_source, owner) => index !== 1 || owner === 0).map((source, owner) => ({run_id: source.run_id, source_id: source.source_id, snapshot_id: source.snapshot_id,
        measures: Object.fromEntries(body.measures.map((measure, field) => [measure.id, {
          value: measure.op === "count" ? cell("50000", "number")
            : index === 2 ? cell("missing", "missing")
              : index === 1 ? field ? cell("null", "null") : cell("0", "number")
                : owner === 0 ? cell(field ? "2" : "18446744073709551615", "number")
                  : owner === 1 ? field ? cell("missing", "missing") : cell("-5", "number") : cell(field ? "3" : "8", "number"),
          count: 20000, missing: index ? 12 : 0, non_numeric: index === 2 ? 4 : 0, approximate: false,
        }]))})),
    })), total_groups: 100, matched_rows: total, snapshots: sources, offset: 0, limit: body.limit ?? 3}});
  });
  await page.route("**/api/tables/rows", route => {
    const body: TableRowsRequest = route.request().postDataJSON(); calls.rows.push(body);
    const row = savedRows.get(JSON.stringify([body.snapshot_ids?.[0], body.source_ids?.[0], body.filters?.[0]?.value]));
    return route.fulfill({json: {columns: [...columns, {path: "/full_counter", name: "full_counter"}], snapshots: scope(body),
      rows: row ? [{...row, cells: {...row.cells, "/full_counter": cell("18446744073709551615", "number"), "/nested": {...cell('{"nested":"bounded"}', "object"), truncated: true}}}] : [],
      total: row ? 1 : 0, limit: 1, offset: 0}});
  });
  return {state, calls, base, holdCounts: () => {gate = new Promise<void>(resolve => {release = resolve;});},
    releaseCounts: () => {gate = null; release();}};
}

test("bars retain native mixed-Source values, exact labels, negative stacks and responsive categorical labels", async ({page}) => {
  const fixture = await visualFixture(page, barView, {query: {filters: [{path: "/status", op: "eq", value: "ignored", enabled: false}]}});
  await page.goto("/rvx?runs=run-1,run-2");
  const card = page.locator(".section-grid .snapshot-visual-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  expect(fixture.calls.aggregate[0]).toMatchObject({source_ids: publishers.map(owner => owner.source).sort(), group_by: ["/queue"],
    measures: [{id: "m0", op: "sum", path: "/value"}, {id: "m1", op: "sum", path: "/extra"}],
    order: {measure: "m0", direction: "desc"}, filters: [], limit: 3});
  await expect(card.locator(".sv-summary")).toContainText("Top 3 / 100");
  await expect(card.locator(".sv-bar-value").filter({hasText: "18446744073709551615"})).toHaveCount(1);
  await expect(card.locator('[data-kind="not-recorded"]')).toHaveCount(4);
  const negative = card.locator('rect[data-value="-5"]');
  await expect(negative).toHaveCount(1);
  expect(Number(await negative.getAttribute("data-end"))).toBeLessThan(0);
  await expect(negative).toHaveAttribute("data-start", "0");
  await expect(card.locator('rect[data-run="run-2"][data-field="m0"]')).toHaveAttribute("data-start", "0");
  const exact = card.locator(".sv-bar-value").filter({hasText: "18446744073709551615"});
  await exact.focus(); await expect(card.getByRole("tooltip")).toContainText("Reporter");
  await expect(card.getByRole("tooltip")).toContainText("20000 counted");
  await expect(card.getByRole("tooltip")).toContainText("18446744073709551615");
  await page.screenshot({path: "artifacts/snapshot-visual-bars-exact.png"});
  for (const width of [1200, 901, 600, 390]) {
    await page.setViewportSize({width, height: 900});
    expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await card.locator(".sv-category-label").first().evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true);
  }
  await expect(exact.locator(".sv-bar-value-label")).toBeHidden();
  await expect(exact).toHaveAttribute("aria-label", /value: 18446744073709551615$/);
  expect(await exact.innerText()).toBe("18446744073709551615");
  await page.screenshot({path: "artifacts/snapshot-visual-bars-mobile.png"});
  expect(fixture.base.some(call => /^\/api\/snapshots\/\d+$/.test(call.path))).toBe(false);
});

test("vertical grouped bars keep source ownership and zero/null distinctions", async ({page}) => {
  const fixture = await visualFixture(page, {...barView, orientation: "vertical", layout: "grouped"});
  await page.goto("/rvx?runs=run-1,run-2");
  const card = page.locator(".snapshot-visual-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  const starts = await card.locator("rect[data-sv-mark]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-start")));
  expect(starts.every(start => start === "0")).toBe(true);
  await expect(card.locator(".sv-bar-value").filter({hasText: "value: 0"})).toHaveCount(1);
  await expect(card.locator(".sv-bar-value[data-kind='null']")).toHaveCount(1);
  await page.screenshot({path: "artifacts/snapshot-visual-bars-vertical.png"});
  expect(fixture.calls.aggregate[0]?.snapshot_ids).toBeUndefined();
});

test("count bars issue one pathless measure and retain canonical label ordering", async ({page}) => {
  const fixture = await visualFixture(page, {...barView, aggregation: "count", valuePaths: [], order: "label"});
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".snapshot-visual-card")).toHaveAttribute("data-loaded", "true");
  expect(fixture.calls.aggregate[0]?.measures).toEqual([{id: "count", op: "count"}]);
  expect(fixture.calls.aggregate[0]?.order).toBeUndefined();
  await expect(page.locator(".sv-summary")).toHaveText("3 / 100 categories · 50000 rows");
});

test("overwhelming reporter/field traces fail explicitly rather than dropping Sources", async ({page}) => {
  const fixture = await visualFixture(page, barView); fixture.state.sourceCount = 33;
  await page.goto("/rvx?runs=run-1,run-2");
  await expect(page.locator(".sv-feedback")).toContainText("33 Sources × 2 fields");
  await expect(page.locator(".sv-feedback")).toContainText("64-trace");
  expect(fixture.calls.aggregate[0]?.source_ids).toHaveLength(33);
  await expect(page.locator(".sv-bar-track")).toHaveCount(0);
});

test("a 50k-task scope mounts a bounded page, full counts, stable identities and a pinned detail row", async ({page}) => {
  const fixture = await visualFixture(page, statusView, {query: {sort: {path: "/value", direction: "desc"}}});
  await page.clock.install();
  await page.goto("/rvx?runs=run-1,run-2");
  const card = page.locator(".section-grid .snapshot-visual-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  expect(fixture.calls.records[0]).toMatchObject({identity_paths: ["/id"], columns: ["/id", "/status", "/name", "/value"], limit: 1000, offset: 0});
  expect(fixture.calls.records[0]?.sort).toBeUndefined();
  expect(fixture.calls.aggregate[0]?.snapshot_ids).toEqual(["1000", "1100", "1200"]);
  await expect(card.locator(".sv-summary")).toHaveText("1–1000 / 50000 tasks");
  await expect(card.locator(".sv-state-key").filter({hasText: "Running"})).toContainText("8334");
  await expect(card.locator(".sv-state-key")).toHaveCount(6);
  await expect.poll(() => card.locator(".sv-task-cell").count()).toBeGreaterThan(0);
  expect(await card.locator(".sv-task-cell").count()).toBeLessThanOrEqual(800);
  const first = card.locator('[data-identity="string:task-000000"]'), original = await first.elementHandle();
  await first.focus(); await first.press("ArrowRight");
  await expect(first).not.toBeFocused();
  await card.locator(".sv-task-cell:focus").press("Home"); await expect(first).toBeFocused();
  await first.press("Enter");
  const drawer = page.getByRole("dialog", {name: "Task details", exact: true});
  await expect(drawer).toContainText("18446744073709551615");
  await expect(drawer).toContainText("full_counter");
  await expect(drawer).toContainText("[preview]");
  expect(fixture.calls.rows[0]).toMatchObject({snapshot_ids: ["1000"], source_ids: ["run-1-source-0"], run_ids: ["run-1"], path: "/tasks", filters: [{path: "$key", op: "eq", value: "0"}], limit: 1});
  expect(fixture.calls.rows[0]?.columns).toBeUndefined();
  await drawer.getByRole("button", {name: "Close", exact: true}).click(); await expect(first).toBeFocused();
  fixture.state.version = 1; fixture.state.reverse = true;
  await page.clock.fastForward(5100);
  await expect(first).toHaveAttribute("data-status", "Failed");
  await expect(first).toHaveAttribute("data-row-key", "100000");
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await expect(first).toBeFocused();
  await page.screenshot({path: "artifacts/snapshot-visual-status-grid.png"});
  expect(fixture.base.some(call => /^\/api\/snapshots\/\d+$/.test(call.path))).toBe(false);
});

test("status frames stage pinned counts atomically and slow reads survive shared cadence ticks", async ({page}) => {
  const fixture = await visualFixture(page, statusView);
  await page.clock.install(); await page.goto("/rvx?runs=run-1,run-2");
  const card = page.locator(".snapshot-visual-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  const first = card.locator('[data-identity="string:task-000000"]');
  fixture.state.version = 1; fixture.holdCounts();
  await page.clock.fastForward(5100);
  await expect.poll(() => fixture.calls.records.length).toBe(2);
  await expect.poll(() => fixture.calls.aggregate.length).toBe(2);
  await expect(first).toHaveAttribute("data-snapshot-id", "1000");
  await expect(card.locator(".chart-status")).toBeHidden();
  await page.clock.fastForward(5100);
  expect(fixture.calls.records.length).toBe(2);
  fixture.state.version = 2; fixture.releaseCounts();
  await expect(first).toHaveAttribute("data-snapshot-id", "1001");
  expect(fixture.calls.aggregate[1]?.snapshot_ids).toEqual(["1001", "1101", "1201"]);
  await page.clock.fastForward(5100); await expect(first).toHaveAttribute("data-snapshot-id", "1002");
  expect(fixture.calls.records.at(-1)?.snapshot_ids).toBeUndefined();
});

test("page shrink retries only the clamped page against returned snapshots, then resumes latest", async ({page}) => {
  const fixture = await visualFixture(page, statusView); fixture.state.total = 2500;
  await page.clock.install(); await page.goto("/rvx?runs=run-1");
  const card = page.locator(".snapshot-visual-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  await card.getByRole("button", {name: "Next task page"}).click();
  await expect(card.locator(".sv-summary")).toHaveText("1001–2000 / 2500 tasks");
  await card.getByRole("button", {name: "Next task page"}).click();
  await expect(card.locator(".sv-summary")).toHaveText("2001–2500 / 2500 tasks");
  fixture.state.total = 600; fixture.state.version = 1;
  await page.clock.fastForward(5100);
  await expect(card.locator(".sv-summary")).toHaveText("1–600 / 600 tasks");
  const retry = fixture.calls.records.at(-1)!;
  expect(retry).toMatchObject({offset: 0, snapshot_ids: ["1001", "1101"]});
  await page.clock.fastForward(5100);
  await expect.poll(() => fixture.calls.records.at(-1)?.snapshot_ids).toBeUndefined();
});

test("state colors save without reads; filters remain reusable; fullscreen retains the same bounded DOM", async ({page}) => {
  const fixture = await visualFixture(page, statusView, {query: {filters: [{path: "/status", op: "eq", value: "Running", enabled: false}]}});
  await page.clock.install(); await page.goto("/rvx?runs=run-1,run-2");
  const card = page.locator(".snapshot-visual-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  const original = await card.elementHandle(), before = fixture.calls.records.length;
  await card.getByLabel("Color for Running", {exact: true}).evaluate((node: HTMLInputElement) => {node.value = "#123456"; node.dispatchEvent(new Event("change", {bubbles: true}));});
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  expect(fixture.calls.records.length).toBe(before);
  await page.getByRole("button", {name: "Save current workspace"}).click();
  await expect.poll(async () => (await serverState(page)).workspaces.sets[0]!.panels[0]).toMatchObject({view: {colors: {Running: "#123456"}}});
  await card.getByRole("button", {name: "Filter", exact: true}).click();
  const filters = page.getByRole("dialog", {name: "Filter rows"});
  await filters.getByRole("checkbox", {name: "Enable filter 1"}).check();
  await expect.poll(() => fixture.calls.records.at(-1)?.filters).toEqual([{path: "/status", op: "eq", value: "Running"}]);
  await filters.getByRole("checkbox", {name: "Enable filter 1"}).uncheck();
  await expect.poll(() => fixture.calls.records.at(-1)?.filters).toEqual([]);
  await filters.getByRole("button", {name: "Close", exact: true}).click();
  await card.locator(".menu-trigger").click(); await card.getByRole("menuitem", {name: "Fullscreen", exact: true}).click();
  await expect(card).toHaveClass(/is-expanded/);
  expect(await original!.evaluate(node => node.isConnected && node.classList.contains("is-expanded"))).toBe(true);
  expect(await card.locator(".sv-task-cell").count()).toBeLessThanOrEqual(1800);
  const performance = await card.locator(".sv-status-canvas").evaluate(node => {
    let mutations = 0;
    const observer = new MutationObserver(records => {mutations += records.length;}); observer.observe(node, {subtree: true, attributes: true, childList: true});
    const target = node.querySelector("button")!, started = globalThis.performance.now();
    for (let index = 0; index < 500; index++) target.dispatchEvent(new PointerEvent("pointermove", {bubbles: true, clientX: index % 100}));
    const milliseconds = globalThis.performance.now() - started;
    mutations += observer.takeRecords().length; observer.disconnect();
    return {milliseconds, mutations, buttons: node.querySelectorAll("button").length};
  });
  expect(performance.mutations).toBe(0); expect(performance.milliseconds).toBeLessThan(250);
  test.info().annotations.push({type: "snapshot-perf", description: JSON.stringify(performance)});
  console.log("snapshot visual measured pointer performance", performance);
  await page.screenshot({path: "artifacts/snapshot-visual-status-fullscreen.png"});
  await page.getByRole("dialog").filter({has: card}).getByRole("button", {name: "Close", exact: true}).click();
  await card.locator(".menu-trigger").click(); await card.getByRole("menuitem", {name: "Remove snapshot", exact: true}).click();
  await expect(card).toHaveCount(0);
  const calls = fixture.calls.records.length; await page.clock.fastForward(5100); expect(fixture.calls.records.length).toBe(calls);
  await expect(page.locator(".sv-tooltip")).toHaveCount(0);
});

test("explicit empty Sources remain an actionable error rather than silently selecting All", async ({page}) => {
  const fixture = await visualFixture(page, statusView, {sourceIds: []});
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".sv-feedback")).toContainText("Select at least one Source");
  expect(fixture.calls.records).toHaveLength(0); expect(fixture.calls.aggregate).toHaveLength(0);
});

test("scope changes clear old task identities while cancelled counts are still pending", async ({page}) => {
  const fixture = await visualFixture(page, {...statusView, groupPath: "/queue"});
  await page.clock.install(); await page.goto("/rvx?runs=run-1,run-2");
  const card = page.locator(".snapshot-visual-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  await expect(card.locator(".sv-task-group").first()).toHaveText(/^queue: .+ · .+ · Learner$/);
  fixture.state.version = 1; fixture.holdCounts();
  await page.clock.fastForward(5100);
  await expect.poll(() => fixture.calls.aggregate.length).toBe(2);
  await page.locator(".runs-selector").getByRole("checkbox", {name: "Select grpo · baseline", exact: true}).uncheck();
  await expect(card.locator(".sv-task-cell")).toHaveCount(0);
  fixture.releaseCounts();
  await expect(card).toHaveAttribute("data-loaded", "true");
  expect(fixture.calls.records.at(-1)?.run_ids).toEqual(["run-1"]);
  await expect(card.locator('.sv-task-cell[data-run="run-2"]')).toHaveCount(0);
});

test("browser suspension cancels a pending aggregate without exposing half-updated tasks", async ({page}) => {
  const fixture = await visualFixture(page, statusView);
  await page.clock.install(); await page.goto("/rvx?runs=run-1");
  const card = page.locator(".snapshot-visual-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  fixture.state.version = 1; fixture.holdCounts();
  await page.clock.fastForward(5100);
  await expect.poll(() => fixture.calls.aggregate.length).toBe(2);
  const cancelled = page.waitForEvent("requestfailed", request => request.url().endsWith("/api/snapshots/aggregate"));
  await page.evaluate(() => {Object.defineProperty(document, "hidden", {configurable: true, value: true}); document.dispatchEvent(new Event("visibilitychange"));});
  await cancelled;
  fixture.releaseCounts();
  await expect(card.locator(".sv-task-cell").first()).toHaveAttribute("data-snapshot-id", "1000");
  const reads = fixture.calls.records.length;
  await page.clock.fastForward(5100); expect(fixture.calls.records.length).toBe(reads);
  await page.evaluate(() => {Reflect.deleteProperty(document, "hidden"); document.dispatchEvent(new Event("visibilitychange"));});
  await page.clock.fastForward(5100);
  await expect(card.locator(".sv-task-cell").first()).toHaveAttribute("data-snapshot-id", "1001");
});

test("native whole-dataset identity rejection is not replaced by index identity", async ({page}) => {
  const fixture = await visualFixture(page, statusView); fixture.state.identityError = true;
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".sv-feedback")).toContainText("unique across all filtered records");
  await expect(page.locator(".sv-task-cell")).toHaveCount(0); expect(fixture.calls.aggregate).toHaveLength(0);
});

test("noncategorical status fields are rejected explicitly instead of truncating the legend", async ({page}) => {
  const fixture = await visualFixture(page, statusView); fixture.state.tooManyStates = true;
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".sv-feedback")).toContainText("Choose a categorical status field");
  await expect(page.locator(".sv-task-cell")).toHaveCount(0);
});

test("grouped tasks prioritize group labels and reflow inside the viewport after fullscreen and resizing", async ({page}) => {
  const fixture = await visualFixture(page, {...statusView, groupPath: "/queue"});
  fixture.state.sourceCount = 1;
  await page.goto("/rvx?runs=run-1");
  const card = page.locator(".snapshot-visual-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  await expect(card.locator(".sv-task-group").first()).toHaveText(/^queue: .+ · .+/);
  await expect(card.locator(".sv-task-group").first()).not.toContainText("Learner");
  await card.locator(".menu-trigger").click();
  await card.getByRole("menuitem", {name: "Fullscreen", exact: true}).click();
  await expect(card).toHaveClass(/is-expanded/);
  await page.keyboard.press("Escape");
  await expect(card).not.toHaveClass(/is-expanded/);
  for (const width of [1440, 901, 600, 390]) {
    await page.setViewportSize({width, height: 844});
    await card.scrollIntoViewIfNeeded();
    await expect.poll(() => card.evaluate(node => {
      const viewport = node.querySelector(".sv-status-viewport")!.getBoundingClientRect();
      const cells = [...node.querySelectorAll(".sv-task-cell")];
      return cells.length > 0 && cells.every(cell => {
        const box = cell.getBoundingClientRect();
        return box.left >= viewport.left && box.right <= viewport.right + 1;
      });
    })).toBe(true);
    expect(await card.locator(".sv-task-cell").count()).toBeLessThanOrEqual(800);
  }
  await page.screenshot({path: "artifacts/snapshot-visual-status-mobile-reflow.png"});
});

test("Arrange sorts complete task pages and persists responsive geometry without presentation-only reads", async ({page}) => {
  const fixture = await visualFixture(page, statusView, {query: {sort: {path: "/extra", direction: "desc"}}});
  fixture.state.total = 2500; fixture.state.sourceCount = 1;
  await page.clock.install(); await page.goto("/rvx?runs=run-1");
  const card = page.locator(".snapshot-visual-card");
  const firstIdentity = () => card.locator(".sv-task-cell").evaluateAll(nodes => nodes
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]?.getAttribute("data-identity"));
  await expect(card).toHaveAttribute("data-loaded", "true");
  await card.getByRole("button", {name: "Arrange", exact: true}).click();
  const arrange = page.getByRole("dialog", {name: "Arrange tasks", exact: true});
  await expect(arrange.getByRole("combobox", {name: "Sort direction", exact: true})).toBeDisabled();
  await arrange.getByRole("combobox", {name: "Sort by", exact: true}).selectOption("/value");
  await expect.poll(firstIdentity).toBe("string:task-000001");
  expect(fixture.calls.records.at(-1)).toMatchObject({offset: 0, sort: {path: "/value", direction: "asc"}});
  await page.keyboard.press("Escape");
  await card.getByRole("button", {name: "Next task page"}).click();
  await expect(card.locator(".sv-summary")).toHaveText("1001–2000 / 2500 tasks");
  await expect.poll(firstIdentity).toBe("string:task-001001");
  await card.getByRole("button", {name: "Arrange", exact: true}).click();
  await arrange.getByRole("combobox", {name: "Sort direction", exact: true}).selectOption("desc");
  await expect(card.locator(".sv-summary")).toHaveText("1–1000 / 2500 tasks");
  await expect.poll(firstIdentity).toBe("string:task-000000");
  expect(fixture.calls.records.at(-1)).toMatchObject({offset: 0, sort: {path: "/value", direction: "desc"}});
  const requests = [fixture.calls.records.length, fixture.calls.aggregate.length];
  for (const [name, value] of [["Columns", "12"], ["Cell size", "24"], ["Gap", "6"]]) {
    await arrange.getByRole("combobox", {name, exact: true}).selectOption(value!);
  }
  await expect(card.locator(".sv-status-canvas")).toHaveAttribute("data-columns", "12");
  await expect(card.locator('[data-identity="string:task-000000"]')).toHaveCSS("width", "24px");
  expect([fixture.calls.records.length, fixture.calls.aggregate.length]).toEqual(requests);
  await page.screenshot({path: "artifacts/snapshot-status-arrange-desktop.png"});
  await page.keyboard.press("Escape");
  await expect(arrange).toHaveCount(0);
  await page.getByRole("button", {name: "Save current workspace"}).click();
  const saved = (await serverState(page)).workspaces.sets[0]!.panels[0]!;
  expect(saved).toMatchObject({query: {sort: {path: "/extra", direction: "desc"}},
    view: {sort: {path: "/value", direction: "desc"}, columns: 12, cellSize: 24, gap: 6}});
  await page.reload(); await expect(card).toHaveAttribute("data-loaded", "true");
  await card.getByRole("button", {name: "Arrange", exact: true}).click();
  await expect(arrange.getByRole("combobox", {name: "Columns", exact: true})).toHaveValue("12");
  await expect(arrange.getByRole("combobox", {name: "Sort direction", exact: true})).toHaveValue("desc");
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
  await page.setViewportSize({width: 390, height: 844});
  await card.scrollIntoViewIfNeeded();
  await expect.poll(() => card.evaluate(node => {
    const viewport = node.querySelector(".sv-status-viewport")!.getBoundingClientRect();
    const cells = [...node.querySelectorAll(".sv-task-cell")];
    return cells.length > 0 && cells.every(cell => cell.getBoundingClientRect().right <= viewport.right + 1);
  })).toBe(true);
  await card.getByRole("button", {name: "Arrange", exact: true}).click();
  await expect(arrange.getByRole("combobox", {name: "Columns", exact: true})).toHaveValue("12");
  expect(await arrange.evaluate(node => node.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.screenshot({path: "artifacts/snapshot-status-arrange-mobile-dark.png"});
  await arrange.getByRole("combobox", {name: "Sort by", exact: true}).selectOption("__choose_snapshot_field__");
  await expect.poll(() => fixture.calls.records.at(-1)?.sort).toBeUndefined();
  await page.keyboard.press("Escape");
  await card.locator(".menu-trigger").click();
  await card.getByRole("menuitem", {name: "Remove snapshot", exact: true}).click();
  await expect(page.getByRole("dialog", {name: "Arrange tasks", exact: true})).toHaveCount(0);
});

test("Shade by keeps status hues, uses a pinned full-scope range and preserves the last complete frame", async ({page}) => {
  const fixture = await visualFixture(page, statusView);
  fixture.state.total = 1200; fixture.state.sourceCount = 1;
  await page.clock.install(); await page.goto("/rvx?runs=run-1");
  const card = page.locator(".snapshot-visual-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  await card.getByRole("button", {name: "Arrange", exact: true}).click();
  const arrange = page.getByRole("dialog", {name: "Arrange tasks", exact: true});
  await arrange.getByRole("combobox", {name: "Shade by", exact: true}).selectOption("/extra");
  await expect(card.locator(".sv-shade-key")).toContainText("0 – 200");
  await expect(card.locator(".sv-shade-key")).toHaveAttribute("data-scale", "log");
  expect(fixture.calls.records.at(-1)?.columns).toContain("/extra");
  expect(fixture.calls.aggregate.at(-1)).toMatchObject({snapshot_ids: ["1000"], measures: [
    {id: "count", op: "count"}, {id: "shade_min", op: "min", path: "/extra"}, {id: "shade_max", op: "max", path: "/extra"},
  ]});
  const zero = card.locator('[data-identity="string:task-000000"]');
  await expect(zero).toHaveAttribute("data-shade", "numeric");
  expect(await zero.evaluate(node => node.style.getPropertyValue("--sv-shade"))).toBe("24%");
  expect(await zero.evaluate(node => node.style.getPropertyValue("--sv-state"))).toBe("#427fc4");
  await expect(zero).toHaveCSS("background-image", "none");
  await expect(zero).toHaveCSS("box-shadow", "none");
  await expect(zero).toHaveCSS("border-radius", "2px");
  const requests = [fixture.calls.records.length, fixture.calls.aggregate.length];
  const size = card.locator('[data-identity="string:task-000010"]');
  const logShade = await size.evaluate(node => parseFloat(node.style.getPropertyValue("--sv-shade")));
  await arrange.getByRole("combobox", {name: "Shade scale", exact: true}).selectOption("linear");
  const linearShade = await size.evaluate(node => parseFloat(node.style.getPropertyValue("--sv-shade")));
  expect(logShade - linearShade).toBeGreaterThan(25);
  await arrange.getByRole("combobox", {name: "Shade scale", exact: true}).selectOption("log");
  expect([fixture.calls.records.length, fixture.calls.aggregate.length]).toEqual(requests);
  for (const index of [1, 2, 3]) await expect(card.locator(`[data-identity="string:task-${String(index).padStart(6, "0")}"]`)).toHaveAttribute("data-shade", "unavailable");
  await page.screenshot({path: "artifacts/snapshot-status-shade-controls.png"});
  await page.keyboard.press("Escape");
  await card.locator('[data-identity="string:task-000001"]').hover();
  await expect(card.getByRole("tooltip")).toContainText("Unavailable");
  await page.getByRole("button", {name: "Save current workspace"}).click();
  expect((await serverState(page)).workspaces.sets[0]!.panels[0]).toMatchObject({view: {shadePath: "/extra", shadeScale: "log"}});
  await card.getByRole("button", {name: "Next task page"}).click();
  await expect(card.locator(".sv-summary")).toHaveText("1001–1200 / 1200 tasks");
  await expect(card.locator(".sv-shade-key")).toContainText("0 – 200");
  await expect(card.locator('[data-identity="string:task-001199"]')).toHaveAttribute("data-shade", "numeric");
  expect(await card.locator('[data-identity="string:task-001199"]').evaluate(node => node.style.getPropertyValue("--sv-shade"))).toBe("96%");
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
  await page.setViewportSize({width: 390, height: 844}); await card.scrollIntoViewIfNeeded();
  await page.screenshot({path: "artifacts/snapshot-status-shade-mobile.png"});
  fixture.state.version = 1; fixture.state.badShadeRange = true;
  await page.clock.fastForward(5100);
  await expect(card.locator(".sv-feedback")).toContainText("shade range is incomplete");
  await expect(card.locator(".sv-task-cell").first()).toHaveAttribute("data-snapshot-id", "1000");
  await card.getByRole("button", {name: "Arrange", exact: true}).click();
  await arrange.getByRole("combobox", {name: "Shade by", exact: true}).selectOption("__choose_snapshot_field__");
  await expect(card.locator(".sv-shade-key")).toHaveCount(0);
  await expect(card.locator(".sv-feedback")).toBeHidden();
  await expect(card.locator(".sv-task-cell").first()).toHaveAttribute("data-shade", "none");
});

test.describe("touch snapshot matrices", () => {
  test.use({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  test("task taps open bounded exact details without horizontal page overflow", async ({page}) => {
    const fixture = await visualFixture(page, statusView);
    await page.goto("/rvx?runs=run-1");
    const card = page.locator(".snapshot-visual-card");
    await expect(card).toHaveAttribute("data-loaded", "true");
    await card.locator(".sv-task-cell").first().tap();
    const drawer = page.getByRole("dialog", {name: "Task details"});
    await expect(drawer).toContainText("18446744073709551615");
    expect(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({path: "artifacts/snapshot-visual-task-touch.png"});
    await drawer.getByRole("button", {name: "Close", exact: true}).tap();
    expect(fixture.calls.rows[0]?.snapshot_ids).toEqual(["1000"]);
    expect(await card.locator(".sv-task-cell").count()).toBeLessThanOrEqual(800);
  });
});
