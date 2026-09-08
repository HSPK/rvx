import {test, expect} from "@playwright/test";
import {mkdir, writeFile} from "node:fs/promises";
import {mockApi, runs} from "./fixtures";

for (const runCount of [10_000, 50_000]) test(`${runCount.toLocaleString()}-run rail stays searchable and virtualized without unselected catalog reads`, async ({page}, testInfo) => {
  const requests = await mockApi(page, {runCount});
  await page.goto("/rvx?runs=");
  await expect(page.locator(".run-count")).toHaveText(runCount.toLocaleString());
  expect(await page.locator(".run-row").count()).toBeLessThan(32);
  await page.locator(".run-viewport").evaluate(node => {node.scrollTop = node.scrollHeight;});
  await expect(page.getByRole("checkbox", {name: `Select training-${String(runCount - 1).padStart(5, "0")}`})).toBeVisible();
  expect(await page.locator(".run-row").count()).toBeLessThan(32);
  await page.getByRole("searchbox", {name: "Search runs"}).fill("training-08371");
  await expect(page.locator(".run-row")).toHaveCount(1);
  expect(requests.some(request => request.path === "/api/charts/catalog" || request.path.startsWith("/api/snapshots/"))).toBe(false);
  const inputMs = await page.getByRole("searchbox", {name: "Search runs"}).evaluate(input => {
    const start = performance.now();
    (input as HTMLInputElement).value = "training-05000";
    input.dispatchEvent(new Event("input", {bubbles: true}));
    return performance.now() - start;
  });
  const report = JSON.stringify({mode: "simulated metadata", runs: runCount, inputMs, renderedRows: await page.locator(".run-row").count()});
  await testInfo.attach("run-rail-input-cost", {body: report, contentType: "application/json"});
  await mkdir("artifacts", {recursive: true});
  await writeFile(`artifacts/run-rail-${runCount}.json`, report);
  expect(inputMs).toBeLessThan(runCount === 10_000 ? 50 : 100);
  if (runCount === 50_000) {
    await page.getByRole("checkbox", {name: "Select training-05000"}).check();
    await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
    await page.getByRole("searchbox", {name: "Search runs"}).fill("");
    await expect(page.locator(".run-count")).toHaveText("50,000");
    await page.screenshot({path: "artifacts/large-run-workspace.png"});
  }
});

test("default selection stays within scope; filtering never changes selected traces", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?experiment=experiment-2");
  await expect(page.getByRole("checkbox", {name: "Select ppo · small batch"})).toBeChecked();
  await expect(page).toHaveURL(/runs=run-3/);
  expect(requests.filter(request => request.path === "/api/charts/catalog").every(request => JSON.stringify(request.body?.run_ids) === '["run-3"]')).toBe(true);
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  const canvas = await page.locator(".chart-card").first().locator("canvas").elementHandle();
  await page.getByRole("combobox", {name: "Experiment", exact: true}).selectOption("experiment-1");
  await expect(page.locator(".run-row")).toHaveCount(3);
  await expect(page.locator(".selection-count")).toHaveText("1 selected · 1 outside filters");
  await expect(page.locator(".run-chip")).toContainText("ppo · small batch");
  await expect(page.locator(".run-chip")).toContainText("outside filters");
  expect(new URL(page.url()).searchParams.get("runs")).toBe("run-3");
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  const before = requests.length;
  await page.goto("/rvx?project=does-not-exist");
  await expect(page.getByRole("heading", {name: "Select runs", exact: true})).toBeVisible();
  await expect(page.getByRole("combobox", {name: "Project", exact: true})).toHaveValue("does-not-exist");
  expect(new URL(page.url()).searchParams.get("runs")).toBe("");
  expect(requests.slice(before).some(request => request.path === "/api/charts/catalog")).toBe(false);
});

test("old run and comparison paths are gone, with no compatibility navigation", async ({page}) => {
  await mockApi(page);
  for (const path of ["/rvx/runs/run-1", "/rvx/compare?runs=run-1,run-2", "/rvx/unknown"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", {name: "Page not found"})).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path.split("?")[0]);
  }
  await page.getByRole("button", {name: "Open workspace"}).click();
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  await expect(page.getByRole("button", {name: /Compare|Back to runs/i})).toHaveCount(0);
  await expect(page.locator(".run-row a")).toHaveCount(0);
});

test("auth errors stay explicit without token storage or interpreted HTML", async ({page}) => {
  await mockApi(page);
  let sessions = 0;
  await page.route("**/api/auth/session", route => route.fulfill({json: {authenticated: sessions++ === 0, authentication_required: true}}));
  await page.route("**/api/experiments/runs", route => route.fulfill({status: 401, body: "<h1>Private server</h1>"}));
  await page.goto("/rvx");
  await expect(page.getByRole("dialog", {name: "Sign in again", exact: true})).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await expect(page.getByRole("heading", {name: "Private server"})).toHaveCount(0);
});

test("desktop rail and mobile sheet share selection, with early light and dark charts", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1,run-2");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await expect(page.locator(".runs-dock")).toBeVisible();
  await page.screenshot({path: "artifacts/native-desktop-light.png"});
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
  await page.screenshot({path: "artifacts/native-desktop-dark.png"});
  await page.setViewportSize({width: 390, height: 844});
  await expect(page.locator(".runs-dock")).toBeHidden();
  expect((await chart.boundingBox())!.y).toBeLessThan(270);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: "artifacts/native-mobile-dark.png"});
  await page.getByRole("button", {name: "Switch to light appearance"}).click();
  await page.screenshot({path: "artifacts/native-mobile-light.png"});
  await page.getByRole("button", {name: "Select runs (2 selected)"}).click();
  const sheet = page.getByRole("dialog", {name: "Runs", exact: true});
  await expect(sheet.getByRole("checkbox", {name: "Select grpo · baseline"})).toBeChecked();
  expect(await page.locator(".runs-selector").count()).toBe(1);
  await page.screenshot({path: "artifacts/native-mobile-run-sheet.png"});
  await sheet.getByRole("button", {name: "Close", exact: true}).click();
  await page.locator('.run-chip[data-run-id="run-1"]').getByRole("button", {name: /^Run details/}).click();
  await expect(page.getByRole("dialog", {name: "Run details", exact: true})).toBeVisible();
  await page.screenshot({path: "artifacts/native-mobile-run-details.png"});
});

test("320px always-refreshing workspaces and long run labels retain accessible controls", async ({page}) => {
  await mockApi(page);
  const longName = "hostmon-node-with-a-long-unbroken-execution-name-0123456789";
  await page.route("**/api/experiments/runs", route => route.fulfill({json: {runs: runs.map((run, index) => index ? run : {...run, name: longName})}}));
  for (const width of [320, 390, 760]) {
    await page.setViewportSize({width, height: 844});
    await page.goto("/rvx?runs=run-1&live=0");
    await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
    await expect(page.getByRole("button", {name: "Resume live updates"})).toHaveCount(0);
    await expect(page.locator(".chart-card").first().locator(".chart-status")).toBeHidden();
    await expect(page.locator(".chart-card").first().locator(".chart-legend")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.locator(".chart-card").first().boundingBox())!.y).toBeLessThan(270);
    const options = (await page.getByRole("button", {name: "Workspace sets"}).boundingBox())!;
    expect(options.x + options.width).toBeLessThanOrEqual(width);
    if (width === 320) await page.screenshot({path: "artifacts/native-320-paused.png"});
    await page.getByRole("button", {name: "Select runs (1 selected)"}).click();
    await expect(page.getByRole("checkbox", {name: `Select ${longName}`})).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", {name: "Runs", exact: true})).toHaveCount(0);
  }
});
