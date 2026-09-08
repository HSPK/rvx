import {test, expect, type Page} from "@playwright/test";
import {mockApi, selectAddType} from "./fixtures";

async function addSection(page: Page, name: string) {
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "section");
  await editor.getByRole("textbox", {name: "Panel title"}).fill(name);
  await editor.getByRole("button", {name: "Add", exact: true}).click();
}

test("dropping over the original slot or outside the workspace preserves panel order", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const cards = page.locator(".section-grid .chart-card");
  await expect(cards.first().locator("canvas")).toBeVisible();
  const order = await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.panelId));
  const card = cards.nth(1), canvas = await card.locator("canvas").elementHandle();
  for (const outside of [false, true]) {
    const handle = (await card.locator(".panel-drag-handle").boundingBox())!;
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 12, y + 8, {steps: 4});
    if (outside) await page.mouse.move(100, 24, {steps: 4});
    await page.mouse.up();
    expect(await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.panelId))).toEqual(order);
    expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.locator(".is-dragging,.drop-before,.drop-after,.drop-empty")).toHaveCount(0);
  }
});

test("pointer dragging autoscrolls into an empty section without turning canvas gestures into reordering", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const first = page.locator(".section-grid .chart-card").first();
  await expect(first.locator("canvas")).toBeVisible();
  const canvas = await first.locator("canvas").elementHandle(), id = await first.getAttribute("data-panel-id");
  await addSection(page, "Pipeline");
  const target = page.locator(".workspace-section").filter({has: page.getByRole("button", {name: "Pipeline", exact: true})});
  await first.scrollIntoViewIfNeeded();
  const handle = (await first.locator(".panel-drag-handle").boundingBox())!;
  const scroll = (await page.locator(".chart-scroll").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(scroll.x + scroll.width / 2, scroll.y + scroll.height - 12, {steps: 8});
  await expect.poll(async () => (await target.boundingBox())!.y).toBeLessThan(scroll.y + scroll.height - 30);
  const empty = (await target.locator(".section-empty").boundingBox())!;
  await page.mouse.move(empty.x + empty.width / 2, Math.min(empty.y + empty.height / 2, scroll.y + scroll.height - 12));
  await page.mouse.up();
  await expect(target.locator(`[data-panel-id="${id}"]`)).toHaveCount(1);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  const moved = target.locator(`[data-panel-id="${id}"]`);
  await expect(moved.locator(".chart-zoom-state")).toBeHidden();
  await page.screenshot({path: "artifacts/expanded-drag-section.png"});
});

test("table column visibility, order and resize persist, with sticky key/header and same-instance fullscreen", async ({page}) => {
  await mockApi(page, {tableRows: 10000});
  await page.goto("/rvx?runs=run-1&live=0");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "snapshot-table");
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(75);
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const table = page.locator(".section-grid .table-card").last();
  await table.scrollIntoViewIfNeeded(); await expect(table.locator("tbody tr")).toHaveCount(75);
  const id = await table.getAttribute("data-panel-id");
  await table.getByRole("button", {name: "Columns", exact: true}).click();
  const columns = page.getByRole("dialog", {name: "Columns", exact: true});
  await columns.getByRole("checkbox", {name: "Show healthy", exact: true}).uncheck();
  await columns.getByRole("button", {name: "Move load column left"}).click();
  await columns.getByRole("button", {name: "Close", exact: true}).click();
  await expect(table.locator('th[data-column="/healthy"]')).toHaveCount(0);
  const order = await table.locator("thead th[data-column]").evaluateAll(headers => headers.map(header => (header as HTMLElement).dataset.column));
  expect(order.indexOf("/load")).toBeLessThan(order.indexOf("/name"));
  const separator = table.getByRole("separator", {name: "Resize load column"});
  await separator.scrollIntoViewIfNeeded();
  const before = (await table.locator('th[data-column="/load"]').boundingBox())!.width;
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 83, box.y + box.height / 2, {steps: 4}); await page.mouse.up();
  await expect.poll(async () => (await table.locator('th[data-column="/load"]').boundingBox())!.width).toBeGreaterThan(before + 60);
  await table.locator(".table-scroll").evaluate(node => {node.scrollLeft = 400; node.scrollTop = 500;});
  const key = (await table.locator("thead th").first().boundingBox())!, viewport = (await table.locator(".table-scroll").boundingBox())!;
  expect(Math.abs(key.x - viewport.x)).toBeLessThan(2);
  expect(Math.abs(key.y - viewport.y)).toBeLessThan(2);
  await table.locator(".menu-trigger").click();
  await table.getByRole("menuitem", {name: "Fullscreen", exact: true}).click();
  const fullscreen = page.getByRole("dialog", {name: "Tasks", exact: true});
  await expect(fullscreen.locator(`[data-panel-id="${id}"]`)).toHaveCount(1);
  await expect(fullscreen.locator("tbody tr")).toHaveCount(75);
  await page.screenshot({path: "artifacts/expanded-table-fullscreen.png"});
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("textbox", {name: "Workspace set name"}).fill("Tables");
  await page.getByRole("button", {name: "Save workspace set"}).click();
  await page.reload();
  const restored = page.locator(`[data-panel-id="${id}"]`);
  await restored.scrollIntoViewIfNeeded(); await expect(restored.locator("tbody tr")).toHaveCount(75);
  await expect(restored.locator('th[data-column="/healthy"]')).toHaveCount(0);
  expect((await restored.locator('th[data-column="/load"]').boundingBox())!.width).toBeGreaterThan(before + 60);
});

test("generic snapshot collections include keyed records, scalar arrays and root fields", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "snapshot-table");
  for (const [path, name, count] of [["/queues", "Queues", 2], ["/samples", "Samples", 3], ["", "State fields", 2]] as const) {
    await editor.locator(`.collection-option[data-path="${path}"]`).click();
    await expect(editor.locator(".table-preview tbody tr")).toHaveCount(count);
    await expect(editor.locator(".table-preview").getByRole("heading", {name, exact: true})).toBeVisible();
  }
  await expect(editor.locator(".table-preview")).toContainText("18446744073709551615");
  await expect(editor.getByRole("button", {name: /^Inspect/})).toHaveCount(0);
  await editor.getByRole("button", {name: "Cancel", exact: true}).click();
  await expect(page.locator(".section-grid .chart-card")).toHaveCount(6);
});

test("opened dropdown and metric hover gaps stay visible in dark mobile Add modes", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
  for (const width of [320, 390, 844]) {
    await page.setViewportSize({width, height: width === 844 ? 390 : 844});
    await page.getByRole("button", {name: "Add", exact: true}).click();
    const editor = page.getByRole("dialog", {name: "Add", exact: true});
    const mode = editor.getByRole("combobox", {name: "Chart layout"});
    await mode.click();
    const first = page.getByRole("option", {name: "Separate charts", exact: true}), second = page.getByRole("option", {name: "Combined plot", exact: true});
    await first.hover();
    const a = (await first.boundingBox())!, b = (await second.boundingBox())!;
    expect(b.y - a.y - a.height).toBeGreaterThanOrEqual(3);
    await page.screenshot({path: `artifacts/expanded-add-dropdown-${width}.png`});
    await page.keyboard.press("Escape");
    const rows = editor.locator(".metric-option");
    await rows.first().hover();
    await page.screenshot({path: `artifacts/expanded-add-hover-${width}.png`});
    await expect(editor.getByRole("button", {name: "Cancel", exact: true})).toBeVisible();
    expect(await editor.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await editor.getByRole("button", {name: "Cancel", exact: true}).click();
  }
});

test("touch drag handles move panels across sections while retaining the original canvas", async ({browser}) => {
  const context = await browser.newContext({baseURL: test.info().project.use.baseURL, viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  const page = await context.newPage();
  try {
    await mockApi(page);
    await page.goto("/rvx?runs=run-1&live=0");
    const first = page.locator(".section-grid .chart-card").first();
    await expect(first.locator("canvas")).toBeVisible();
    const id = await first.getAttribute("data-panel-id"), canvas = await first.locator("canvas").elementHandle();
    await addSection(page, "Touch target");
    await first.scrollIntoViewIfNeeded();
    const handle = (await first.locator(".panel-drag-handle").boundingBox())!, scroll = (await page.locator(".chart-scroll").boundingBox())!;
    const session = await context.newCDPSession(page);
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await session.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y}]});
    await session.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: scroll.x + scroll.width / 2, y: scroll.y + scroll.height - 8}]});
    const target = page.locator(".workspace-section").filter({has: page.getByRole("button", {name: "Touch target", exact: true})});
    await expect.poll(async () => (await target.boundingBox())!.y, {timeout: 9000}).toBeLessThan(scroll.y + scroll.height - 30);
    const empty = (await target.locator(".section-empty").boundingBox())!;
    await session.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: empty.x + empty.width / 2, y: Math.min(empty.y + 20, scroll.y + scroll.height - 10)}]});
    await session.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
    await expect(target.locator(`[data-panel-id="${id}"]`)).toHaveCount(1);
    expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
    await expect(target.locator(".chart-zoom-state")).toBeHidden();
    await session.detach();
  } finally {await context.close();}
});

test("collapsing a section cancels a pending table read and stops hidden table polling", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1");
  await addSection(page, "Tables");
  await page.getByRole("button", {name: "Add to section Tables", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "snapshot-table");
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(75);
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const section = page.locator(".workspace-section").filter({has: page.getByRole("button", {name: "Tables", exact: true})});
  const table = section.locator(".table-card");
  await table.scrollIntoViewIfNeeded(); await expect(table.locator("tbody tr")).toHaveCount(75);
  let release!: () => void, waiting = false, aborted = 0;
  const gate = new Promise<void>(resolve => {release = resolve;});
  page.on("requestfailed", request => {if (request.url().includes("/api/tables/rows")) aborted++;});
  await page.route("**/api/tables/rows", async route => {waiting = true; await gate; await route.fallback();});
  try {
    await expect.poll(() => waiting, {timeout: 7500}).toBe(true);
    await section.getByRole("button", {name: "Collapse section Tables"}).click();
    await expect.poll(() => aborted).toBeGreaterThan(0);
    const count = requests.filter(request => request.path === "/api/tables/rows").length;
    await page.waitForTimeout(5500);
    expect(requests.filter(request => request.path === "/api/tables/rows").length).toBe(count);
  } finally {release();}
});

test("table reporter selection is explicit across multiple Runs and is sent to the native APIs", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "snapshot-table");
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(75);
  await editor.getByRole("checkbox", {name: "Include grpo · warm-start · Learner", exact: true}).uncheck();
  await expect.poll(() => requests.filter(request => request.path === "/api/tables/rows").at(-1)?.body?.source_ids).toEqual(["run-2-source-0"]);
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const table = page.locator(".section-grid .table-card").last();
  await table.scrollIntoViewIfNeeded(); await expect(table.locator("tbody tr")).toHaveCount(75);
  await expect(table.locator(".table-scope")).toBeHidden();
  await expect(table.locator("tbody tr").first().locator('[data-column="@run"]')).toHaveText("grpo · baseline");
});

test("failed table refresh retains evidence rows and recovers through an explicit retry", async ({page}) => {
  const options = {failTables: false, tableRows: 10000};
  await mockApi(page, options);
  await page.goto("/rvx?runs=run-1&live=0");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "snapshot-table");
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(75);
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const table = page.locator(".section-grid .table-card").last();
  await table.scrollIntoViewIfNeeded(); await expect(table.locator("tbody tr")).toHaveCount(75);
  const id = await table.locator("tbody tr").first().getAttribute("data-snapshot-id");
  options.failTables = true;
  await expect(table.locator(".chart-status")).toHaveText("Refresh failed", {timeout: 7500});
  await expect(table.locator("tbody tr")).toHaveCount(75);
  await expect(table.locator("tbody tr").first()).toHaveAttribute("data-snapshot-id", id!);
  options.failTables = false;
  await table.getByRole("button", {name: "Retry", exact: true}).click();
  await expect(table.locator(".chart-status")).toBeHidden();
});

test("both real table previews and their Add actions fit narrow dark screens", async ({page}) => {
  await page.setViewportSize({width: 320, height: 844});
  await mockApi(page);
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
  for (const kind of ["metric-table", "snapshot-table"]) {
    await page.getByRole("button", {name: "Add", exact: true}).click();
    const editor = page.getByRole("dialog", {name: "Add", exact: true});
    await selectAddType(editor, kind);
    if (kind === "metric-table") {
      await editor.getByRole("searchbox", {name: "Search metrics"}).fill("loss");
      await editor.getByRole("checkbox", {name: "Select metric Policy loss", exact: true}).check();
    }
    await expect(editor.locator(".table-preview tbody tr").first()).toBeVisible();
    await expect(editor.getByRole("button", {name: "Add", exact: true})).toBeEnabled();
    const action = (await editor.getByRole("button", {name: "Add", exact: true}).boundingBox())!;
    expect(action.y + action.height).toBeLessThanOrEqual(844);
    expect(await editor.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({path: `artifacts/expanded-${kind}-mobile.png`});
    await editor.getByRole("button", {name: "Add", exact: true}).click();
    const table = page.locator(".section-grid .table-card").last();
    await table.scrollIntoViewIfNeeded();
    await expect(table.locator("tbody tr").first()).toBeVisible();
    for (const control of await table.locator(".table-tools button").all()) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    }
    await page.screenshot({path: `artifacts/expanded-${kind}-mobile-applied.png`});
  }
});
