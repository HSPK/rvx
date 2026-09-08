import {test, expect} from "@playwright/test";
import {mockApi, selectedObservation} from "./fixtures";

test("keyboard movement follows visible coordinates rather than hidden duplicate versions", async ({page}) => {
  await mockApi(page, {points: 6, logicalAxes: [0, 0, 1, 1, 2, 2]});
  await page.goto("/rvx?runs=run-1&axis=optimizer_step&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const selected = selectedObservation(chart);
  await chart.locator(".chart-host").focus();
  await page.keyboard.press("ArrowRight");
  await expect(selected).toHaveAttribute("data-snapshot-id", "6");
  for (const [key, id] of [["ArrowLeft", "4"], ["ArrowLeft", "2"], ["ArrowRight", "4"], ["ArrowRight", "6"]]) {
    await page.keyboard.press(key!);
    await expect(selected).toHaveAttribute("data-snapshot-id", id!);
  }
});

test("keyboard users can switch Run traces and read their exact selected observations", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const original = await chart.locator("canvas").elementHandle();
  const url = page.url();
  await chart.locator(".chart-host").focus();
  await page.keyboard.press("ArrowDown");
  const selected = selectedObservation(chart);
  await expect(selected).toHaveAttribute("data-snapshot-id", "100180");
  await expect(chart.locator(".chart-announcement")).toContainText("grpo · baseline");
  await page.keyboard.press("ArrowLeft");
  await expect(selected).toHaveAttribute("data-snapshot-id", "100179");
  expect(page.url()).toBe(url);
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await expect(selected).toContainText("grpo · baseline");
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
  await page.screenshot({path: "artifacts/keyboard-run-observation.png"});
});

test("chart edits preserve keyboard focus on the affected or adjacent control", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const loss = page.locator('.chart-card[data-path="/progress/loss"]');
  await expect(loss.locator("canvas")).toBeVisible();
  const summary = loss.locator(".menu-trigger");
  await summary.click();
  await loss.getByRole("menuitem", {name: "Make wide"}).focus();
  await page.keyboard.press("Enter");
  await expect(summary).toBeFocused();
  await summary.click();
  await page.keyboard.press("Escape");
  const handle = loss.getByRole("button", {name: "Move Policy loss", exact: true});
  await handle.focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(handle).toBeFocused();
  while (await page.locator(".chart-card").count()) {
    const first = page.locator(".chart-card").first();
    await first.locator(".menu-trigger").click();
    await first.getByRole("menuitem", {name: "Remove chart"}).click();
    if (await page.locator(".chart-card").count()) await expect(page.locator(".chart-card").first().locator(".menu-trigger")).toBeFocused();
    else await expect(page.getByRole("button", {name: "Add", exact: true})).toBeVisible();
  }
});

test("metric search stays anchored and supports directional result navigation", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const picker = page.getByRole("dialog", {name: "Add", exact: true});
  const search = picker.getByRole("searchbox", {name: "Search metrics"});
  const y = (await search.boundingBox())!.y;
  await search.fill("/quality/score");
  await expect(picker.locator(".metric-option")).toHaveCount(1);
  expect(Math.abs((await search.boundingBox())!.y - y)).toBeLessThanOrEqual(1);
  await search.fill("");
  await search.press("ArrowDown");
  const firstResult = picker.getByRole("checkbox", {name: "Select metric Mean reward", exact: true});
  await expect(firstResult).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(picker.getByRole("checkbox", {name: "Select metric Policy loss", exact: true})).toBeFocused();
  await page.keyboard.press("Home");
  await expect(firstResult).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(search).toBeFocused();
});

test("browser history closes customizers from the previous Run selection", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const original = await chart.locator("canvas").elementHandle();
  await page.getByRole("checkbox", {name: "Select grpo · baseline"}).check();
  await expect(chart.locator(".legend-item")).toHaveCount(2);
  await page.getByRole("button", {name: "Add", exact: true}).click();
  await page.goBack();
  await expect(page.getByRole("dialog", {name: "Add", exact: true})).toHaveCount(0);
  await expect(chart.locator(".legend-item")).toHaveCount(1);
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
});
