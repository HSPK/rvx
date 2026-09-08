import {selectAddType} from "./fixtures";
import {test, expect} from "@playwright/test";
import {mkdir, readFile, writeFile} from "node:fs/promises";

interface RealFixture {
  base_url: string;
  runs: {id: string; name: string}[];
  worker_source: {id: string};
  hostmon_replay?: {run: {id: string; name: string}; source: {id: string}};
  oracle: {run_id: string; source_id: string; observations: number; count: number; missing: number; current: number | null; minimum: number; average: number; p95: number; maximum: number}[];
}

const fixtureFile = process.env.RVX_REAL_FIXTURE_FILE;
test.skip(!fixtureFile, "Set RVX_REAL_FIXTURE_FILE and RVX_TEST_BASE_URL to run against the parent-owned read-only SDK/Pull fixture.");

test("real SDK/Pull data renders authoritative summaries, latest worker rows, and combined chart evidence", async ({page}) => {
  test.setTimeout(90_000);
  if (!fixtureFile) return;
  const fixture: RealFixture = JSON.parse(await readFile(fixtureFile, "utf8"));
  const readOnlyPosts = new Set(["/api/charts/catalog", "/api/snapshots/query", "/api/tables/catalog", "/api/tables/summary", "/api/tables/rows"]);
  const unexpectedWrites: string[] = [], errors: string[] = [], rowRequests: Record<string, unknown>[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && request.method() !== "HEAD" && !readOnlyPosts.has(path)) unexpectedWrites.push(`${request.method()} ${path}`);
    if (path === "/api/tables/rows") rowRequests.push(request.postDataJSON());
  });

  page.on("pageerror", error => errors.push(error.message));
  const runIds = fixture.runs.map(run => run.id);
  await page.goto(`/rvx?runs=${runIds.join(",")}&live=0`);
  expect(new URL(page.url()).origin).toBe(fixture.base_url);
  await expect(page.locator(".section-grid canvas").first()).toBeVisible();

  await page.getByRole("button", {name: "Add", exact: true}).click();
  let editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "metric-table");
  await editor.getByRole("searchbox", {name: "Search metrics"}).fill("Loss");
  await editor.getByRole("checkbox", {name: "Select metric Loss", exact: true}).check();
  await expect(editor.locator(".table-preview tbody tr").first()).toBeVisible();
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const summary = page.locator(".section-grid .table-card").last();
  await summary.scrollIntoViewIfNeeded();
  await expect(summary.locator("tbody tr").first()).toBeVisible();
  await summary.getByRole("button", {name: "Columns", exact: true}).click();
  const columns = page.getByRole("dialog", {name: "Columns", exact: true});
  await columns.getByRole("checkbox", {name: "Show Observations", exact: true}).check();
  await columns.getByRole("button", {name: "Close", exact: true}).click();
  const summaryProof: object[] = [];
  for (const expected of fixture.oracle) {
    const row = summary.locator(`tbody tr[data-row-key*="${expected.source_id}"]`);
    await expect(row).toHaveCount(1);
    const actual: Record<string, number | null> = {};
    for (const key of ["observations", "count", "missing", "current", "minimum", "average", "p95", "maximum"] as const) {
      const text = await row.locator(`[data-column="${key}"]`).innerText();
      actual[key] = text === "null" ? null : Number(text);
      if (expected[key] === null) expect(actual[key]).toBeNull();
      else expect(actual[key]).toBeCloseTo(expected[key]!, 12);
    }
    expect(actual.observations).toBeGreaterThan(1600);
    summaryProof.push({sourceId: expected.source_id, actual});
  }
  await mkdir("artifacts", {recursive: true});
  await page.screenshot({path: "artifacts/real-sdk-summary.png"});

  await page.getByRole("button", {name: "Add", exact: true}).click();
  editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "snapshot-table");
  await editor.getByRole("searchbox", {name: "Search collections"}).fill("workers");
  await editor.locator('.collection-option[data-path="/workers"]').click();
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(75);
  await expect(editor.getByRole("button", {name: /^Inspect/})).toHaveCount(0);
  await page.screenshot({path: "artifacts/real-sdk-worker-preview.png"});
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const workers = page.locator(".section-grid .table-card").last();
  await workers.scrollIntoViewIfNeeded();
  await expect(workers.locator("tbody tr")).toHaveCount(75);
  await expect(workers.locator(".table-footer")).toContainText("10,001");
  await expect(workers.locator("tbody tr").first().locator('[data-column="/processed"]')).toHaveText("18446744073709551615");
  const observedSnapshot = await workers.locator("tbody tr").first().getAttribute("data-snapshot-id");
  await workers.getByRole("button", {name: "Next page"}).click();
  await expect(workers.locator(".table-footer")).toContainText("76–150");
  await expect(workers.locator("tbody tr").first()).toHaveAttribute("data-snapshot-id", observedSnapshot!);
  const paged = rowRequests.at(-1)!;
  expect(paged.source_ids).toEqual([fixture.worker_source.id]);
  expect(paged.snapshot_ids).toBeUndefined();
  await workers.getByRole("searchbox", {name: "Search table rows"}).fill("worker-00000");
  await expect(workers.locator("tbody tr")).toHaveCount(1);
  await expect(workers.locator("tbody tr").first().locator('[data-column="/processed"]')).toHaveText("18446744073709551615");
  await expect(workers.locator("tbody tr").first().locator('[data-column="/note"]')).toHaveAttribute("data-kind", "null");
  await expect(workers.getByRole("button", {name: /^Inspect/})).toHaveCount(0);
  await workers.getByRole("searchbox", {name: "Search table rows"}).fill("worker-00002");
  await expect(workers.locator("tbody tr")).toHaveCount(1);
  await expect(workers.locator('tbody [data-column="/note"]')).toHaveText("missing");
  await workers.getByRole("searchbox", {name: "Search table rows"}).fill("worker-00003");
  await expect(workers.locator("tbody tr")).toHaveCount(1);
  await expect(workers.locator('tbody [data-column="/note"]')).toHaveText('""');
  await workers.getByRole("searchbox", {name: "Search table rows"}).fill("");
  await expect(workers.locator("tbody tr")).toHaveCount(75);
  await workers.getByRole("button", {name: "gpu_percent", exact: true}).click();
  await workers.getByRole("button", {name: "gpu_percent", exact: true}).click();
  await expect(workers.locator('th[data-column="/gpu_percent"]')).toHaveAttribute("aria-sort", "descending");
  await expect(workers.locator("tbody tr").first().locator('[data-column="/gpu_percent"]')).toHaveText("100");
  await expect(workers.locator(".chart-status")).toBeHidden();
  const values = await workers.locator('tbody [data-column="/gpu_percent"]').allTextContents();
  expect(values).toHaveLength(75);
  expect(values.map(Number)).toEqual(values.map(Number).sort((a, b) => b - a));
  await workers.scrollIntoViewIfNeeded();
  await page.screenshot({path: "artifacts/real-sdk-workers-latest.png"});

  await page.getByRole("button", {name: "Add", exact: true}).click();
  editor = page.getByRole("dialog", {name: "Add", exact: true});
  await editor.getByRole("searchbox", {name: "Search metrics"}).fill("Loss");
  await editor.getByRole("checkbox", {name: "Select metric Loss", exact: true}).check();
  await editor.getByRole("searchbox", {name: "Search metrics"}).fill("Score");
  await editor.getByRole("checkbox", {name: "Select metric Score", exact: true}).check();
  await editor.getByRole("combobox", {name: "Chart layout"}).selectOption("combined");
  await expect(editor.locator(".chart-preview canvas")).toBeVisible();
  await expect(editor.locator(".chart-preview .legend-item")).toHaveCount(4);
  await page.screenshot({path: "artifacts/real-sdk-combined-preview.png"});
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const combined = page.locator(".section-grid .chart-card").last();
  await combined.scrollIntoViewIfNeeded(); await expect(combined.locator("canvas")).toBeVisible();
  const canvas = await combined.locator("canvas").elementHandle();
  await combined.locator(".menu-trigger").click();
  await combined.getByRole("menuitem", {name: "Fullscreen", exact: true}).click();
  const fullscreen = page.locator(".panel-fullscreen");
  await expect(fullscreen).toBeVisible();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await page.screenshot({path: "artifacts/real-sdk-combined-fullscreen.png"});
  await page.keyboard.press("Escape");
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  expect(unexpectedWrites).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile("artifacts/real-sdk-ui-report.json", JSON.stringify({
    backend: fixture.base_url, readOnly: true, controlEndpointUntouched: true, oracleMatched: summaryProof,
    workerRows: 10001, observedSnapshotId: observedSnapshot, publisherIds: paged.source_ids, browserErrors: errors,
  }, null, 2));
});
