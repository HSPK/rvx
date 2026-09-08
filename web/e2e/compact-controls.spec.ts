import {test, expect, type Page} from "@playwright/test";
import {readFile} from "node:fs/promises";
import {mockApi, seedUiState, serverState, uiServer} from "./fixtures";
import type {PanelSpec} from "../src/app/panels";

const chart: PanelSpec = {kind: "chart", id: "chart", sectionId: "main", size: "normal", path: "/progress/loss"};
const table: PanelSpec = {kind: "snapshot-table", id: "table", sectionId: "main", size: "wide", path: "/tasks"};
async function seed(page: Page, panels: PanelSpec[]): Promise<void> {
  await seedUiState(page, {selected: {"experiment-1": "compact"}, sets: [
    {id: "compact", name: "Training", experimentId: "experiment-1", sections: [{id: "main", name: "", collapsed: false}], panels},
  ]});
}

test("active status filters retain a quiet background without a permanent outline", async ({page}) => {
  await mockApi(page); await seed(page, [chart]);
  await page.goto("/rvx?runs=run-1");
  const status = page.getByRole("combobox", {name: "Status", exact: true});
  await status.selectOption("running");
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.getByRole("button", {name: `Switch to ${theme} appearance`}).click();
    await expect(status).toHaveClass(/is-filtered/);
    await status.hover();
    await expect(status).toHaveCSS("box-shadow", "none");
    await status.focus();
    await expect(status).toHaveCSS("outline-style", "none");
    await page.locator(".chart-scroll").focus(); await page.mouse.move(700, 70);
    await expect(status).toHaveCSS("box-shadow", "none");
    await expect(status).toHaveCSS("outline-style", "none");
    await expect(page.locator(".chart-card canvas")).toBeVisible();
    await page.screenshot({path: `artifacts/filter-without-outline-${theme}.png`});
  }
  await page.reload(); await expect(status).toHaveValue("running");
  await expect(status).toHaveCSS("box-shadow", "none");
  await status.selectOption("");
  await expect(status).not.toHaveClass(/is-filtered/);
});

test("Run details appear on hover and keyboard focus, with compact rail and aligned vector brand", async ({page}) => {
  await mockApi(page, {runCount: 10000});
  await page.goto("/rvx?runs=large-0");
  const row = page.locator(".run-row").first(), details = row.locator(".run-detail-button");
  await expect(page.locator(".chart-card canvas").first()).toBeVisible();
  await page.mouse.move(800, 100);
  await expect(details).toHaveCSS("opacity", "0");
  await row.hover(); await expect(details).toHaveCSS("opacity", "1");
  const before = await row.boundingBox();
  await details.click(); await expect(page.getByRole("dialog", {name: "Run details", exact: true})).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.move(800, 100);
  await row.locator(".run-checkbox").focus();
  await page.keyboard.press("Tab"); await expect(details).toBeFocused(); await expect(details).toHaveCSS("opacity", "1");
  expect(await row.boundingBox()).toEqual(before);
  const project = await page.getByRole("combobox", {name: "Project", exact: true}).boundingBox();
  const experiment = await page.getByRole("combobox", {name: "Experiment", exact: true}).boundingBox();
  expect(project!.y).toBe(experiment!.y);
  expect(await page.locator(".run-row").count()).toBeLessThan(33);
  const geometry = await page.locator(".brand").evaluate(node => {
    const icon = node.querySelector(".brand-icon")!.getBoundingClientRect();
    const wordmark = node.querySelector<SVGSVGElement>(".brand-wordmark")!;
    const ink = wordmark.querySelector("path")!.getBBox(), matrix = wordmark.getScreenCTM()!;
    return Math.abs(icon.y + icon.height / 2 - (matrix.f + (ink.y + ink.height / 2) * matrix.d));
  });
  expect(geometry).toBeLessThan(.5);
  await page.locator(".chart-scroll").focus();
  await page.screenshot({path: "artifacts/compact-rail-desktop.png"});
  await page.getByRole("combobox", {name: "Status", exact: true}).click();
  await page.screenshot({path: "artifacts/compact-status-menu.png"});
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name: "Workspace sets", exact: true}).click();
  await expect(page.getByText(/Older browser-only|Shared on this server/)).toHaveCount(0);
  await page.screenshot({path: "artifacts/compact-workspace-dialog.png"});
});

test("Run colors repaint existing zoomed curves and persist only in the browser's server preferences", async ({page, browser}) => {
  const requests = await mockApi(page); await seed(page, [chart]);
  await page.goto("/rvx?runs=run-1,run-2");
  const card = page.locator('[data-panel-id="chart"]');
  await expect(card.locator("canvas")).toBeVisible();
  const canvas = await card.locator("canvas").elementHandle();
  const box = (await card.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 50); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7, box.y + 50, {steps: 5}); await page.mouse.up();
  const zoom = await card.locator(".chart-host").getAttribute("aria-description");
  const swatch = page.locator('.run-chip[data-run-id="run-1"] .run-color-button');
  await swatch.click();
  await page.getByRole("button", {name: "Use #15917d", exact: true}).click();
  await expect.poll(async () => (await serverState(page)).browser.run_colors["run-1"]).toBe("#15917d");
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  expect(await card.locator(".chart-host").getAttribute("aria-description")).toBe(zoom);
  expect(await card.locator("canvas").evaluate(node => {
    const data = node.getContext("2d")!.getImageData(0, 0, node.width, node.height).data;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index] === 21 && data[index + 1] === 145 && data[index + 2] === 125) count++;
    return count;
  })).toBeGreaterThan(5);
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  await swatch.click(); await page.screenshot({path: "artifacts/compact-run-colors.png"});
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(swatch).toHaveCSS("--run-color", "#15917d");
  const context = await browser.newContext({baseURL: test.info().project.use.baseURL});
  try {
    const other = await context.newPage(); await mockApi(other, {uiServer: uiServer(page)});
    await other.goto("/rvx?runs=run-1");
    expect((await serverState(other)).browser.run_colors).toEqual({});
  } finally {await context.close();}
  await page.locator('.run-row[data-run-id="run-1"]').hover();
  await page.locator('.run-row[data-run-id="run-1"] .run-detail-button').click();
  await page.locator(".run-color-detail").click();
  await page.getByRole("button", {name: "Automatic", exact: true}).click();
  await expect.poll(async () => (await serverState(page)).browser.run_colors).toEqual({});
  expect(requests.filter(request => request.path === "/api/ui/browser").length).toBeGreaterThan(0);
});

test("column decimals preserve exact raw values and exports, without refetching snapshots", async ({page}) => {
  const requests = await mockApi(page, {tableRows: 100}); await seed(page, [table]);
  await page.goto("/rvx?runs=run-1");
  const card = page.locator(".table-card");
  await expect(card.locator("tbody tr")).toHaveCount(75);
  const count = requests.filter(request => request.path === "/api/tables/rows").length;
  await card.getByRole("button", {name: "Columns", exact: true}).click();
  await page.getByRole("combobox", {name: "Decimal places for counter", exact: true}).selectOption("2");
  await expect(card.locator('tbody [data-column="/counter"]').first()).toHaveText("18446744073709551615.00");
  expect(requests.filter(request => request.path === "/api/tables/rows").length).toBe(count);
  await page.screenshot({path: "artifacts/compact-column-decimals.png"});
  await page.keyboard.press("Escape");
  const download = page.waitForEvent("download");
  await card.getByRole("button", {name: "Export page CSV", exact: true}).click();
  const path = await (await download).path();
  if (!path) throw new Error("CSV download did not produce a local file.");
  const csv = await readFile(path, "utf8");
  expect(csv).toContain('"18446744073709551615"'); expect(csv).not.toContain("18446744073709551615.00");
  await expect(page.locator(".workspace-save")).toHaveClass(/save-needed/);
  await page.screenshot({path: "artifacts/compact-unsaved-warning.png"});
  await page.getByRole("button", {name: "Save current workspace", exact: true}).click();
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  await page.reload();
  await expect(card.locator('tbody [data-column="/counter"]').first()).toHaveText("18446744073709551615.00");
  await card.getByRole("button", {name: "Columns", exact: true}).click();
  await page.getByRole("combobox", {name: "Decimal places for counter", exact: true}).selectOption("");
  await page.keyboard.press("Escape");
  await expect(card.locator('tbody [data-column="/counter"]').first()).toHaveText("18446744073709551615");
});

test("filters can be disabled, re-enabled and edited without losing their saved definitions", async ({page}) => {
  const requests = await mockApi(page, {tableRows: 100});
  await seed(page, [{...table, query: {filters: [{path: "/load", op: "gt", value: "90"}]}}]);
  await page.goto("/rvx?runs=run-1");
  const card = page.locator(".table-card");
  await expect(card.locator("tbody tr")).toHaveCount(9);
  await card.getByRole("button", {name: "Filter (1)", exact: true}).click();
  const modal = page.getByRole("dialog", {name: "Filter rows", exact: true});
  await modal.getByRole("checkbox", {name: "Enable filter 1", exact: true}).uncheck();
  await expect(card.locator("tbody tr")).toHaveCount(75);
  expect(requests.filter(request => request.path === "/api/tables/rows").at(-1)!.body!.filters).toEqual([]);
  await page.screenshot({path: "artifacts/compact-filter-disabled.png"});
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name: "Save current workspace", exact: true}).click();
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  const stored = (await serverState(page)).workspaces.sets[0]!.panels[0]!;
  expect(stored.kind !== "chart" && stored.query?.filters).toEqual([{path: "/load", op: "gt", value: "90", enabled: false}]);
  await page.reload(); await expect(card.locator("tbody tr")).toHaveCount(75);
  await card.getByRole("button", {name: "Filter", exact: true}).click();
  await modal.getByRole("checkbox", {name: "Enable filter 1", exact: true}).check();
  await expect(card.locator("tbody tr")).toHaveCount(9);
  await modal.getByRole("button", {name: "Edit filter 1", exact: true}).click();
  await modal.getByRole("textbox", {name: "Filter value", exact: true}).fill("95");
  await modal.getByRole("button", {name: "Update filter", exact: true}).click();
  await expect(card.locator("tbody tr")).toHaveCount(4);
});

test("responsive toolbars group actions and keep touch details accessible without redundant copy", async ({page}) => {
  await mockApi(page, {tableRows: 2}); await seed(page, [chart, table]);
  await page.goto("/rvx?runs=run-1,run-2");
  for (const width of [2560, 1440, 901, 390, 320]) {
    await page.setViewportSize({width, height: 1000});
    if (width <= 390 && await page.locator("html").getAttribute("data-theme") !== "dark") {
      await page.getByRole("button", {name: "Switch to dark appearance"}).click();
    }
    await expect(page.locator(".chart-card canvas")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const range = (await page.getByRole("combobox", {name: "Time range", exact: true}).boundingBox())!;
    const observed = (await page.locator(".collection-freshness").boundingBox())!;
    expect(Math.abs(range.y + range.height / 2 - observed.y - observed.height / 2)).toBeLessThan(2);
    await page.screenshot({path: `artifacts/compact-controls-${width}.png`});
    const card = page.locator(".table-card");
    await card.scrollIntoViewIfNeeded();
    const buttons = await card.locator(".table-tools > button").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
    expect(new Set(buttons).size).toBe(1);
    await expect(page.getByText(/independent source observation|Collection discovery is partial/)).toHaveCount(0);
    await page.locator(".chart-scroll").evaluate(node => {node.scrollTop = 0;});
  }
  await page.getByRole("button", {name: "Add", exact: true}).click();
  await page.screenshot({path: "artifacts/compact-add-mobile.png"});
});

test("touch devices keep Run details discoverable without hover", async ({browser}) => {
  const context = await browser.newContext({baseURL: test.info().project.use.baseURL, hasTouch: true, isMobile: true, viewport: {width: 390, height: 844}});
  try {
    const page = await context.newPage(); await mockApi(page);
    await page.goto("/rvx?runs=run-1");
    await page.getByRole("button", {name: "Select runs (1 selected)"}).click();
    const details = page.getByRole("dialog", {name: "Runs", exact: true}).locator(".run-detail-button").first();
    await expect(details).toHaveCSS("opacity", "1");
    await details.tap(); await expect(page.getByRole("dialog", {name: "Run details", exact: true})).toBeVisible();
    await page.screenshot({path: "artifacts/compact-touch-details.png"});
  } finally {await context.close();}
});
