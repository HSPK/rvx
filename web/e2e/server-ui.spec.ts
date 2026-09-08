import {test, expect, type Page, type WebSocketRoute} from "@playwright/test";
import {writeFile} from "node:fs/promises";
import {mockApi, seedUiState, serverState, uiServer, type FixtureOptions} from "./fixtures";
import type {PanelSpec} from "../src/app/panels";

async function seedPanels(page: Page, panels: PanelSpec[]): Promise<void> {
  await seedUiState(page, {selected: {"experiment-1": "shared"}, sets: [{id: "shared", name: "Shared analysis", experimentId: "experiment-1",
    sections: [{id: "initial", name: "", collapsed: false}], panels}]});
}
const chart: PanelSpec = {id: "chart", kind: "chart", sectionId: "initial", path: "/pipeline/throughput", size: "normal"};
const table: PanelSpec = {id: "table", kind: "snapshot-table", sectionId: "initial", path: "/tasks", size: "wide"};
async function resizeChart(page: Page, label = "Make wide"): Promise<void> {
  const card = page.locator('[data-panel-id="chart"]');
  await card.getByRole("button", {name: /chart options$/}).click();
  await card.getByRole("menuitem", {name: label, exact: true}).click();
}

test("stored layout restoration waits for authenticated bootstrap instead of flashing defaults", async ({page}) => {
  const requests = await mockApi(page); await seedPanels(page, [chart]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/ui/state", async route => {await gate; await route.fallback();});
  try {
    await page.goto("/rvx?runs=run-1");
    await expect(page.getByRole("heading", {name: "Loading workspace settings"})).toBeVisible();
    expect(requests).toHaveLength(0);
    await expect(page.locator(".chart-card")).toHaveCount(0);
    release();
    await expect(page.locator(".chart-card")).toHaveCount(1);
    await expect(page.locator(".workspace-picker")).toHaveText("Shared analysis");
  } finally {release();}
});

test("bootstrap precedes stored layout, failure offers Retry and never writes a guessed default", async ({page}) => {
  await mockApi(page); await seedPanels(page, [chart]);
  let failing = true, reads = 0, writes = 0;
  await page.route("**/api/ui/state", route => {reads++; return failing ? route.fulfill({status: 503, json: {error: "Settings unavailable"}}) : route.fallback();});
  await page.route("**/api/ui/workspaces", route => {writes++; return route.fallback();});
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".preferences-notice")).toContainText("Settings unavailable");
  await expect(page.locator(".chart-card canvas").first()).toBeVisible();
  await page.getByRole("button", {name: "Save current workspace"}).click();
  await page.getByRole("textbox", {name: "Workspace set name"}).fill("Offline draft");
  await page.getByRole("button", {name: "Save workspace set"}).click();
  await expect(page.getByRole("dialog")).toContainText("Save failed");
  expect(writes).toBe(0);
  await page.keyboard.press("Escape");
  failing = false; await page.locator(".preferences-notice").getByRole("button", {name: "Retry", exact: true}).click();
  await expect(page.locator(".workspace-picker")).toHaveText("Shared analysis");
  await expect(page.locator(".chart-card")).toHaveCount(1); expect(reads).toBeGreaterThan(1);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test("one Save slot retains its baseline through pending saves and concurrent edits", async ({page}) => {
  await mockApi(page); await seedPanels(page, [chart]);
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".workspace-save-status")).toHaveText("Saved");
  const savedBounds = (await page.locator(".workspace-save-slot").boundingBox())!;
  const textTop = await page.locator(".workspace-save-status").evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().top;
  });
  const canvas = await page.locator(".chart-card canvas").elementHandle();
  await resizeChart(page);
  const editBounds = (await page.locator(".workspace-save-slot").boundingBox())!;
  expect(editBounds).toEqual(savedBounds);
  const editTextTop = await page.locator(".workspace-save span").evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().top;
  });
  expect(Math.abs(editTextTop - textTop)).toBeLessThan(.6);
  let release!: () => void, submitted: unknown;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/ui/workspaces", async route => {submitted = route.request().postDataJSON(); await gate; await route.fallback();});
  try {
    await page.getByRole("button", {name: "Save current workspace"}).click();
    await expect(page.locator(".workspace-save-slot")).toHaveText("Saving…");
    await expect(page.locator(".workspace-save-slot button")).toHaveCount(0);
    expect((await page.locator(".workspace-save-slot").boundingBox())!).toEqual(savedBounds);
    await page.screenshot({path: "artifacts/server-save-pending.png"});
    await resizeChart(page, "Normal width");
    expect(submitted).toMatchObject({revision: 1, sets: [{panels: [{size: "wide"}]}]});
    await page.getByRole("button", {name: "Add", exact: true}).click();
    release();
    await expect(page.getByRole("dialog", {name: "Add", exact: true})).toBeVisible();
    await page.getByRole("dialog", {name: "Add", exact: true}).getByRole("button", {name: "Cancel", exact: true}).click();
    await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
    await expect(page.locator(".workspace-save-status")).toHaveCount(0);
    expect((await serverState(page)).workspaces.sets[0]!.panels[0]!.size).toBe("wide");
    await page.getByRole("button", {name: "Save current workspace"}).click();
    await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
    expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  } finally {release();}
});

test("uncertain saves retry exactly the same immutable mutation, even after more edits", async ({page}) => {
  await mockApi(page); await seedPanels(page, [chart]);
  await page.goto("/rvx?runs=run-1"); await resizeChart(page);
  const payloads: string[] = [];
  await page.route("**/api/ui/workspaces", route => {
    payloads.push(route.request().postData()!);
    return payloads.length === 1 ? route.fulfill({status: 503, json: {error: "Commit outcome unknown"}}) : route.fallback();
  });
  await page.getByRole("button", {name: "Save current workspace"}).click();
  await expect(page.getByRole("button", {name: "Retry saving workspace"})).toBeVisible();
  await resizeChart(page, "Normal width");
  await page.getByRole("button", {name: "Retry saving workspace"}).click();
  await expect.poll(() => payloads.length).toBe(2); expect(payloads[1]).toBe(payloads[0]);
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  expect((await serverState(page)).workspaces.sets[0]!.panels[0]!.size).toBe("wide");
});

test("fresh browsers share definitions, keep separate preferences, and explicitly resolve stale saves", async ({page, browser}) => {
  await mockApi(page); await seedPanels(page, [chart]);
  const shared = uiServer(page);
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
  await expect.poll(async () => (await serverState(page)).browser.theme).toBe("dark");
  shared.initialBrowser = {theme: "light", sidebar_width: 280, selected: {}, run_colors: {}};
  const context = await browser.newContext({baseURL: test.info().project.use.baseURL});
  const other = await context.newPage();
  try {
    await mockApi(other, {uiServer: shared}); await other.goto("/rvx?runs=run-1");
    await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(other.locator(".workspace-picker")).toHaveText("Default");
    await other.getByRole("button", {name: "Workspace sets"}).click();
    await other.getByRole("button", {name: "Shared analysis", exact: true}).click();
    await resizeChart(other); await other.getByRole("button", {name: "Save current workspace"}).click();
    await expect(other.locator(".workspace-save-slot")).toHaveText("Saved");
    await resizeChart(page);
    await page.getByRole("button", {name: "Save current workspace"}).click();
    const conflict = page.getByRole("dialog", {name: "Workspace changed on server"});
    await expect(conflict).toBeVisible();
    await page.screenshot({path: "artifacts/server-save-conflict.png"});
    await expect(page.locator('[data-panel-id="chart"]')).toHaveClass(/wide/);
    await expect(conflict.getByRole("button", {name: "Reload server version"})).toBeVisible();
    await conflict.getByRole("button", {name: "Save copy", exact: true}).click();
    await page.getByRole("textbox", {name: "Workspace set name"}).fill("My preserved copy");
    await page.getByRole("button", {name: "Save workspace set"}).click();
    await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
    expect(shared.workspaces.sets.map(set => set.name)).toEqual(["Shared analysis", "My preserved copy"]);
    await other.reload();
    await expect(other.locator(".workspace-picker")).toHaveText("Shared analysis");
    await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
    await other.getByRole("button", {name: "Workspace sets"}).click();
    await expect(other.getByRole("button", {name: "My preserved copy", exact: true})).toBeVisible();
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    expect((await page.context().cookies()).find(cookie => cookie.name === "rvx_browser")?.httpOnly).toBe(true);
  } finally {await context.close();}
});

test("sidebar pointer and keyboard resizing commits server width and preserves desktop preference across breakpoints", async ({page}) => {
  const requests = await mockApi(page); await seedPanels(page, [chart]);
  await page.goto("/rvx?runs=run-1");
  const separator = page.getByRole("separator", {name: "Resize run list"}), dock = page.locator(".runs-dock");
  await expect(separator).toHaveAttribute("aria-valuenow", "280");
  const canvas = await page.locator(".chart-card canvas").elementHandle();
  const bounds = (await separator.boundingBox())!;
  await page.mouse.move(bounds.x + 3, bounds.y + 80); await page.mouse.down();
  await page.mouse.move(bounds.x + 83, bounds.y + 80, {steps: 8});
  await page.screenshot({path: "artifacts/server-sidebar-resizing.png"});
  expect(requests.filter(request => request.path === "/api/ui/browser")).toHaveLength(0);
  await page.mouse.up();
  await expect.poll(async () => (await serverState(page)).browser.sidebar_width).toBe(360);
  expect(requests.filter(request => request.path === "/api/ui/browser")).toHaveLength(1);
  await separator.focus(); await page.keyboard.press("End");
  await expect.poll(async () => (await serverState(page)).browser.sidebar_width).toBe(520);
  await page.setViewportSize({width: 901, height: 900});
  expect((await dock.boundingBox())!.width).toBe(261);
  expect((await serverState(page)).browser.sidebar_width).toBe(520);
  await page.setViewportSize({width: 390, height: 844}); await expect(separator).toBeHidden();
  await page.getByRole("button", {name: "Select runs (1 selected)"}).click();
  await expect(page.getByRole("dialog", {name: "Runs", exact: true}).getByRole("separator")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.setViewportSize({width: 1440, height: 900});
  await expect.poll(async () => (await dock.boundingBox())!.width).toBe(520);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await page.reload(); await expect(separator).toHaveAttribute("aria-valuenow", "520");
  await separator.focus(); await page.keyboard.press("Home");
  await expect.poll(async () => (await serverState(page)).browser.sidebar_width).toBe(220);
});

test("websocket is green only after a matching pong, then timeout/reconnect refreshes settings and data", async ({page}) => {
  await page.clock.install();
  const requests = await mockApi(page); await seedPanels(page, [chart]);
  const sockets: WebSocketRoute[] = [], pings: {socket: WebSocketRoute; id: string}[] = [];
  await page.routeWebSocket("**/api/ui/connection", socket => {
    sockets.push(socket); socket.onMessage(message => pings.push({socket, id: JSON.parse(String(message)).id}));
  });
  await page.goto("/rvx?runs=run-1");
  const dot = page.locator(".connection-status");
  await expect(dot).toHaveAttribute("data-state", "connecting");
  await expect.poll(() => pings.length).toBe(1);
  await page.clock.runFor(125);
  pings[0]!.socket.send(JSON.stringify({type: "pong", id: pings[0]!.id}));
  await expect(dot).toHaveAttribute("data-state", "connected");
  await expect(dot).toHaveAttribute("aria-label", /Connected · WebSocket RTT \d+ ms/);
  await dot.hover();
  await expect(dot.locator(".connection-tooltip")).toBeVisible();
  await expect(dot.locator(".connection-tooltip")).toHaveText(/Connected · WebSocket RTT \d+ ms/);
  await page.screenshot({path: "artifacts/server-websocket-rtt.png"});
  const before = requests.filter(request => request.path === "/api/ui/state").length;
  await page.clock.runFor(5000); await expect.poll(() => pings.length).toBe(2);
  await page.clock.runFor(8001); await expect(dot).toHaveAttribute("data-state", "offline");
  await page.clock.runFor(1000); await expect.poll(() => sockets.length).toBe(2);
  await expect.poll(() => pings.length).toBe(3);
  const ping = pings.at(-1)!; ping.socket.send(JSON.stringify({type: "pong", id: ping.id}));
  await expect(dot).toHaveAttribute("data-state", "connected");
  await expect.poll(() => requests.filter(request => request.path === "/api/ui/state").length).toBeGreaterThan(before);
  expect(new Set(pings.map(ping => ping.id)).size).toBe(pings.length);
  await dot.focus(); await expect(dot).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", {persisted: false})));
  const count = sockets.length; await page.clock.runFor(40_000); expect(sockets.length).toBe(count);
});

test("malformed or unmatched pongs cannot turn the connection indicator green", async ({page}) => {
  await page.clock.install(); await mockApi(page);
  let socket!: WebSocketRoute, opened = 0;
  await page.routeWebSocket("**/api/ui/connection", current => {socket = current; opened++;});
  await page.goto("/rvx?runs=run-1");
  await expect.poll(() => opened).toBe(1);
  socket.send(JSON.stringify({type: "pong", id: "unmatched"}));
  await expect(page.locator(".connection-status")).toHaveAttribute("data-state", "offline");
  await page.clock.runFor(1001); await expect.poll(() => opened).toBe(2);
  socket.send("not JSON");
  await expect(page.locator(".connection-status")).toHaveAttribute("data-state", "offline");
  await page.evaluate(() => {Object.defineProperty(document, "hidden", {value: true, configurable: true}); document.dispatchEvent(new Event("visibilitychange"));});
  await page.clock.runFor(40_000); expect(opened).toBe(2);
});

test("reconnect reconciles server deletion without dropping the active draft or canvas", async ({page}) => {
  await page.clock.install(); await mockApi(page); await seedPanels(page, [chart]);
  let socket!: WebSocketRoute;
  await page.routeWebSocket("**/api/ui/connection", current => {
    socket = current;
    current.onMessage(message => current.send(JSON.stringify({type: "pong", id: JSON.parse(String(message)).id})));
  });
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".connection-status")).toHaveAttribute("data-state", "connected");
  const canvas = await page.locator(".chart-card canvas").elementHandle();
  const server = uiServer(page);
  server.workspaces = {revision: 2, sets: []};
  const browser = server.browsers.get(page.context())!; browser.selected = {}; browser.revision++;
  socket.close();
  await expect(page.locator(".connection-status")).toHaveAttribute("data-state", "offline");
  await page.clock.runFor(1001);
  await expect(page.locator(".workspace-picker")).toHaveText("Untitled");
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  expect((await serverState(page)).browser.selected).toEqual({});
});

test("tables refresh alongside charts at five seconds while retaining page/search/filter/sort and clamping shrink", async ({page}) => {
  await page.clock.install();
  const options: FixtureOptions = {tableRows: 200};
  const requests = await mockApi(page, options);
  await seedPanels(page, [{...chart, size: "wide"}, {...table, query: {search: "worker", filters: [{path: "/load", op: "gt", value: "-1"}], sort: {path: "/load", direction: "asc"}}}]);
  await page.setViewportSize({width: 1440, height: 1400}); await page.goto("/rvx?runs=run-1&live=0");
  const card = page.locator(".table-card"); await expect(card.locator("tbody tr")).toHaveCount(75);
  await card.getByRole("button", {name: "Next page"}).click(); await expect(card.locator(".table-footer")).toContainText("76–150");
  await card.getByRole("button", {name: "Next page"}).click(); await expect(card.locator(".table-footer")).toContainText("151–200");
  const chartReads = requests.filter(request => request.path === "/api/snapshots/query").length;
  const tableReads = requests.filter(request => request.path === "/api/tables/rows").length;
  options.tableVersion = 1; options.tableRows = 80;
  await page.clock.runFor(4900);
  expect(requests.filter(request => request.path === "/api/tables/rows").length).toBe(tableReads);
  await page.clock.runFor(150);
  await expect(card.locator(".table-footer")).toContainText("76–80 of 80");
  await expect(card.locator('tbody [data-column="/load"]').first()).toHaveText("10075");
  expect(requests.filter(request => request.path === "/api/snapshots/query").length).toBeGreaterThan(chartReads);
  const latest = requests.filter(request => request.path === "/api/tables/rows").at(-1)!.body!;
  expect(latest).toMatchObject({search: "worker", filters: [{path: "/load", op: "gt", value: "-1"}], sort: {path: "/load", direction: "asc"}, offset: 75});
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  await expect(card.getByRole("button", {name: /Refresh|Use latest/})).toHaveCount(0);
  await expect(card.locator(".chart-status")).toBeHidden();
  await expect(card.locator('tbody [data-column="@observed"]').first()).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(card.locator('tbody [data-column="@observed"]').first()).toHaveAttribute("title", /2026/);
});

test("moving summary bounds retain rows, stable headers and focus through slow refresh and column drag", async ({page}) => {
  await page.clock.install();
  const options: FixtureOptions = {points: 180};
  await mockApi(page, options);
  await seedPanels(page, [{id: "summary", kind: "metric-table", paths: ["/progress/loss", "/progress/reward"], sectionId: "initial", size: "wide"}]);
  await page.goto("/rvx?runs=run-1&range=900");
  const card = page.locator(".table-card"); await expect(card.locator("tbody tr")).toHaveCount(2);
  const header = await card.locator("thead").elementHandle(), row = await card.locator("tbody tr").first().elementHandle();
  await card.getByRole("searchbox").focus();
  let release!: () => void, calls = 0, failures = 0;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/tables/summary", async route => {calls++; await gate; await route.fallback();});
  page.on("requestfailed", request => {if (request.url().includes("/api/tables/summary")) failures++;});
  try {
    options.points = 181; await page.clock.runFor(5001);
    await expect.poll(() => calls).toBe(1);
    await expect(card.locator("tbody tr")).toHaveCount(2);
    await expect(card.locator(".chart-status")).toBeHidden();
    await expect(card.getByRole("searchbox")).toBeFocused();
    await page.clock.runFor(5001); expect(calls).toBe(1); expect(failures).toBe(0);
    const separator = card.getByRole("separator", {name: "Resize Metric column"});
    const before = (await separator.boundingBox())!;
    await page.mouse.move(before.x + 2, before.y + 10); await page.mouse.down();
    await page.mouse.move(before.x + 60, before.y + 10);
    release(); await page.waitForTimeout(100);
    expect(await header!.evaluate(node => node.isConnected)).toBe(true);
    expect(await row!.evaluate(node => node.isConnected)).toBe(true);
    expect(await separator.evaluate(node => node.isConnected)).toBe(true);
    await page.mouse.up();
    expect((await card.locator('th[data-column="@metric"]').boundingBox())!.width).toBeGreaterThan(220);
  } finally {release();}
});

test("selected table text survives new observations and releases the deferred latest rows on deselection", async ({page}) => {
  await page.clock.install();
  const options: FixtureOptions = {tableRows: 2}; await mockApi(page, options); await seedPanels(page, [table]);
  await page.goto("/rvx?runs=run-1");
  const card = page.locator(".table-card"); await expect(card.locator("tbody tr")).toHaveCount(2);
  const cell = card.locator('tbody [data-column="/load"]').first();
  await cell.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  options.tableVersion = 1;
  await page.clock.runFor(5100);
  await expect(cell).toHaveText("0");
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("0");
  await page.evaluate(() => document.getSelection()!.removeAllRanges());
  await expect(cell).toHaveText("10000");
});

test("content-sized tables, rounded cards and unified padded title/unit render across responsive themes", async ({page}) => {
  await mockApi(page, {tableRows: 200});
  await seedPanels(page, [chart, {...table, id: "small", path: "/queues"}, {...table, id: "large"}]);
  const measurements: unknown[] = [];
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".preferences-notice")).toBeHidden();
  for (const width of [390, 901, 1440, 2560]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({width, height: 1000});
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.getByRole("button", {name: `Switch to ${theme} appearance`}).click();
    const small = page.locator('[data-panel-id="small"]'), large = page.locator('[data-panel-id="large"]');
    await small.scrollIntoViewIfNeeded(); await expect(small.locator("tbody tr")).toHaveCount(2);
    const smallHeight = (await small.boundingBox())!.height;
    expect(smallHeight).toBeLessThan(320);
    await large.scrollIntoViewIfNeeded(); await expect(large.locator("tbody tr")).toHaveCount(75);
    const largeHeight = (await large.boundingBox())!.height;
    expect(largeHeight).toBeLessThanOrEqual(560); expect(largeHeight).toBeGreaterThan(smallHeight);
    await page.screenshot({path: `artifacts/server-tables-${width}-${theme}.png`});
    const title = page.locator('[data-panel-id="chart"] .panel-drag-handle');
    await title.scrollIntoViewIfNeeded(); await title.hover();
    const geometry = await title.evaluate(node => {
      const box = node.getBoundingClientRect(), card = node.closest(".chart-card")!.getBoundingClientRect(), unit = node.querySelector(".metric-unit")!.getBoundingClientRect(), style = getComputedStyle(node);
      return {center: Math.abs((box.left + box.right - card.left - card.right) / 2), unitContained: unit.left >= box.left && unit.right <= box.right,
        paddingX: parseFloat(style.paddingLeft), paddingY: parseFloat(style.paddingTop), radius: parseFloat(getComputedStyle(node.closest(".chart-card")!).borderRadius)};
    });
    expect(geometry.center).toBeLessThan(1); expect(geometry.unitContained).toBe(true);
    expect(geometry.paddingX).toBeGreaterThanOrEqual(8); expect(geometry.paddingY).toBeGreaterThanOrEqual(6);
    expect(geometry.radius).toBeGreaterThanOrEqual(6); expect(geometry.radius).toBeLessThanOrEqual(8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    measurements.push({width, theme, smallHeight, largeHeight, ...geometry});
    await page.screenshot({path: `artifacts/server-title-${width}-${theme}.png`});
  }
  const large = page.locator('[data-panel-id="large"]');
  await large.scrollIntoViewIfNeeded(); await large.getByRole("button", {name: /table options$/}).click();
  await large.getByRole("menuitem", {name: "Fullscreen"}).click();
  expect((await page.getByRole("dialog").locator(".table-card").boundingBox())!.height).toBeGreaterThan(850);
  await page.screenshot({path: "artifacts/server-table-fullscreen.png"});
  await writeFile("artifacts/server-ui-geometry.json", JSON.stringify(measurements, null, 2));
});

test("the RVX brand stays vertically centered and shares its mark with the favicon", async ({page}) => {
  await mockApi(page); await seedPanels(page, [chart]); await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".brand")).toHaveAttribute("aria-label", "RVX");
  for (const width of [320, 390, 901, 1440]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({width, height: 900});
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.getByRole("button", {name: `Switch to ${theme} appearance`}).click();
    const geometry = await page.locator(".brand").evaluate(node => {
      const image = node.querySelector<HTMLImageElement>(".brand-icon")!;
      const box = image.getBoundingClientRect(), bar = node.closest(".appbar")!.getBoundingClientRect();
      return {width: box.width, height: box.height, center: Math.abs((box.top + box.bottom - bar.top - bar.bottom) / 2),
        transform: getComputedStyle(node).transform, gap: getComputedStyle(node).gap,
        favicon: new URL(document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href).pathname,
        source: new URL(image.currentSrc).pathname};
    });
    expect(geometry).toMatchObject({width: 28, height: 28, transform: "none", gap: "7px"});
    expect(geometry.center).toBeLessThanOrEqual(.5); expect(geometry.favicon).toBe(geometry.source);
    if (width <= 380) await expect(page.locator(".brand-wordmark")).toBeHidden();
    else await expect(page.locator(".brand-wordmark")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: `artifacts/server-brand-${width}-${theme}.png`});
  }
});
