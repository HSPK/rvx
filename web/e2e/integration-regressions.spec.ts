import {test, expect, type Page} from "@playwright/test";
import {mockApi, seedWorkspace, serverState, type FixtureOptions} from "./fixtures";

async function savedSet(page: Page, paths: string[]): Promise<void> {
  await seedWorkspace(page, paths.map(path => ({path, size: "normal"})));
}

test("absent saved paths cannot fail healthy sibling charts in another run", async ({page}) => {
  await savedSet(page, ["/resources/memory", "/progress/loss"]);
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-2");
  const missing = page.locator('.chart-card[data-path="/resources/memory"]');
  const healthy = page.locator('.chart-card[data-path="/progress/loss"]');
  await expect(missing.getByText("Not recorded", {exact: true})).toBeVisible();
  await expect(missing.getByText("No numeric observations recorded for this field.")).toBeVisible();
  await expect(healthy.locator("canvas")).toBeVisible();
  await expect(page.getByText("Request failed", {exact: true})).toHaveCount(0);
  expect(requests.filter(request => request.path === "/api/snapshots/query").every(request => JSON.stringify(request.body?.paths) === JSON.stringify(["/progress/loss"]))).toBe(true);
  await page.screenshot({path: "artifacts/saved-field-unavailable-desktop.png"});
});

test("a wholly absent saved set settles honestly without sending an empty or unindexed query", async ({page}) => {
  await savedSet(page, ["/resources/memory"]);
  const options: FixtureOptions = {omittedPaths: ["/resources/memory"]};
  const requests = await mockApi(page, options);
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".chart-card .chart-status")).toHaveText("Not recorded");
  await page.waitForTimeout(150);
  expect(requests.filter(request => request.path === "/api/snapshots/query")).toHaveLength(0);
  await expect(page.locator(".chart-card").getByRole("menuitem", {name: /Inspect/, includeHidden: true})).toHaveCount(0);
  delete options.omittedPaths;
  await expect(page.locator(".chart-card canvas")).toBeVisible({timeout: 9000});
  await expect(page.locator(".chart-card").getByRole("heading", {name: "Memory usage"})).toBeVisible();
  await expect(page.locator(".chart-card .metric-unit")).toHaveText("GB");
});

test("a newly absent field clears stale evidence without replacing a healthy sibling plot", async ({page}) => {
  await savedSet(page, ["/resources/memory", "/progress/loss"]);
  const options: FixtureOptions = {};
  const requests = await mockApi(page, options);
  await page.goto("/rvx?runs=run-1");
  const memory = page.locator('.chart-card[data-path="/resources/memory"]');
  const healthy = page.locator('.chart-card[data-path="/progress/loss"]');
  await expect(memory.locator("canvas")).toBeVisible();
  const canvas = await healthy.locator("canvas").elementHandle();
  options.omittedPaths = ["/resources/memory"];
  const previous = requests.filter(request => request.path === "/api/snapshots/query").length;
  await expect(memory.locator(".chart-status")).toHaveText("Not recorded", {timeout: 9000});
  await expect(memory.locator("canvas")).toBeHidden();
  await expect(healthy.locator(".chart-status")).toBeHidden();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  const subsequent = requests.filter(request => request.path === "/api/snapshots/query").slice(previous);
  expect(subsequent.length).toBeGreaterThan(0);
  expect(subsequent.every(request => !(request.body?.paths as string[]).includes("/resources/memory"))).toBe(true);
});

for (const mode of ["ambiguous", "nondefault"] as const) {
  test(`${mode} catalogs continue discovery until meaningful unambiguous defaults arrive`, async ({page}) => {
    const options: FixtureOptions = {mode};
    const requests = await mockApi(page, options);
    await page.goto("/rvx?runs=run-1");
    await expect(page.getByRole("heading", {name: "Choose recorded fields"})).toBeVisible();
    await expect(page.locator(".chart-card")).toHaveCount(0);
    delete options.mode;
    await expect(page.locator(".chart-card")).toHaveCount(6, {timeout: 9000});
    await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
    expect(requests.filter(request => request.path === "/api/charts/catalog").length).toBeGreaterThan(1);
  });
}

test("explicit removal and a saved empty set never regrow during later discovery", async ({page}) => {
  const options: FixtureOptions = {};
  await mockApi(page, options);
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".chart-card")).toHaveCount(6);
  for (let index = 0; index < 6; index++) {
    const first = page.locator(".chart-card").first();
    await first.locator(".menu-trigger").click();
    await first.getByRole("menuitem", {name: "Remove chart", exact: true}).click();
  }
  await expect(page.getByRole("heading", {name: "No panels selected"})).toBeVisible();
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("textbox", {name: "Workspace set name"}).fill("Intentional blank");
  await page.getByRole("button", {name: "Save workspace set", exact: true}).click();
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  await expect.poll(async () => (await serverState(page)).browser.selected["experiment-1"]).toBeTruthy();
  options.mode = "waiting";
  await page.reload();
  await expect(page.getByRole("heading", {name: "No panels selected"})).toBeVisible();
  delete options.mode;
  await page.waitForTimeout(5500);
  await expect(page.locator(".chart-card")).toHaveCount(0);
});

test("obsolete local settings remain untouched without redundant migration notices", async ({page}) => {
  await page.addInitScript(() => localStorage.setItem("rvx.workspace.v1", "{invalid json"));
  await mockApi(page);
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".preferences-notice")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("rvx.workspace.v1"))).toBe("{invalid json");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await expect(page.getByText(/Older browser-only|Shared on this server/)).toHaveCount(0);
  await page.screenshot({path: "artifacts/preferences-invalid-desktop.png"});
  await page.keyboard.press("Escape");
  await expect(page.locator(".preferences-notice")).toBeHidden();
});

test("unavailable local storage cannot block server settings or mobile charts", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {get: () => {throw new DOMException("denied", "SecurityError");}});
  });
  await mockApi(page);
  await page.goto("/rvx");
  await expect(page.locator(".preferences-notice")).toBeHidden();
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: "artifacts/preferences-storage-mobile.png"});
});

test("failed server writes warn for both chart-set saves and appearance changes", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await mockApi(page);
  await page.route("**/api/ui/{workspaces,browser}", route => route.fulfill({status: 503, json: {error: "Server settings are temporarily unavailable"}}));
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("textbox", {name: "Workspace set name"}).fill("Working selection");
  await page.getByRole("button", {name: "Save workspace set", exact: true}).click();
  const modal = page.getByRole("dialog", {name: "Workspace sets", exact: true});
  await expect(modal).toContainText("Save failed. Your draft remains available.");
  await expect(page.getByRole("button", {name: "Retry saving workspace"})).toBeVisible();
  await page.screenshot({path: "artifacts/preferences-save-warning-mobile.png"});
  await page.keyboard.press("Escape");
  await expect(page.locator(".preferences-notice")).toContainText("Server settings are temporarily unavailable");
  await page.getByRole("button", {name: "Dismiss notification"}).click();
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
  await expect(page.locator(".preferences-notice")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
});
