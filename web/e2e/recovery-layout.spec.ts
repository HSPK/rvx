import {test, expect} from "@playwright/test";
import {mockApi, runs, type FixtureOptions} from "./fixtures";

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
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
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

test("run sheets fit empty, short and large lists without moving the search field", async ({page}) => {
  await mockApi(page, {runCount: 10_000});
  let count = 0;
  await page.route("**/api/experiments/runs", route => count > 4 ? route.fallback() : route.fulfill({json: {runs: runs.slice(0, count)}}));
  await page.setViewportSize({width: 390, height: 844});
  let shortHeight = 0;
  for (const size of [0, 1, 4, 10_000]) {
    count = size;
    await page.goto("/rvx?runs=");
    await page.getByRole("button", {name: "Select runs (0 selected)"}).click();
    const sheet = page.getByRole("dialog", {name: "Runs", exact: true});
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
      const search = sheet.getByRole("searchbox", {name: "Search runs"});
      const before = (await search.boundingBox())!.y;
      await search.fill("training-09999");
      await expect(sheet.locator(".run-row")).toHaveCount(1);
      expect(Math.abs((await search.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
      expect((await sheet.boundingBox())!.height).toBeLessThan(540);
      await page.screenshot({path: "artifacts/adaptive-run-sheet-filtered.png"});
    }
    await sheet.getByRole("button", {name: "Close", exact: true}).click();
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
      const columns = await page.locator(".chart-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length);
      expect(columns).toBe(width === 901 || width === 390 ? 1 : 2);
    }
    await expect(page.locator(".runs-selector")).toHaveCount(1);
    expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
    await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", zoom!);
  }
  await page.getByRole("button", {name: "Select runs (2 selected)"}).click();
  await expect(page.getByRole("dialog", {name: "Runs", exact: true})).toBeVisible();
  await page.setViewportSize({width: 901, height: 900});
  await expect(page.getByRole("dialog", {name: "Runs", exact: true})).toHaveCount(0);
  await expect(page.locator(".runs-dock")).toBeVisible();
  await expect(page.getByRole("searchbox", {name: "Search runs"})).toBeFocused();
  await page.setViewportSize({width: 1800, height: 900});
  expect(await page.locator(".chart-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(3);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", zoom!);
  await page.setViewportSize({width: 844, height: 390});
  await page.getByRole("button", {name: "Select runs (2 selected)"}).click();
  const sheet = page.getByRole("dialog", {name: "Runs", exact: true});
  await expect(sheet.getByRole("button", {name: "Refresh runs"})).toBeVisible();
  expect((await sheet.locator(".run-viewport").boundingBox())!.height).toBeGreaterThan(100);
  await sheet.getByRole("checkbox", {name: "Select ppo · small batch"}).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: "artifacts/adaptive-run-sheet-landscape.png"});
});
