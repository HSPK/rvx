import {test, expect} from "@playwright/test";
import {firstObservation, mockApi, selectAddType, seedUiState, serverState} from "./fixtures";

test("saved filters on unavailable fields are rejected visibly, never silently dropped", async ({page}) => {
  await mockApi(page);
  await seedUiState(page, {
    theme: "light", selected: {"experiment-1": "filtered"},
    sets: [{id: "filtered", name: "Filtered", experimentId: "experiment-1",
      sections: [{id: "initial", name: "", collapsed: false}],
      panels: [{id: "table", sectionId: "initial", kind: "snapshot-table", size: "wide", path: "/tasks",
        query: {filters: [{path: "/removed", op: "eq", value: "running"}]}}]}],
  });
  let rejected = 0;
  await page.route("**/api/tables/rows", async route => {
    if (route.request().postDataJSON().filters.some((filter: {path: string}) => filter.path === "/removed")) {
      rejected++;
      await route.fulfill({status: 400, contentType: "application/json", json: {error: 'unknown table column "/removed" in selected snapshots'}});
    } else await route.fallback();
  });
  await page.goto("/rvx?runs=run-1&live=0");
  const table = page.locator(".section-grid .table-card");
  await expect(table.locator(".table-feedback")).toContainText('unknown table column "/removed"');
  await expect(table.locator(".chart-status")).toHaveText("Request failed");
  expect(rejected).toBeGreaterThan(0);
  await table.getByRole("button", {name: "Filter", exact: true}).click();
  await page.getByRole("button", {name: "Disable all", exact: true}).click();
  await expect(table.locator("tbody tr")).toHaveCount(75);
  await expect(table.locator(".chart-status")).toBeHidden();
});

test("snapshot collection defaults select actual publishers and always request latest while paging", async ({page}) => {
  const requests = await mockApi(page, {tableRows: 200});
  let unscopedReads = 0;
  await page.route("**/api/tables/rows", async route => {
    const body = route.request().postDataJSON();
    if (JSON.stringify(body.source_ids) !== '["run-1-source-0"]' || body.snapshot_ids && body.snapshot_ids.length !== body.source_ids.length) {
      unscopedReads++;
      await route.fulfill({status: 400, body: "A selected source does not publish this collection or is missing a pin."});
    } else await route.fallback();
  });
  await page.goto("/rvx?runs=run-1&live=0");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "snapshot-table");
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(75);
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const table = page.locator(".section-grid .table-card").last();
  await table.scrollIntoViewIfNeeded(); await expect(table.locator("tbody tr")).toHaveCount(75);
  await table.getByRole("button", {name: "Next page"}).click();
  await expect(table.locator(".table-footer")).toContainText("76–150");
  const request = requests.filter(request => request.path === "/api/tables/rows").at(-1)!.body!;
  expect(request.source_ids).toEqual(["run-1-source-0"]);
  expect(request.snapshot_ids).toBeUndefined();
  expect(unscopedReads).toBe(0);
});

test("summary keeps registered zero-count and missing-only sources for paths indexed in the selected scope", async ({page}) => {
  await mockApi(page);
  let metadataReads = 0;
  let requestedPaths: string[] = [];
  await seedUiState(page, {
    theme: "light", selected: {"experiment-1": "summary"},
    sets: [{id: "summary", name: "Missing metric", experimentId: "experiment-1",
      sections: [{id: "initial", name: "", collapsed: false}],
      panels: [{id: "summary-panel", sectionId: "initial", kind: "metric-table", size: "wide", paths: ["/progress/loss"],
        sourceIds: ["cold-reporter", "run-1-source-0"]}]}],
  });
  await page.route("**/api/tables/summary", route => {
    requestedPaths = route.request().postDataJSON().paths;
    return route.fulfill({json: {
    axis: "elapsed", rows: [
      {run_id: "run-1", source_id: "cold-reporter", path: "/progress/loss", observations: 0, count: 0, missing: 0,
        current: null, minimum: null, average: null, p95: null, maximum: null, snapshot_id: null, observed_at_ns: null},
      {run_id: "run-1", source_id: "run-1-source-0", path: "/progress/loss", observations: 2, count: 0, missing: 2,
        current: null, minimum: null, average: null, p95: null, maximum: null, snapshot_id: "2", observed_at_ns: firstObservation + 60e9},
    ],
  }});});
  await page.route("**/api/experiments/sources?*", route => {
    metadataReads++;
    return route.fulfill({json: {sources: [{
    id: "cold-reporter", run_id: "run-1", attempt_id: "attempt-1", role: "evaluator", endpoint: "http://unused.test",
    node_id: null, rank: 1, state: "discovered", source_session_id: null, last_success_at_ns: null, last_error: null,
    scrape_interval_ms: 1000, timeout_ms: 5000, descriptor: null,
  }]}});});
  await page.goto("/rvx?runs=run-1&live=0");
  const table = page.locator(".section-grid .table-card");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  const cold = table.locator("tbody tr").filter({hasText: "Evaluator 1"});
  await expect(cold.locator('[data-column="count"]')).toHaveText("0");
  await expect(cold.locator('[data-column="current"]')).toHaveText("null");
  await expect(cold.getByRole("button", {name: /^Inspect/})).toHaveCount(0);
  const missing = table.locator('tbody tr[data-snapshot-id="2"]');
  await expect(missing.locator('[data-column="missing"]')).toHaveText("2");
  await expect(missing.locator('[data-column="current"]')).toHaveText("null");
  await expect(missing.getByRole("button", {name: /^Inspect/})).toHaveCount(0);
  expect(requestedPaths).toEqual(["/progress/loss"]);
  expect(metadataReads).toBe(1);
  await page.screenshot({path: "artifacts/summary-zero-and-missing-sources.png"});
});

test("unindexed saved summary fields are explicit without invalidating indexed siblings", async ({page}) => {
  const requests = await mockApi(page);
  await seedUiState(page, {
    theme: "light", selected: {"experiment-1": "summary"},
    sets: [{id: "summary", name: "Mixed fields", experimentId: "experiment-1",
      sections: [{id: "initial", name: "", collapsed: false}],
      panels: [{id: "summary-panel", sectionId: "initial", kind: "metric-table", size: "wide", paths: ["/progress/loss", "/not_indexed"]}]}],
  });
  let invalidRequests = 0;
  await page.route("**/api/tables/summary", async route => {
    if (route.request().postDataJSON().paths.includes("/not_indexed")) {
      invalidRequests++; await route.fulfill({status: 400, body: "Summary paths must be indexed in the selected scope."});
    } else await route.fallback();
  });
  await page.goto("/rvx?runs=run-1&live=0");
  const table = page.locator(".section-grid .table-card");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator(".table-availability")).toContainText("Not recorded in the selected scope: /not_indexed");
  await expect(table.locator("tbody tr").first().locator('[data-column="@metric"]')).toHaveText("Policy loss");
  expect(invalidRequests).toBe(0);
  expect(requests.filter(request => request.path === "/api/tables/summary").at(-1)?.body?.paths).toEqual(["/progress/loss"]);
  expect(requests.filter(request => request.path === "/api/tables/summary").at(-1)?.body?.source_ids).toEqual(["run-1-source-0"]);
});

test("summary coverage respects an explicit reporter subset instead of inventing zero statistics", async ({page}) => {
  const requests = await mockApi(page);
  await seedUiState(page, {
    theme: "light", selected: {"experiment-1": "summary"},
    sets: [{id: "summary", name: "Worker fields", experimentId: "experiment-1",
      sections: [{id: "initial", name: "", collapsed: false}],
      panels: [{id: "summary-panel", sectionId: "initial", kind: "metric-table", size: "wide",
        paths: ["/progress/loss", "/workers/throughput"], sourceIds: ["run-1-source-1"]}]}],
  });
  await page.goto("/rvx?runs=run-1&live=0");
  const table = page.locator(".section-grid .table-card");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator(".table-availability")).toContainText("Not recorded in the selected scope: /progress/loss");
  await expect(table.locator('tbody [data-column="@source"]')).toContainText("Rollout worker 1");
  const summary = requests.filter(request => request.path === "/api/tables/summary").at(-1)?.body;
  expect(summary?.paths).toEqual(["/workers/throughput"]);
  expect(summary?.source_ids).toEqual(["run-1-source-1"]);
});

test("section creation cannot exceed the persistent format's supported count", async ({page}) => {
  await mockApi(page);
  await seedUiState(page, {
    theme: "light", selected: {"experiment-1": "groups"},
    sets: [{id: "groups", name: "Many groups", experimentId: "experiment-1",
      sections: Array.from({length: 24}, (_, index) => ({id: `section-${index}`, name: `Group ${index}`, collapsed: true})),
      panels: []}],
  });
  await page.goto("/rvx?runs=run-1&live=0");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "section");
  await editor.getByRole("textbox", {name: "Panel title"}).fill("One too many");
  await expect(editor.getByRole("alert")).toContainText("24 sections");
  await expect(editor.getByRole("button", {name: "Add", exact: true})).toBeDisabled();
  await editor.getByRole("button", {name: "Cancel"}).click();
  await expect(page.locator(".workspace-section")).toHaveCount(24);
  expect((await serverState(page)).workspaces.sets[0]!.sections.length).toBe(24);
});
