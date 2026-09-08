import {test, expect, type Locator, type Page} from "@playwright/test";
import {mkdir, writeFile} from "node:fs/promises";
import {exactId, firstObservation, mockApi, seedWorkspace, selectedObservation} from "./fixtures";

async function point(page: Page, chart: Locator, x = .5, y = .5) {
  await expect.poll(() => chart.evaluate(node => {
    const host = node.querySelector(".chart-host")!, plot = node.querySelector(".uplot")!;
    return Math.abs(host.clientWidth - plot.clientWidth);
  })).toBeLessThan(1);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const box = (await chart.locator(".u-over").boundingBox())!;
  const pointer = {x: box.x + box.width * x, y: box.y + box.height * y};
  await page.mouse.move(pointer.x, pointer.y);
  await expect(chart.getByRole("tooltip")).toBeVisible();
  return pointer;
}
async function bounded(tooltip: Locator, width: number, height: number) {
  const box = (await tooltip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(7);
  expect(box.y).toBeGreaterThanOrEqual(7);
  expect(box.x + box.width).toBeLessThanOrEqual(width - 7);
  expect(box.y + box.height).toBeLessThanOrEqual(height - 7);
  return box;
}

test("stationary cursor readouts survive live refresh without making the workspace dirty", async ({page}) => {
  const requests = await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1,run-2");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await point(page, chart, .4, .4);
  const before = requests.filter(request => request.path === "/api/snapshots/query").length;
  await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").length, {timeout: 9000}).toBeGreaterThan(before);
  await expect(chart.getByRole("tooltip")).toBeVisible();
  await expect(chart.getByRole("tooltip").locator(".chart-tooltip-row")).toHaveCount(2);
  await expect(page.locator(".workspace-save-status")).toHaveText("Saved");
});

test("late plot size reconciliation keeps an already visible cursor readout", async ({page}) => {
  await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await point(page, chart, .4, .4);
  await chart.locator(".chart-host").evaluate(node => {node.style.height = "280px";});
  await expect.poll(() => chart.locator(".uplot").evaluate(node => node.clientHeight)).toBe(280);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(chart.getByRole("tooltip")).toBeVisible();
  await expect(chart.getByRole("tooltip").locator(".chart-tooltip-row")).toHaveCount(1);
});

test("large combined hover mounts a bounded row window and keeps keyboard-selected evidence visible", async ({page}) => {
  await mockApi(page);
  const ids = ["run-1", "run-2", "run-3", "run-4"];
  const paths = Array.from({length: 12}, (_, index) => `/signal/${index}`);
  await seedWorkspace(page, [{path: paths[0]!, paths, size: "wide", presentation: {title: "Many signals"}}]);
  await page.route("**/api/charts/catalog", route => route.fulfill({json: {
    runs: ids.map(run_id => ({run_id, snapshot_count: 2, first_observed_at_ns: firstObservation, last_observed_at_ns: firstObservation + 1e9})),
    defaults: [], axes: ["elapsed", "wall_time"], truncated: false,
    metrics: paths.map((path, index) => ({path, name: `Signal ${index}`, group: "Training", unit: null, run_ids: ids,
      sources: ids.map(run_id => ({run_id, source_id: `${run_id}-source-0`, label: "Learner", role: "learner", rank: 0, node_id: null,
        primary: true, latest_value: index + 1, observed_at_ns: firstObservation + 1e9}))})),
  }}));
  await page.route("**/api/snapshots/query", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({json: {axis: body.axis, series: ids.flatMap((run_id, run) => paths.map((path, index) => ({
      run_id, source_id: `${run_id}-source-0`, path, snapshot_ids: [1 + index * 10 + run, 501 + index * 10 + run],
      source_session_ids: ["session", "session"], sequences: [0, 1], axes: [0, 1e9],
      observed_at_ns: [firstObservation, firstObservation + 1e9], values: [index + run / 100, index + 1 + run / 100],
    })))}});
  });
  await page.goto(`/rvx?runs=${ids.join(",")}&live=0`);
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await point(page, chart, .5, .2);
  await expect(chart.getByRole("tooltip")).toContainText("48");
  expect(await chart.getByRole("tooltip").locator(".chart-tooltip-row").count()).toBeLessThanOrEqual(12);
  await chart.locator(".chart-host").focus();
  for (let index = 0; index < 15; index++) await page.keyboard.press("ArrowDown");
  const tooltip = chart.getByRole("tooltip"), selected = tooltip.locator(".is-selected");
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute("data-snapshot-id", (await selectedObservation(chart).getAttribute("data-snapshot-id"))!);
  await bounded(tooltip, 1440, 900);
  await page.setViewportSize({width: 844, height: 390});
  await point(page, chart, .5, .2);
  expect(await tooltip.locator(".chart-tooltip-row").count()).toBeLessThanOrEqual(4);
  await bounded(tooltip, 844, 390);
  await page.screenshot({path: "artifacts/chart-surface-bounded-many-traces.png"});
});

test("a default single Run chart uses no persistent value or legend band", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".section-grid .chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await expect(chart.locator(".chart-legend")).toBeHidden();
  const geometry = await chart.evaluate(node => {
    const card = node.getBoundingClientRect(), plot = node.querySelector(".u-over")!.getBoundingClientRect();
    return {cardHeight: card.height, cardWidth: card.width, plotHeight: plot.height, plotWidth: plot.width,
      plotHeightRatio: plot.height / card.height, plotAreaRatio: plot.width * plot.height / (card.width * card.height)};
  });
  expect(geometry.plotHeightRatio).toBeGreaterThan(.72);
  await mkdir("artifacts", {recursive: true});
  await writeFile("artifacts/chart-surface-single-geometry.json", JSON.stringify(geometry, null, 2));
  await page.screenshot({path: "artifacts/chart-surface-single-run.png"});
});

test("compact surfaces give space to the plot and four independent Run rows follow the cursor", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1,run-2,run-3,run-4&live=0");
  const chart = page.locator(".section-grid .chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await expect(chart.locator(".chart-footer,.point-readout,.panel-expand")).toHaveCount(0);
  const geometry = await chart.evaluate(node => {
    const rect = node.getBoundingClientRect(), plot = node.querySelector(".u-over")!.getBoundingClientRect();
    const heading = node.querySelector("h2")!.getBoundingClientRect(), handle = node.querySelector(".panel-drag-handle")!.getBoundingClientRect();
    return {card: {width: rect.width, height: rect.height}, plot: {width: plot.width, height: plot.height}, heightRatio: plot.height / rect.height,
      plotAreaRatio: plot.width * plot.height / (rect.width * rect.height), titleCenterOffset: heading.left + heading.width / 2 - rect.left - rect.width / 2, titleHandleWidth: handle.width,
      padding: getComputedStyle(node).padding, radius: getComputedStyle(node).borderRadius};
  });
  expect(geometry.heightRatio).toBeGreaterThan(.64);
  expect(Math.abs(geometry.titleCenterOffset)).toBeLessThan(2);
  await mkdir("artifacts", {recursive: true});
  await page.screenshot({path: "artifacts/chart-surface-default.png"});
  const pointer = await point(page, chart, .4, .4);
  const tooltip = chart.getByRole("tooltip");
  await expect(tooltip.locator(".chart-tooltip-row")).toHaveCount(4);
  await expect(tooltip.locator(".is-selected")).toHaveCount(1);
  const before = await bounded(tooltip, 1440, 900);
  const times = await tooltip.locator(".chart-tooltip-time").allTextContents();
  await expect(tooltip).not.toContainText("Nearest recorded observations");
  await page.screenshot({path: "artifacts/chart-surface-four-runs.png"});
  await tooltip.evaluate(node => {
    (window as unknown as {hoverMutations: number}).hoverMutations = 0;
    new MutationObserver(changes => {(window as unknown as {hoverMutations: number}).hoverMutations += changes.length;})
      .observe(node, {subtree: true, childList: true, characterData: true});
  });
  await page.mouse.move(pointer.x, pointer.y + 25);
  const after = await tooltip.boundingBox();
  expect(Math.abs(after!.y - before.y)).toBeGreaterThan(15);
  expect(await page.evaluate(() => (window as unknown as {hoverMutations: number}).hoverMutations)).toBe(0);
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
  await writeFile("artifacts/chart-surface-geometry.json", JSON.stringify({geometry, tooltip: before, actualTraceTimes: times}, null, 2));
});

test("mouseout retains point identity and fullscreen readouts need no raw snapshot inspector", async ({page}) => {
  const requests = await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await point(page, chart, .999, .05);
  const id = await selectedObservation(chart).getAttribute("data-snapshot-id");
  await page.screenshot({path: "artifacts/chart-surface-two-runs.png"});
  await chart.locator(".menu-trigger").click();
  await expect(chart.getByRole("tooltip")).toBeHidden();
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", id!);
  await expect(chart.getByRole("menuitem", {name: /Inspect/, includeHidden: true})).toHaveCount(0);
  await page.screenshot({path: "artifacts/chart-surface-selected-options.png"});
  await chart.getByRole("menuitem", {name: "Fullscreen", exact: true}).click();
  const fullscreen = page.getByRole("dialog", {name: "Policy loss", exact: true});
  const expanded = fullscreen.locator(".chart-card");
  await expect(expanded.locator(".panel-drag-handle")).toBeDisabled();
  await point(page, expanded, .999, .98);
  const bounds = await bounded(expanded.getByRole("tooltip"), 1440, 900);
  await writeFile("artifacts/chart-surface-fullscreen-geometry.json", JSON.stringify(bounds, null, 2));
  await page.screenshot({path: "artifacts/chart-surface-fullscreen-edge.png"});
  await expanded.locator(".chart-host").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await expect(selectedObservation(expanded)).toHaveAttribute("data-snapshot-id", exactId);
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("hover distinguishes real nulls and absent Runs without giving nulls numeric selection priority", async ({page}) => {
  await mockApi(page, {emptyRuns: ["run-3"], metricValues: {
    "run-1": {"/progress/loss": index => index === 40 ? null : .5},
    "run-2": {"/progress/loss": 0},
  }});
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1,run-2,run-3&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await point(page, chart, 40 / 179, .98);
  const rows = chart.getByRole("tooltip").locator(".chart-tooltip-row");
  await expect(rows.nth(0).locator(".chart-tooltip-value")).toHaveText("null");
  await expect(rows.nth(0)).toHaveAttribute("data-snapshot-id", "41");
  await expect(rows.nth(1).locator(".chart-tooltip-value")).toHaveText("0");
  await expect(rows.nth(1)).toHaveClass(/is-selected/);
  await expect(rows.nth(2)).toContainText("not recorded");
  await expect(rows.nth(2)).not.toHaveAttribute("data-snapshot-id");
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", "100041");
  await page.screenshot({path: "artifacts/chart-surface-null-missing.png"});
  await page.mouse.move(10, 10);
  await expect(chart.getByRole("tooltip")).toBeHidden();
  await chart.locator(".menu-trigger").click();
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", "100041");
});

test("duplicate coordinates and keyboard navigation read only the actually rendered observation IDs", async ({page}) => {
  await mockApi(page, {points: 6, logicalAxes: [0, 0, 1, 1, 2, 2]});
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1&axis=optimizer_step&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await point(page, chart, .5);
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", "4");
  await expect(chart.getByRole("tooltip").locator(".is-selected")).toHaveAttribute("data-snapshot-id", "4");
  await page.screenshot({path: "artifacts/chart-surface-duplicate-coordinate.png"});
  await chart.locator(".chart-host").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(chart.getByRole("tooltip").locator(".is-selected")).toHaveAttribute("data-snapshot-id", "2");
  await expect(chart.locator(".chart-announcement")).toContainText("Optimizer step · 0");
  await page.keyboard.press("ArrowRight");
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", "4");
});

test("dark narrow and tablet plots keep the title readable and edge tooltip bounded", async ({page}) => {
  await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal", presentation: {title: "A readable complete title without a left grip gutter"}}]);
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
  const measurements = [];
  for (const width of [390, 844]) {
    await page.setViewportSize({width, height: 844});
    const chart = page.locator(".chart-card").first();
    await expect(chart.locator("canvas")).toBeVisible();
    const handle = chart.locator(".panel-drag-handle");
    expect(await handle.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await point(page, chart, .98, .98);
    const tooltip = await bounded(chart.getByRole("tooltip"), width, 844);
    measurements.push({width, tooltip, card: await chart.boundingBox(), plot: await chart.locator(".u-over").boundingBox()});
    await page.screenshot({path: `artifacts/chart-surface-dark-${width}.png`});
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({path: `artifacts/chart-surface-title-drag-${width}.png`});
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(handle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".is-dragging")).toHaveCount(0);
  }
  await writeFile("artifacts/chart-surface-dark-geometry.json", JSON.stringify(measurements, null, 2));
});

test("scope, range, visibility and removal dismiss stale hover without requesting full snapshots", async ({page}) => {
  const requests = await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await point(page, chart);
  await page.getByRole("checkbox", {name: "Select grpo · baseline"}).uncheck();
  await expect(chart.getByRole("tooltip")).toBeHidden();
  await expect(chart.locator(".chart-status")).toBeHidden();
  await point(page, chart);
  await page.getByRole("combobox", {name: "Time range"}).selectOption("3600");
  await expect(chart.getByRole("tooltip")).toBeHidden();
  await expect(chart.locator(".chart-status")).toBeHidden();
  await point(page, chart);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {value: true, configurable: true});
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(chart.getByRole("tooltip")).toBeHidden();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {value: false, configurable: true});
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await point(page, chart);
  await chart.locator(".menu-trigger").click();
  await expect(chart.getByRole("tooltip")).toBeHidden();
  await chart.getByRole("menuitem", {name: "Remove chart"}).click();
  await expect(page.locator(".chart-tooltip")).toHaveCount(0);
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("compact axes reserve the actual width of long scientific labels", async ({page}) => {
  await mockApi(page, {points: 6, metricValues: {"run-1": {"/progress/loss": -1e-12}}});
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card");
  await expect(chart.locator("canvas")).toBeVisible();
  const axes = await chart.evaluate(node => {
    const plot = node.querySelector(".u-over")!.getBoundingClientRect(), host = node.querySelector(".chart-host")!.getBoundingClientRect();
    const ctx = node.querySelector("canvas")!.getContext("2d")!;
    ctx.save(); ctx.font = "11px system-ui, sans-serif";
    const labelWidth = ctx.measureText("-1.00e-12").width;
    ctx.restore();
    return {leftAxis: plot.left - host.left, labelWidth, plotWidth: plot.width};
  });
  expect(axes.leftAxis).toBeGreaterThan(axes.labelWidth + 6);
  expect(axes.plotWidth).toBeGreaterThan(230);
  await page.screenshot({path: "artifacts/chart-surface-scientific-axis.png"});
});

test("title pointer and keyboard placement cancel without moving panels or replacing their canvases", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const cards = page.locator(".section-grid .chart-card"), first = cards.first();
  await expect(first.locator("canvas")).toBeVisible();
  const order = await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.panelId));
  const canvas = await first.locator("canvas").elementHandle(), handle = first.locator(".panel-drag-handle");
  const start = (await handle.boundingBox())!, target = (await cards.nth(1).boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width - 30, target.y + 30, {steps: 5});
  await expect(first).toHaveClass(/is-dragging/);
  await page.screenshot({path: "artifacts/chart-surface-title-placement.png"});
  await page.keyboard.press("Escape"); await page.mouse.up();
  expect(await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.panelId))).toEqual(order);
  await handle.focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowDown");
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  expect(await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.panelId))).toEqual(order);
  await expect(page.locator(".is-dragging,.drop-before,.drop-after")).toHaveCount(0);
  await expect(handle).toBeFocused();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await page.screenshot({path: "artifacts/chart-surface-title-canceled.png"});
});

test("shorter Run coverage never carries an endpoint forward or steals cursor selection", async ({page}) => {
  await mockApi(page, {points: 6});
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.route("**/api/snapshots/query", route => {
    const request = route.request().postDataJSON();
    return route.fulfill({json: {axis: request.axis, series: request.run_ids.map((runId: string) => {
      const short = runId === "run-1", count = short ? 3 : 6;
      return {run_id: runId, source_id: `${runId}-source-0`, path: "/progress/loss",
        axes: Array.from({length: count}, (_, index) => index * 60e9),
        values: Array.from({length: count}, () => short ? 0 : 1),
        snapshot_ids: Array.from({length: count}, (_, index) => (short ? 0 : 100000) + index + 1),
        sequences: Array.from({length: count}, (_, index) => index),
        observed_at_ns: Array.from({length: count}, (_, index) => firstObservation + index * 60e9),
        source_session_ids: Array.from({length: count}, () => `${runId}-source-0-session`)};
    })}});
  });
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await point(page, chart, .49, .98);
  const rows = chart.getByRole("tooltip").locator(".chart-tooltip-row");
  await expect(rows.first()).toContainText("outside span");
  await expect(rows.first()).not.toHaveAttribute("data-snapshot-id");
  await expect(rows.nth(1)).toHaveClass(/is-selected/);
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", "100003");
  await page.screenshot({path: "artifacts/chart-surface-unequal-coverage.png"});
  await chart.locator(".menu-trigger").click();
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", "100003");
});

test("a numeric trace clipped by explicit Y bounds cannot steal a visible null observation", async ({page}) => {
  await mockApi(page, {metricValues: {
    "run-1": {"/progress/loss": -5},
    "run-2": {"/progress/loss": index => index === 40 ? null : 5},
  }});
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal", presentation: {yMin: 0, yMax: 10}}]);
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await point(page, chart, 40 / 179, .98);
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", "100041");
  await expect(chart.getByRole("tooltip").locator(".is-selected .chart-tooltip-value")).toHaveText("null");
});
