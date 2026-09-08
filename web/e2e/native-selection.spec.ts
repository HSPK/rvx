import {test, expect} from "@playwright/test";
import {mockApi, runs, selectedObservation} from "./fixtures";

test("the run sheet uses singular counts and avoids repeating an identical experiment name", async ({page}) => {
  await mockApi(page);
  await page.route("**/api/experiments/runs", route => route.fulfill({json: {runs: [{...runs[0], name: "GRPO research"}]}}));
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  await page.getByRole("button", {name: "Select runs (1 selected)"}).click();
  const sheet = page.getByRole("dialog", {name: "Runs", exact: true});
  await expect(sheet.locator(".run-count")).toHaveText("1");
  expect(await sheet.locator(".run-count").evaluate(node => getComputedStyle(node, "::after").content)).toBe('" run"');
  await expect(sheet.locator(".run-experiment")).toHaveCount(0);
  await expect(sheet.getByRole("checkbox", {name: "Select GRPO research"})).toBeChecked();
});

for (const value of [.5, 0]) {
  test(`a null Run value cannot steal hover selection from numeric ${value} at the same X`, async ({page}) => {
    const requests = await mockApi(page, {metricValues: {"run-1": {"/progress/loss": index => index === 40 || index === 178 ? null : value}, "run-2": {"/progress/loss": value}}});
    await page.goto("/rvx?runs=run-1,run-2&live=0");
    const chart = page.locator('.chart-card[data-path="/progress/loss"]');
    await expect(chart.locator("canvas")).toBeVisible();
    const selected = selectedObservation(chart);
    await chart.locator(".chart-host").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(selected).toHaveAttribute("data-snapshot-id", "179");
    await expect(selected.locator(".chart-tooltip-value")).toHaveText("null");
    const box = (await chart.locator(".u-over").boundingBox())!;
    await page.mouse.move(box.x + box.width * 40 / 179, box.y + (value === 0 ? box.height - 1 : box.height / 2));
    await expect(selected).toHaveAttribute("data-snapshot-id", "100041");
    await expect(chart.getByRole("tooltip").locator(".is-selected")).toContainText(String(value));
    await expect(chart.getByRole("tooltip").locator(".is-selected")).toContainText("grpo · baseline");
    await page.screenshot({path: `artifacts/native-hover-null-${value === 0 ? "zero" : "numeric"}.png`});
    expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
  });
}

test("hover still selects a real null observation when no numeric candidate exists", async ({page}) => {
  const requests = await mockApi(page, {metricValues: {"run-1": {"/progress/loss": index => index === 40 ? null : .5}}});
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator('.chart-card[data-path="/progress/loss"]');
  await expect(chart.locator("canvas")).toBeVisible();
  const box = (await chart.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + box.width * 40 / 179, box.y + box.height / 2);
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", "41");
  await expect(selectedObservation(chart).locator(".chart-tooltip-value")).toHaveText("null");
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("native 1→2→3→1 selection preserves canvas, zoom, point provenance, metric set, and colors", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const canvas = await chart.locator("canvas").elementHandle();
  const cards = await page.locator(".chart-card").evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.path));
  const overlay = (await chart.locator(".u-over").boundingBox())!;
  await page.mouse.move(overlay.x + 30, overlay.y + 30); await page.mouse.down();
  await page.mouse.move(overlay.x + overlay.width * .7, overlay.y + 30, {steps: 6}); await page.mouse.up();
  await expect(chart.locator(".chart-zoom-state")).toBeVisible();
  await chart.locator(".chart-host").focus(); await page.keyboard.press("ArrowLeft");
  const selected = selectedObservation(chart);
  const pointId = await selected.getAttribute("data-snapshot-id");
  const zoom = await chart.locator(".chart-host").getAttribute("aria-description");
  for (const [name, checked, count] of [
    ["grpo · baseline", true, 2], ["ppo · small batch", true, 3], ["grpo · baseline", false, 2], ["ppo · small batch", false, 1],
  ] as const) {
    if (name === "grpo · baseline" && checked) await page.locator('.run-row[data-run-id="run-2"]').click();
    else await page.getByRole("checkbox", {name: `Select ${name}`}).setChecked(checked);
    await expect(chart.locator(".legend-item")).toHaveCount(count);
    await expect(chart.locator(".chart-status")).toBeHidden();
    expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
    await chart.locator(".chart-host").focus();
    await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowRight");
    await expect(selected).toHaveAttribute("data-snapshot-id", pointId!);
    await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", zoom!);
    await expect(chart.locator(".chart-zoom-state")).toBeVisible();
  }
  expect(new URL(page.url()).pathname).toBe("/rvx");
  expect(new URL(page.url()).searchParams.get("runs")).toBe("run-1");
  expect(new URL(page.url()).searchParams.get("live")).toBeNull();
  expect(await page.locator(".chart-card").evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.path))).toEqual(cards);
  expect(requests.filter(request => request.path === "/api/snapshots/query").every(request => request.body?.axis === "elapsed")).toBe(true);
  const colors = await page.locator('.run-row[data-run-id="run-1"], .run-chip[data-run-id="run-1"], .chart-card .legend-item').evaluateAll(items => items.filter(item => item.textContent?.includes("grpo · warm-start")).map(item => (item as HTMLElement).style.getPropertyValue("--run-color")));
  expect(new Set(colors).size).toBe(1);
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("explicit zero selection makes no chart reads and retains arrangement across 1→0→1", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=&live=0");
  await expect(page.getByRole("heading", {name: "Select runs", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Add", exact: true})).toBeEnabled();
  expect(requests.some(request => request.path === "/api/charts/catalog" || request.path.startsWith("/api/snapshots/"))).toBe(false);
  const run = page.getByRole("checkbox", {name: "Select grpo · warm-start"});
  await run.check();
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await chart.getByLabel("Policy loss chart options").click();
  await chart.getByRole("menuitem", {name: "Make wide"}).click();
  const canvas = await chart.locator("canvas").elementHandle();
  await run.uncheck();
  await expect(page.getByRole("heading", {name: "Select runs", exact: true})).toBeVisible();
  await expect(chart).toBeHidden();
  expect(new URL(page.url()).searchParams.get("runs")).toBe("");
  const requestCount = requests.length;
  await page.waitForTimeout(250);
  expect(requests.length).toBe(requestCount);
  await run.check();
  await expect(chart.locator("canvas")).toBeVisible();
  await expect(chart).toHaveClass(/wide/);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  expect(requests.filter(request => request.path === "/api/charts/catalog" || request.path === "/api/snapshots/query").every(request => (request.body?.run_ids as string[]).length > 0)).toBe(true);
});

test("mobile sheet applies toggles immediately and closes back to the same zoomed chart", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const canvas = await chart.locator("canvas").elementHandle();
  const box = (await chart.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 25); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .75, box.y + 25, {steps: 6}); await page.mouse.up();
  const zoom = await chart.locator(".chart-host").getAttribute("aria-description");
  await page.getByRole("button", {name: "Select runs (1 selected)"}).click();
  const sheet = page.getByRole("dialog", {name: "Runs", exact: true});
  await expect(sheet.getByRole("button", {name: /Apply|Compare/})).toHaveCount(0);
  await sheet.getByRole("checkbox", {name: "Select grpo · baseline"}).check();
  await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body?.run_ids).toEqual(["run-1", "run-2"]);
  expect(new URL(page.url()).searchParams.get("runs")).toBe("run-1,run-2");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(chart.locator(".chart-status")).toBeHidden();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", zoom!);
  await expect(page.getByRole("button", {name: "Select runs (2 selected)"})).toBeFocused();
  await page.getByRole("button", {name: "Select runs (2 selected)"}).click();
  await page.setViewportSize({width: 1440, height: 900});
  await expect(page.getByRole("dialog", {name: "Runs", exact: true})).toHaveCount(0);
  await expect(page.locator(".runs-dock")).toBeVisible();
  await expect(page.getByRole("checkbox", {name: "Select grpo · baseline"})).toBeChecked();
  expect(await page.locator(".runs-selector").count()).toBe(1);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
});

test("browser history restores run, filter, and time query state without rebuilding the chart peer", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&axis=wall_time&range=3600&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const canvas = await chart.locator("canvas").elementHandle();
  await page.getByRole("checkbox", {name: "Select grpo · baseline"}).check();
  await expect(chart.locator(".legend-item")).toHaveCount(2);
  await page.getByRole("combobox", {name: "Experiment", exact: true}).selectOption("experiment-2");
  await expect(page.locator(".selection-count")).toHaveText("2 selected · 2 outside filters");
  await page.goBack();
  await expect(page.getByRole("combobox", {name: "Experiment", exact: true})).toHaveValue("");
  await expect(page.getByRole("checkbox", {name: "Select grpo · baseline"})).toBeChecked();
  await page.goBack();
  await expect(page.getByRole("checkbox", {name: "Select grpo · baseline"})).not.toBeChecked();
  await expect(page.getByRole("combobox", {name: "Time range"})).toHaveValue("3600");
  await expect(page.getByRole("combobox", {name: "Time range", exact: true})).toHaveAttribute("title", "Observation time · Time range");
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await page.goForward();
  await expect(chart.locator(".legend-item")).toHaveCount(2);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
});

test("unknown selections and overlay limits are explicit rather than substituted or truncated", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=does-not-exist");
  await expect(page.getByRole("heading", {name: "Selected runs unavailable"})).toBeVisible();
  await expect(page.locator(".unavailable-run")).toContainText("does-not-exist");
  expect(requests.some(request => request.path === "/api/charts/catalog")).toBe(false);
  await page.getByRole("button", {name: "Remove does-not-exist from selection"}).click();
  await expect(page.getByRole("heading", {name: "Select runs", exact: true})).toBeVisible();
  await page.goto("/rvx?runs=run-1,run-2,run-3,run-4,extra");
  await expect(page.getByRole("heading", {name: "Select up to 4 runs"})).toBeVisible();
  expect(new URL(page.url()).searchParams.get("runs")?.split(",")).toHaveLength(5);
  await page.getByRole("button", {name: "Remove extra from selection"}).click();
  await expect(page.locator(".selection-limit")).toBeVisible();
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  expect(requests.filter(request => request.path === "/api/charts/catalog").every(request => (request.body?.run_ids as string[]).length <= 4)).toBe(true);
});

test("empty runs remain honest and metadata refresh changes labels without destroying charts", async ({page}) => {
  const requests = await mockApi(page, {emptyRuns: ["run-2"]});
  await page.goto("/rvx?runs=run-2");
  await expect(page.getByRole("heading", {name: "Waiting for the first observation"})).toBeVisible();
  expect(requests.some(request => request.path === "/api/snapshots/query")).toBe(false);
  await page.getByRole("checkbox", {name: "Select grpo · warm-start"}).check();
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await expect(chart).toContainText("not recorded");
  const canvas = await chart.locator("canvas").elementHandle();
  await page.route("**/api/experiments/runs", route => route.fulfill({json: {runs: runs.map(run => run.id === "run-1" ? {...run, name: "Updated run label", status: "finished"} : run)}}));
  await page.getByRole("button", {name: "Refresh runs"}).click();
  await expect(page.getByRole("checkbox", {name: "Select Updated run label"})).toBeChecked();
  await expect(chart.locator(".legend-item").filter({hasText: "Updated run label"})).toBeVisible();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  expect(new URL(page.url()).searchParams.get("runs")).toBe("run-2,run-1");
});
