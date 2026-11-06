import {test, expect} from "@playwright/test";
import {mockApi, runs, seedUiState, uiServer, setTheme, openRunManagement, type FixtureOptions} from "./fixtures";

test("initial metadata and catalog retries show loading before recovering", async ({page}) => {
  const options: FixtureOptions = {failCatalog: true};
  await mockApi(page, options);
  let failMetadata = true, holdCatalog = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/experiments/runs", route => failMetadata ? route.fulfill({status: 503, body: "Metadata unavailable"}) : route.fallback());
  await page.route("**/api/charts/catalog", async route => {if (holdCatalog) await gate; await route.fallback();});
  try {
    await page.goto("/rvx?runs=run-1&live=0");
    await expect(page.getByRole("heading", {name: "Could not load runs"})).toBeVisible();
    failMetadata = false;
    await page.getByRole("button", {name: "Try again", exact: true}).click();
    await expect(page.getByRole("heading", {name: "Could not load panels"})).toBeVisible();
    options.failCatalog = false; holdCatalog = true;
    await page.getByRole("button", {name: "Try again", exact: true}).click();
    await expect(page.getByRole("heading", {name: "Loading panels"})).toBeVisible();
    await expect(page.getByRole("button", {name: "Try again", exact: true})).toHaveCount(0);
    release();
    await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  } finally {release();}
});

test("metadata recovery clears only its own notification and preserves preference warnings", async ({page}) => {
  await mockApi(page);
  let failMetadata = false;
  await page.route("**/api/experiments/runs", route => failMetadata ? route.fulfill({status: 503, body: "Metadata unavailable"}) : route.fallback());
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const canvas = await chart.locator("canvas").elementHandle();
  const refresh = page.getByRole("button", {name: "Refresh runs", exact: true});
  const notice = page.locator(".preferences-notice");
  await expect(notice).toBeHidden();
  failMetadata = true;
  await refresh.click();
  await expect(notice).toContainText("Run metadata could not be refreshed");
  await expect(notice.getByRole("button", {name: "Dismiss notification"})).toBeVisible();
  failMetadata = false;
  await refresh.click();
  await expect(notice).toBeHidden();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await page.route("**/api/ui/browser", route => route.fulfill({status: 503, json: {error: "Appearance could not be saved"}}));
  await setTheme(page, "dark");
  await expect(notice).toContainText("could not be saved");
  failMetadata = true;
  await refresh.click();
  await expect(notice).toContainText("Run metadata could not be refreshed");
  failMetadata = false;
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(notice).toContainText("could not be saved");
  await notice.getByRole("button", {name: "Dismiss notification"}).click();
  await expect(notice).toBeHidden();
});

test("lost updates use bottom-right floating notifications without moving the layout or discarding the last frame", async ({page}) => {
  const options: FixtureOptions = {failCatalog: false};
  await mockApi(page, options);
  await page.goto("/rvx?runs=run-1");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const canvas = await chart.locator("canvas").elementHandle();
  const before = (await page.locator(".chart-scroll").boundingBox())!.y;
  options.failCatalog = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const notice = page.locator(".notification-region .preferences-notice");
  await expect(notice).toContainText("Updates unavailable");
  await expect(notice).toHaveAttribute("title", /Catalog temporarily unavailable/);
  await expect(page.getByRole("region", {name: "Notifications", exact: true})).toHaveCSS("position", "fixed");
  expect((await page.locator(".chart-scroll").boundingBox())!.y).toBe(before);
  await expect(page.locator(".workspace-page .workspace-notice")).toBeHidden();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  for (const width of [390, 320, 1440]) {
    await page.setViewportSize({width, height: 900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = (await notice.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
    expect(box.x + box.width).toBeGreaterThan(width - 24);
    expect(box.y + box.height).toBeGreaterThan(900 - 24);
    await expect(notice.getByRole("button", {name: "Retry", exact: true})).toBeInViewport();
  }
  options.failCatalog = false;
  await notice.getByRole("button", {name: "Retry", exact: true}).click();
  await expect(notice).toBeHidden();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
});

test("newer workspace messages float outside the layout and dismiss without changing the current canvas", async ({page}) => {
  await page.clock.install(); await mockApi(page);
  await seedUiState(page, {selected: {"experiment-1": "saved"}, sets: [{
    id: "saved", name: "Analysis", experimentId: "experiment-1", sections: [{id: "main", name: "", collapsed: false}],
    panels: [{kind: "chart", id: "chart", sectionId: "main", size: "normal", path: "/progress/loss"}],
  }]});
  let socket!: import("@playwright/test").WebSocketRoute;
  await page.routeWebSocket("**/api/ui/connection", current => {
    socket = current;
    current.onMessage(message => current.send(JSON.stringify({type: "pong", id: JSON.parse(String(message)).id})));
  });
  await page.goto("/rvx?runs=run-1");
  const chart = page.locator(".chart-card"), scroll = page.locator(".chart-scroll");
  await expect(chart.locator("canvas")).toBeVisible();
  await expect(page.locator(".connection-status")).toHaveAttribute("data-state", "connected");
  const canvas = await chart.locator("canvas").elementHandle(), before = await scroll.boundingBox();
  const server = uiServer(page); server.workspaces.revision++;
  server.workspaces.sets[0]!.panels[0]!.size = "wide";
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/charts/catalog", async route => {await gate; await route.fallback();});
  try {
    socket.close(); await expect(page.locator(".connection-status")).toHaveAttribute("data-state", "offline");
    await page.clock.runFor(1001);
    const notice = page.locator(".notification-region > .workspace-notice:not(.preferences-notice)");
    await expect(notice).toContainText("A newer workspace is available on the server. Your current layout is unchanged.");
    await expect(notice.getByRole("button", {name: "Try again", exact: true})).toBeVisible();
    expect(await scroll.boundingBox()).toEqual(before);
    await expect(page.locator(".workspace-page .workspace-notice,.appbar .workspace-notice")).toHaveCount(0);
    await expect(chart).not.toHaveClass(/wide/);
    expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
    await notice.getByRole("button", {name: "Dismiss message", exact: true}).click();
    await expect(notice).toBeHidden();
    expect(await scroll.boundingBox()).toEqual(before);
  } finally {release();}
});

test("mobile run panels fit empty, short and virtualized large lists without a search field", async ({page}) => {
  await mockApi(page, {runCount: 10_000});
  let count = 0;
  await page.route("**/api/experiments/runs", route => count > 4 ? route.fallback() : route.fulfill({json: {runs: runs.slice(0, count)}}));
  await page.setViewportSize({width: 390, height: 844});
  let shortHeight = 0;
  for (const size of [0, 1, 4, 10_000]) {
    count = size;
    await page.goto("/rvx?runs=");
    await openRunManagement(page);
    const sheet = page.locator(".runs-dock");
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    if (size === 0) {
      await expect(sheet.getByRole("heading", {name: "No runs yet"})).toBeVisible();
      expect(box.height).toBeLessThan(600);
    }
    if (size === 1) {
      shortHeight = box.height;
      expect(shortHeight).toBeLessThan(540);
      await page.screenshot({path: "artifacts/adaptive-run-sheet-one.png"});
    }
    if (size === 4) expect(box.height).toBeGreaterThan(shortHeight + 120);
    if (size === 10_000) {
      expect(await sheet.locator(".run-row").count()).toBeLessThanOrEqual(32);
      await sheet.locator(".run-viewport").evaluate(node => {node.scrollTop = node.scrollHeight;});
      await expect(sheet.getByRole("checkbox", {name: "Select training-09999"})).toBeVisible();
      await expect(sheet.getByRole("searchbox", {name: "Search runs"})).toBeHidden();
      expect((await sheet.boundingBox())!.height).toBeLessThan(540);
      await page.screenshot({path: "artifacts/adaptive-run-sheet-filtered.png"});
    }
    await sheet.getByRole("button", {name: "Manage runs", exact: true}).click();
  }
});

test("breakpoint changes move one selector without resetting plots, zoom or keyboard context", async ({page}) => {
  await mockApi(page);
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const canvas = await chart.locator("canvas").elementHandle();
  const overlay = (await chart.locator(".u-over").boundingBox())!;
  await page.mouse.move(overlay.x + 25, overlay.y + 30); await page.mouse.down();
  await page.mouse.move(overlay.x + overlay.width - 25, overlay.y + 30, {steps: 5}); await page.mouse.up();
  const zoom = await chart.locator(".chart-host").getAttribute("aria-description");
  for (const width of [1100, 901, 900, 761, 760, 600, 390, 320, 900]) {
    await page.setViewportSize({width, height: 900});
    await expect(chart.locator("canvas")).toBeVisible();
    const layout = await page.evaluate(() => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll("body *")].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 8).map(node => ({tag: node.tagName, className: String(node.className), right: node.getBoundingClientRect().right})),
    }));
    expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(width);
    await expect.poll(async () => {
      const plot = await chart.locator(".uplot").boundingBox();
      const host = await chart.locator(".chart-host").boundingBox();
      return Math.abs(plot!.height - host!.height);
    }).toBeLessThanOrEqual(1);
    if ([1100, 901, 900, 390].includes(width)) {
      await expect.poll(() => page.locator(".chart-grid [data-panel-id]").evaluateAll(nodes => {
        const top = nodes[0]!.getBoundingClientRect().top;
        return nodes.filter(node => Math.abs(node.getBoundingClientRect().top - top) < 1).length;
      })).toBe(width <= 1023 ? 1 : 2);
    }
    await expect(page.locator(".runs-selector")).toHaveCount(1);
    expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
    await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", zoom!);
  }
  await openRunManagement(page);
  await expect(page.getByRole("button", {name: "Manage runs", exact: true})).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({width: 901, height: 900});
  await expect(page.getByRole("dialog", {name: "Runs", exact: true})).toHaveCount(0);
  await expect(page.locator(".runs-dock")).toBeVisible();
  await expect(page.getByRole("searchbox", {name: "Search runs"})).toBeHidden();
  await page.setViewportSize({width: 1800, height: 900});
  await expect.poll(() => page.locator(".chart-grid [data-panel-id]").evaluateAll(nodes => {
    const top = nodes[0]!.getBoundingClientRect().top;
    return nodes.filter(node => Math.abs(node.getBoundingClientRect().top - top) < 1).length;
  })).toBe(4);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", zoom!);
  await page.setViewportSize({width: 844, height: 390});
  await openRunManagement(page);
  const sheet = page.locator(".runs-dock");
  await expect(sheet.getByRole("button", {name: "Refresh runs"})).toBeVisible();
  expect((await sheet.locator(".run-viewport").boundingBox())!.height).toBeGreaterThan(100);
  await sheet.getByRole("checkbox", {name: "Select ppo · small batch"}).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: "artifacts/adaptive-run-sheet-landscape.png"});
});
