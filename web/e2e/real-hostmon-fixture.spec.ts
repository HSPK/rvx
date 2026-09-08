import {selectAddType} from "./fixtures";
import {test, expect} from "@playwright/test";
import {mkdir, readFile, writeFile} from "node:fs/promises";

const fixtureFile = process.env.RVX_REAL_FIXTURE_FILE;
test.skip(!fixtureFile, "Uses the parent-owned read-only Hostmon replay fixture.");

test("real Hostmon replay tables remain useful despite partial collection discovery", async ({page}) => {
  test.setTimeout(90_000);
  if (!fixtureFile) return;
  const fixture: {base_url: string; hostmon_replay?: {run: {id: string}}} = JSON.parse(await readFile(fixtureFile, "utf8"));
  if (!fixture.hostmon_replay) return;
  const failures: string[] = [], writes: string[] = [];
  page.on("response", response => {if (response.url().includes("/api/tables/") && response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);});
  page.on("request", request => {
    if (request.method() !== "GET" && request.method() !== "HEAD" && !["/api/charts/catalog", "/api/snapshots/query", "/api/tables/catalog", "/api/tables/summary", "/api/tables/rows"].includes(new URL(request.url()).pathname)) writes.push(request.url());
  });
  await page.goto(`/rvx?runs=${fixture.hostmon_replay.run.id}&live=0`);
  await expect(page.locator(".section-grid canvas").first()).toBeVisible();
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "snapshot-table");
  await expect(editor.locator(".metric-selection-count")).toHaveText("Partial collection catalog");
  const workloadPath = "/collectors/cluster_gpu_usage/document/workloads";
  await editor.getByRole("searchbox", {name: "Search collections"}).fill("workloads");
  await editor.locator(`.collection-option[data-path="${workloadPath}"]`).click();
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(52);
  await expect(editor.locator(".table-preview .table-availability")).toContainText("Collection discovery is partial");
  const previewViewport = (await editor.locator(".table-preview .table-scroll").boundingBox())!;
  const previewName = (await editor.locator('.table-preview th[data-column="/name"]').boundingBox())!;
  expect(previewName.x + previewName.width).toBeLessThanOrEqual(previewViewport.x + previewViewport.width);
  const visiblePreviewRows = await editor.locator(".table-preview tbody tr").evaluateAll(rows => {
    const viewport = rows[0]!.closest(".table-scroll")!.getBoundingClientRect();
    return rows.filter(row => {const box = row.getBoundingClientRect(); return box.top >= viewport.top && box.bottom <= viewport.bottom;}).length;
  });
  expect(visiblePreviewRows).toBeGreaterThanOrEqual(4);
  await page.screenshot({path: "artifacts/real-hostmon-workloads-preview.png"});
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const table = page.locator(".section-grid .table-card").last();
  await table.scrollIntoViewIfNeeded(); await expect(table.locator("tbody tr")).toHaveCount(52);
  await expect(table.locator(".table-availability")).toContainText("still filters and pages");
  await table.getByRole("button", {name: "Columns", exact: true}).click();
  const columns = page.getByRole("dialog", {name: "Columns", exact: true});
  await columns.getByRole("checkbox", {name: "Show running_gpus", exact: true}).check();
  await columns.getByRole("button", {name: "Close", exact: true}).click();
  await table.getByRole("button", {name: "running_gpus", exact: true}).click();
  await table.getByRole("button", {name: "running_gpus", exact: true}).click();
  await expect(table.locator('th[data-column="/running_gpus"]')).toHaveAttribute("aria-sort", "descending");
  await expect(table.locator(".chart-status")).toBeHidden();
  const values = (await table.locator('tbody [data-column="/running_gpus"]').allTextContents()).map(Number);
  expect(values).toHaveLength(52);
  expect(values).toEqual([...values].sort((a, b) => b - a));
  await table.locator(".menu-trigger").click();
  await table.getByRole("menuitem", {name: "Fullscreen", exact: true}).click();
  const fullscreen = page.locator(".panel-fullscreen");
  await expect(fullscreen.locator("tbody tr")).toHaveCount(52);
  await page.screenshot({path: "artifacts/real-hostmon-workloads-fullscreen.png"});
  await expect(fullscreen.getByRole("button", {name: /^Inspect/})).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  await selectAddType(editor, "snapshot-table");
  await editor.getByRole("searchbox", {name: "Search collections"}).fill("document/usage");
  await editor.locator('.collection-option[data-path="/collectors/cluster_gpu_usage/document/usage"]').click();
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(5);
  await editor.getByRole("button", {name: "Cancel", exact: true}).click();
  expect(failures).toEqual([]); expect(writes).toEqual([]);
  await mkdir("artifacts", {recursive: true});
  await writeFile("artifacts/real-hostmon-ui-report.json", JSON.stringify({backend: fixture.base_url, runId: fixture.hostmon_replay.run.id,
    collectionDiscoveryPartial: true, workloadRows: 52, usageRows: 5, visiblePreviewRows, nameVisibleWithoutHorizontalScroll: true,
    actualNumericSort: values, tableRequestFailures: failures, unexpectedWrites: writes}, null, 2));
});
