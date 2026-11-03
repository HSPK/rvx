import {test, expect, type Page} from "@playwright/test";
import {mockApi, seedWorkspace, serverState, type FixtureOptions, selectAddType, selectedObservation} from "./fixtures";

async function openAdd(page: Page, kind = "chart") {
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, kind);
  return editor;
}

test("fractional chart widths render, persist and retain zoom and fullscreen placeholder spans", async ({page}) => {
  await page.clock.install();
  await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}, {path: "/progress/reward", size: "normal"}]);
  await page.goto("/rvx?runs=run-1");
  const chart = page.locator('[data-panel-id="seed-0"]'), grid = page.locator(".section-grid");
  await expect(chart.locator("canvas")).toBeVisible();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const canvas = await chart.locator("canvas").elementHandle();
  const box = (await chart.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7, box.y + 30, {steps: 4}); await page.mouse.up();
  const zoom = await chart.locator(".chart-host").getAttribute("aria-description");
  for (const [size, fraction] of [["normal", .5], ["wide", 1], ["quarter", .25], ["third", 1 / 3], ["half", .5], ["three-quarters", .75], ["two-thirds", 2 / 3]] as const) {
    await chart.locator(".menu-trigger").click();
    await chart.getByRole("menuitem", {name: "Edit chart", exact: true}).click();
    const editor = page.getByRole("dialog", {name: "Edit panel", exact: true});
    await editor.getByRole("combobox", {name: "Panel width", exact: true}).selectOption(size);
    await editor.getByRole("button", {name: "Save changes", exact: true}).click();
    await page.clock.runFor(80);
    await expect(chart).toHaveAttribute("data-panel-size", size);
    const width = (await grid.boundingBox())!.width;
    const gap = await grid.evaluate(node => Number.parseFloat(getComputedStyle(node).columnGap));
    expect((await chart.boundingBox())!.width).toBeCloseTo((width + gap) * fraction - gap, 0);
    expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
    await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", zoom!);
  }
  const originalWidth = (await chart.boundingBox())!.width;
  await chart.locator(".menu-trigger").click();
  await chart.getByRole("menuitem", {name: "Fullscreen", exact: true}).click();
  await page.clock.runFor(80);
  expect((await page.locator(".panel-placeholder").boundingBox())!.width).toBeCloseTo(originalWidth, 0);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await page.keyboard.press("Escape"); await page.clock.runFor(80);
  expect((await chart.boundingBox())!.width).toBeCloseTo(originalWidth, 0);
  await page.getByRole("button", {name: "Save current workspace", exact: true}).click();
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  expect((await serverState(page)).workspaces.sets[0]!.panels[0]!.size).toBe("two-thirds");
  await page.clock.resume(); await page.reload();
  await expect(chart).toHaveAttribute("data-panel-size", "two-thirds");
  await expect(chart.locator("canvas")).toBeVisible();
  await chart.locator(".menu-trigger").click();
  await chart.getByRole("menuitem", {name: "Edit chart", exact: true}).click();
  await expect(page.getByRole("combobox", {name: "Panel width", exact: true})).toHaveValue("two-thirds");
  await page.keyboard.press("Escape");
  await page.setViewportSize({width: 2560, height: 900});
  const normal = page.locator('[data-panel-id="seed-1"]');
  await expect.poll(async () => {
    const width = (await grid.boundingBox())!.width;
    const gap = await grid.evaluate(node => Number.parseFloat(getComputedStyle(node).columnGap));
    return Math.abs((await normal.boundingBox())!.width - ((width + gap) / 3 - gap));
  }).toBeLessThan(1);
  for (const width of [390, 320]) {
    await page.setViewportSize({width, height: 844});
    expect((await chart.boundingBox())!.width).toBeCloseTo((await grid.boundingBox())!.width, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("adding a quarter-width chart retains its preset and fits its canvas even below 180px", async ({page}) => {
  await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/reward", size: "normal"}]);
  await page.goto("/rvx?runs=run-1&live=0");
  const editor = await openAdd(page);
  await editor.getByRole("checkbox", {name: "Select metric Policy loss", exact: true}).check();
  await editor.getByRole("combobox", {name: "Panel width", exact: true}).selectOption("quarter");
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const chart = page.locator('.section-grid [data-path="/progress/loss"]');
  await expect(chart).toHaveAttribute("data-panel-size", "quarter");
  for (const width of [1440, 1100, 1000, 901, 900, 390, 320]) {
    await page.setViewportSize({width, height: 844});
    await expect(chart.locator("canvas")).toBeVisible();
    await expect.poll(async () => {
      const plot = (await chart.locator(".uplot").boundingBox())!.width;
      const host = await chart.locator(".chart-host").evaluate(node => node.clientWidth);
      return Math.abs(plot - host);
    }).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole("button", {name: "Save current workspace", exact: true}).click();
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  await page.setViewportSize({width: 1000, height: 844}); await page.reload();
  await expect(chart).toHaveAttribute("data-panel-size", "quarter");
  await expect(chart.locator("canvas")).toBeVisible();
  expect((await chart.locator(".chart-host").boundingBox())!.width).toBeLessThan(180);
  await expect.poll(async () => {
    const plot = (await chart.locator(".uplot").boundingBox())!.width;
    const host = await chart.locator(".chart-host").evaluate(node => node.clientWidth);
    return Math.abs(plot - host);
  }).toBeLessThanOrEqual(1);
});

test("metric checkboxes survive filtering, default to separate panels, and retain real hover gaps", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".section-grid .chart-card")).toHaveCount(6);
  const chart = page.locator(".section-grid .chart-card").first();
  for (const control of await chart.locator(".menu-trigger").all()) {
    const buttonBox = (await control.boundingBox())!, svgBox = (await control.locator("svg").boundingBox())!;
    expect(Math.abs(buttonBox.x + buttonBox.width / 2 - svgBox.x - svgBox.width / 2)).toBeLessThan(.6);
    expect(Math.abs(buttonBox.y + buttonBox.height / 2 - svgBox.y - svgBox.height / 2)).toBeLessThan(.6);
  }
  await expect(chart.getByRole("menuitem", {name: /Inspect/, includeHidden: true})).toHaveCount(0);
  await expect(chart.locator(".panel-drag-handle svg,.panel-expand,.chart-footer")).toHaveCount(0);
  const editor = await openAdd(page);
  const rows = editor.locator(".metric-option");
  const first = (await rows.nth(0).boundingBox())!, second = (await rows.nth(1).boundingBox())!;
  expect(second.y - first.y - first.height).toBeGreaterThanOrEqual(3);
  await rows.first().hover();
  expect(Number.parseFloat(await rows.first().locator("strong").evaluate(node => getComputedStyle(node).fontSize))).toBeLessThanOrEqual(13);
  await page.screenshot({path: "artifacts/expanded-metric-hover.png"});
  await editor.getByRole("searchbox", {name: "Search metrics"}).fill("loss");
  await editor.getByRole("checkbox", {name: "Select metric Policy loss", exact: true}).check();
  await editor.getByRole("searchbox", {name: "Search metrics"}).fill("reward");
  await editor.getByRole("checkbox", {name: "Select metric Mean reward", exact: true}).check();
  await expect(editor.locator(".metric-selection-count")).toContainText("2 selected");
  await expect(editor.locator(".metric-selection-count")).toContainText("outside search");
  await expect(page.locator(".section-grid .chart-card")).toHaveCount(6);
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  await expect(page.locator(".section-grid .chart-card")).toHaveCount(8);
  const ids = await page.locator(".section-grid [data-panel-id]").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.panelId));
  expect(new Set(ids).size).toBe(8);
  await expect(page.locator(".section-grid .chart-card[data-path='/progress/loss']")).toHaveCount(2);
});

test("combined plots disallow conflicting units and retain the selected metric's real point", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const editor = await openAdd(page);
  await editor.getByRole("checkbox", {name: "Select metric Policy loss", exact: true}).check();
  await editor.getByRole("checkbox", {name: "Select metric Token throughput", exact: true}).check();
  await editor.getByRole("combobox", {name: "Chart layout"}).selectOption("combined");
  await expect(editor.getByRole("alert")).toContainText("Different units");
  await expect(editor.getByRole("button", {name: "Add", exact: true})).toBeDisabled();
  await editor.getByRole("checkbox", {name: "Select metric Token throughput", exact: true}).uncheck();
  await editor.getByRole("checkbox", {name: "Select metric Mean reward", exact: true}).check();
  await expect(editor.locator(".chart-preview .legend-item")).toHaveCount(2);
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const chart = page.locator(".section-grid .chart-card").last();
  await chart.scrollIntoViewIfNeeded(); await expect(chart.locator("canvas")).toBeVisible();
  await expect(chart.locator(".chart-legend")).toContainText("Policy loss · grpo");
  await expect(chart.locator(".chart-legend")).toContainText("Mean reward · grpo");
  await page.screenshot({path: "artifacts/expanded-combined-chart.png"});
  await chart.locator(".chart-host").focus(); await page.keyboard.press("ArrowDown");
  await expect(chart.getByRole("tooltip").locator(".chart-tooltip-row")).toHaveCount(2);
  await expect(chart.getByRole("tooltip").locator(".is-selected")).toContainText("Mean reward");
  await page.screenshot({path: "artifacts/chart-surface-combined-hover.png"});
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", /^\d+$/);
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("metric tables use complete backend statistics and preserve current null and missing counts", async ({page}) => {
  const requests = await mockApi(page, {points: 2000, metricValues: {"run-1": {"/progress/loss": index => index === 1999 ? null : index}}});
  await page.goto("/rvx?runs=run-1&live=0");
  const editor = await openAdd(page, "metric-table");
  await editor.getByRole("checkbox", {name: "Select metric Policy loss", exact: true}).check();
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(1);
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const table = page.locator(".section-grid .table-card").last();
  await table.scrollIntoViewIfNeeded();
  const row = table.locator("tbody tr").first();
  await expect(row.locator('[data-column="current"]')).toHaveText("null");
  await expect(row.locator('[data-column="average"]')).toHaveText("999");
  await expect(row.locator('[data-column="p95"]')).toHaveText("1899");
  await expect(row.locator('[data-column="count"]')).toHaveText("1999");
  await expect(row.locator('[data-column="missing"]')).toHaveText("1");
  expect(requests.some(request => request.path === "/api/tables/summary")).toBe(true);
  const summary = requests.find(request => request.path === "/api/tables/summary")!.body!;
  expect(summary.max_points).toBeUndefined();
  await page.screenshot({path: "artifacts/expanded-metric-statistics.png"});
  await expect(table.getByRole("button", {name: /Inspect/})).toHaveCount(0);
});

test("snapshot tables page, search, filter and sort latest exact rows before pagination", async ({page}) => {
  const options: FixtureOptions = {tableRows: 10_000, tableVersion: 0};
  const requests = await mockApi(page, options);
  await page.goto("/rvx?runs=run-1&live=0");
  const editor = await openAdd(page, "snapshot-table");
  await expect(editor.getByRole("button", {name: /Tasks/})).toBeVisible();
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(75);
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const table = page.locator(".section-grid .table-card").last();
  await table.scrollIntoViewIfNeeded(); await expect(table.locator("tbody tr")).toHaveCount(75);
  await expect(table.locator(".table-footer")).toContainText("10,000");
  const firstId = await table.locator("tbody tr").first().getAttribute("data-snapshot-id");
  options.tableVersion = 1;
  await table.getByRole("button", {name: "load", exact: true}).click();
  await table.getByRole("button", {name: "load", exact: true}).click();
  await expect(table.locator('tbody tr').first().locator('[data-column="/load"]')).toHaveText("19999");
  await table.getByRole("button", {name: "Next page"}).click();
  await expect(table.locator('tbody tr').first().locator('[data-column="/load"]')).toHaveText("19924");
  await expect(table.locator("tbody tr").first()).not.toHaveAttribute("data-snapshot-id", firstId!);
  expect(requests.filter(request => request.path === "/api/tables/rows").at(-1)?.body?.snapshot_ids).toBeUndefined();
  await table.getByRole("searchbox", {name: "Search table rows"}).fill("worker-09999");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator(".table-footer")).toContainText("1–1 of 1");
  await table.getByRole("searchbox", {name: "Search table rows"}).fill("");
  await expect(table.locator("tbody tr")).toHaveCount(75);
  await table.getByRole("button", {name: "Filter", exact: true}).click();
  const filter = page.getByRole("dialog", {name: "Filter rows", exact: true});
  await filter.getByRole("combobox", {name: "Filter column"}).selectOption("/load");
  await filter.getByRole("combobox", {name: "Filter operation"}).selectOption("gt");
  await filter.getByRole("textbox", {name: "Filter value"}).fill("19990");
  await filter.getByRole("button", {name: "Add filter"}).click();
  await expect(table.locator("tbody tr")).toHaveCount(9);
  await table.getByRole("button", {name: "Filter (1)", exact: true}).click();
  await filter.getByRole("button", {name: "Disable all"}).click();
  await table.getByRole("button", {name: "counter", exact: true}).click();
  await table.getByRole("button", {name: "counter", exact: true}).click();
  await expect(table.locator("tbody tr").first().locator('[data-column="/counter"]')).toHaveText("18446744073709551615");
  const download = page.waitForEvent("download");
  await table.getByRole("button", {name: "Export page CSV"}).click();
  expect((await download).suggestedFilename()).toBe("rvx-table-page.csv");
  await expect(table.getByRole("button", {name: "Refresh table"})).toHaveCount(0);
  await expect(table.locator("tbody tr").first()).not.toHaveAttribute("data-snapshot-id", firstId!);
  await page.screenshot({path: "artifacts/expanded-snapshot-table.png"});
});

test("sections persist, keyboard move crosses empty groups, and fullscreen returns to the same canvas", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".section-grid .chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const id = await chart.getAttribute("data-panel-id");
  const canvas = await chart.locator("canvas").elementHandle();
  let editor = await openAdd(page, "section");
  await editor.getByRole("textbox", {name: "Panel title"}).fill("Quality");
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const handle = chart.getByRole("button", {name: "Move Policy loss", exact: true});
  await handle.focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
  const quality = page.locator(".workspace-section").filter({has: page.getByRole("button", {name: "Quality", exact: true})});
  await expect(quality.locator(`[data-panel-id="${id}"]`)).toHaveCount(1);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await quality.getByRole("button", {name: "Collapse section Quality"}).click();
  await expect(quality.locator(".section-grid")).toBeHidden();
  await quality.getByRole("button", {name: "Expand section Quality"}).click();
  const moved = quality.locator(`[data-panel-id="${id}"]`);
  await moved.scrollIntoViewIfNeeded();
  const scrollTop = await page.locator(".chart-scroll").evaluate(node => node.scrollTop);
  await moved.locator(".menu-trigger").click();
  await moved.getByRole("menuitem", {name: "Fullscreen", exact: true}).click();
  const fullscreen = page.getByRole("dialog", {name: "Policy loss", exact: true});
  await expect(fullscreen).toBeVisible();
  expect((await fullscreen.boundingBox())!.height).toBe(900);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await expect(fullscreen.locator(".panel-drag-handle")).toBeDisabled();
  await expect(fullscreen.getByRole("menuitem", {name: /Inspect/, includeHidden: true})).toHaveCount(0);
  await page.screenshot({path: "artifacts/expanded-chart-fullscreen.png"});
  await page.keyboard.press("Escape");
  await expect(fullscreen).toHaveCount(0);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  expect(await page.locator(".chart-scroll").evaluate(node => node.scrollTop)).toBe(scrollTop);
  await quality.getByRole("button", {name: "Collapse section Quality"}).click();
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("textbox", {name: "Workspace set name"}).fill("Grouped");
  await page.getByRole("button", {name: "Save workspace set"}).click();
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByRole("button", {name: "Quality", exact: true})).toBeVisible();
  await expect(page.locator(`[data-panel-id="${id}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-panel-id="${id}"]`)).toBeHidden();
  await page.getByRole("button", {name: "Quality", exact: true}).click();
  editor = page.getByRole("dialog", {name: "Section", exact: true});
  await editor.getByRole("button", {name: "Delete section"}).click();
  await expect(page.locator(".section-grid .chart-card")).toHaveCount(6);
});
