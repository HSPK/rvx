import {test, expect, type Page} from "@playwright/test";
import {mockApi, type FixtureOptions} from "./fixtures";

async function visibility(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(value => {Object.defineProperty(document, "hidden", {value, configurable: true}); document.dispatchEvent(new Event("visibilitychange"));}, hidden);
}
test("a hidden initial catalog load resumes automatically when visible", async ({page}) => {
  await mockApi(page);
  let held = true, release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/charts/catalog", async route => {if (held) await gate; await route.fallback();});
  try {
    await page.goto("/rvx?runs=run-1");
    await expect(page.getByRole("heading", {name: "Loading panels", exact: true})).toBeVisible();
    await visibility(page, true);
    held = false; release();
    await expect(page.locator(".chart-card")).toHaveCount(0);
    await visibility(page, false);
    await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
    await expect(page.getByRole("button", {name: /Pause live|Resume live/})).toHaveCount(0);
  } finally {release();}
});
test("an initial projection canceled by visibility resumes without remounting cards", async ({page}) => {
  await mockApi(page);
  let held = true, release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/snapshots/query", async route => {if (held) await gate; await route.fallback();});
  try {
    await page.goto("/rvx?runs=run-1");
    const first = page.locator(".chart-card").first(); await expect(first).toBeVisible();
    const card = await first.elementHandle();
    await visibility(page, true);
    await page.setViewportSize({width: 390, height: 844});
    held = false; release(); await visibility(page, false);
    await expect(first.locator("canvas")).toBeVisible();
    await expect(first.locator(".chart-status")).toBeHidden();
    expect(await card!.evaluate(node => node.isConnected)).toBe(true);
  } finally {release();}
});
test("retry exposes meaningful progress while preserving the last successful curve", async ({page}) => {
  const options: FixtureOptions = {}; await mockApi(page, options);
  let held = false, release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/snapshots/query", async route => {if (held) await gate; await route.fallback();});
  try {
    await page.goto("/rvx?runs=run-1");
    const first = page.locator(".chart-card").first(); await expect(first.locator("canvas")).toBeVisible();
    const original = await first.locator("canvas").elementHandle();
    options.failQueries = true;
    await expect(first.getByRole("button", {name: "Retry", exact: true})).toBeVisible({timeout: 9000});
    options.failQueries = false; held = true;
    await first.getByRole("button", {name: "Retry", exact: true}).click();
    await expect(first.locator(".chart-status")).toHaveText("Retrying…");
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    held = false; release();
    await expect(first.locator(".chart-status")).toBeHidden();
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  } finally {release();}
});
test("slow initial projections are not canceled by the five-second timer", async ({page}) => {
  await mockApi(page);
  let calls = 0, failures = 0, release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/snapshots/query", async route => {calls++; await gate; await route.fallback();});
  page.on("requestfailed", request => {if (new URL(request.url()).pathname === "/api/snapshots/query") failures++;});
  try {
    await page.goto("/rvx?runs=run-1");
    await expect.poll(() => calls).toBe(1);
    await page.waitForTimeout(5500); expect(calls).toBe(1); expect(failures).toBe(0);
    release(); await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  } finally {release();}
});
test("old live=0 URLs are canonicalized and cannot disable refresh after visibility resumes", async ({page}) => {
  await page.addInitScript(() => {Object.defineProperty(document, "hidden", {value: true, configurable: true});});
  const requests = await mockApi(page); await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".workspace-page")).toBeVisible();
  expect(requests.some(request => request.path === "/api/charts/catalog")).toBe(false);
  expect(new URL(page.url()).searchParams.has("live")).toBe(false);
  await visibility(page, false);
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  const count = requests.filter(request => request.path === "/api/snapshots/query").length;
  await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").length, {timeout: 7000}).toBeGreaterThan(count);
});
test("a hidden range read resumes with its actual latest requested bounds", async ({page}) => {
  const requests = await mockApi(page);
  let held = false, waiting = false, release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/snapshots/query", async route => {if (held) {waiting = true; await gate;} await route.fallback();});
  try {
    await page.goto("/rvx?runs=run-1&live=0");
    const chart = page.locator(".chart-card").first(); await expect(chart.locator("canvas")).toBeVisible();
    held = true;
    await page.getByRole("combobox", {name: "Time range", exact: true}).selectOption("900");
    await expect.poll(() => waiting).toBe(true); await visibility(page, true);
    held = false; release(); await visibility(page, false);
    await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body?.from).toBe(9840e9);
    await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", /2h 44m/);
  } finally {release();}
});
