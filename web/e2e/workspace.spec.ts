import {test, expect} from "@playwright/test";
import {mkdir, writeFile} from "node:fs/promises";
import {exactId, firstObservation, mockApi, selectedObservation, serverState, type FixtureOptions} from "./fixtures";

test("automatic projections use wall bounds and retain exact point identity without raw reads", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1&axis=wall_time&range=3600");
  await expect(page.getByRole("region", {name: "Analysis panels", exact: true})).toBeVisible();
  await expect(page.locator(".chart-card")).toHaveCount(6);
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
  const query = requests.find(request => request.path === "/api/snapshots/query")!.body!;
  expect(query).toMatchObject({axis: "wall_time", to: firstObservation + 179 * 60e9, from: firstObservation + 179 * 60e9 - 3600e9});
  await chart.locator(".chart-host").focus(); await page.keyboard.press("ArrowRight");
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", exactId);
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("nonsecure HTTP creates persistent opaque workspace and panel identities without randomUUID", async ({page}) => {
  await page.addInitScript(() => {Object.defineProperty(crypto, "randomUUID", {value: undefined, configurable: true});});
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".chart-card")).toHaveCount(6);
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("textbox", {name: "Workspace set name"}).fill("HTTP workspace");
  await page.getByRole("button", {name: "Save workspace set"}).click();
  await expect(page.locator(".workspace-save-status")).toHaveText("Saved");
  const saved = (await serverState(page)).workspaces.sets[0]!;
  expect(saved.id).toMatch(/^set-[0-9a-f]{32}$/);
  expect(saved.panels[0].id).toMatch(/^panel-[0-9a-f]{32}$/);
  await page.reload();
  await expect(page.locator(`[data-panel-id="${saved.panels[0].id}"]`)).toHaveCount(1);
});

test("hover and keyboard retain actual stored point IDs rather than synthetic positions", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const box = (await chart.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + box.width * .3, box.y + box.height * .5);
  const selected = selectedObservation(chart);
  await expect(selected).toBeVisible();
  const hoverId = await selected.getAttribute("data-snapshot-id");
  await chart.locator(".chart-host").focus(); await page.keyboard.press("ArrowLeft");
  const id = await selected.getAttribute("data-snapshot-id");
  expect(Number(id)).toBe(Number(hoverId) - 1);
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("hidden pages stop steady polls and logical bounds retain their original integer units", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  await page.evaluate(() => {Object.defineProperty(document, "hidden", {value: true, configurable: true}); document.dispatchEvent(new Event("visibilitychange"));});
  await page.waitForTimeout(200);
  const count = requests.length; await page.waitForTimeout(5500); expect(requests.length).toBe(count);
  await page.evaluate(() => {Object.defineProperty(document, "hidden", {value: false, configurable: true}); document.dispatchEvent(new Event("visibilitychange"));});
  await page.getByRole("combobox", {name: "Time range"}).selectOption("custom");
  await page.getByRole("combobox", {name: "Alignment"}).selectOption("optimizer_step");
  await page.getByRole("textbox", {name: "From (Optimizer step)"}).fill("100");
  await page.getByRole("textbox", {name: "To (Optimizer step)"}).fill("600");
  await page.getByRole("button", {name: "Apply time settings"}).click();
  await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body?.axis).toBe("optimizer_step");
  expect(requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body).toMatchObject({from: 100, to: 600});
});

test("waiting, nonnumeric and failed refresh states remain distinct", async ({page}) => {
  const options: FixtureOptions = {mode: "waiting"};
  await mockApi(page, options);
  await page.goto("/rvx?runs=run-1");
  await expect(page.getByText("Waiting for the first observation")).toBeVisible();
  options.mode = "nonnumeric"; await page.reload();
  await expect(page.getByText("Choose a snapshot view", {exact: true})).toBeVisible();
  delete options.mode; await page.reload();
  const first = page.locator(".chart-card").first();
  await expect(first.locator("canvas")).toBeVisible();
  const canvas = await first.locator("canvas").elementHandle();
  options.failQueries = true;
  await expect(first.getByText("Refresh failed", {exact: true})).toBeVisible({timeout: 9000});
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
});

test("visible-first chart projections stop when the page is hidden", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  const visible = await page.locator(".chart-card").evaluateAll(cards => {
    const root = document.querySelector(".chart-scroll")!.getBoundingClientRect();
    return cards.filter(card => {const box = card.getBoundingClientRect(); return box.bottom > root.top && box.top < root.bottom;})
      .map(card => (card as HTMLElement).dataset.path);
  });
  expect(visible.length).toBeLessThan(6);
  expect(requests.filter(request => request.path === "/api/snapshots/query").every(request => (request.body?.paths as string[]).every(path => visible.includes(path)))).toBe(true);
  await page.evaluate(() => {Object.defineProperty(document, "hidden", {value: true, configurable: true}); document.dispatchEvent(new Event("visibilitychange"));});
  await page.waitForTimeout(200);
  const count = requests.length; await page.waitForTimeout(5500); expect(requests.length).toBe(count);
});

test("six charts and four runs share bounded projections and retain canvases through polling", async ({page}) => {
  await page.setViewportSize({width: 1800, height: 1400});
  const requests = await mockApi(page, {points: 2000});
  await page.goto("/rvx?runs=run-1,run-2,run-3,run-4");
  await expect(page.locator('.chart-card[data-loaded="true"]')).toHaveCount(6);
  const canvases = await page.locator(".chart-card canvas").elementHandles();
  const before = requests.filter(request => request.path === "/api/snapshots/query").length;
  expect(before).toBeGreaterThan(0); expect(before).toBeLessThanOrEqual(2);
  await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").length, {timeout: 9000}).toBeGreaterThan(before);
  for (const canvas of canvases) expect(await canvas.evaluate(node => node.isConnected)).toBe(true);
  expect(requests.filter(request => request.path === "/api/snapshots/query").every(request => Number(request.body?.max_points) <= 2000)).toBe(true);
  await mkdir("artifacts", {recursive: true});
  await writeFile("artifacts/chart-workload.json", JSON.stringify({charts: 6, runs: 4, maxPoints: 1600, initialRequests: before, requests: requests.filter(request => request.path === "/api/snapshots/query").length}, null, 2));
});
