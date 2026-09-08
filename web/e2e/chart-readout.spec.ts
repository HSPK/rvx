import {test, expect, type Locator, type Page} from "@playwright/test";
import {mkdir, writeFile} from "node:fs/promises";
import {exactId, firstObservation, mockApi, seedWorkspace, seedUiState} from "./fixtures";

interface TextPaint {text: string; left: number; right: number; top: number; bottom: number; y: number}
declare global {interface Window {chartReadoutPaint: (canvas: HTMLCanvasElement) => TextPaint[]}}

async function recordText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const paints = new WeakMap<HTMLCanvasElement, TextPaint[]>();
    const clear = CanvasRenderingContext2D.prototype.clearRect, fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.clearRect = function(x, y, width, height) {
      if (x <= 0 && y <= 0 && width >= this.canvas.width && height >= this.canvas.height) paints.set(this.canvas, []);
      clear.call(this, x, y, width, height);
    };
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
      const metrics = this.measureText(text), transform = this.getTransform();
      const a = new DOMPoint(x - metrics.actualBoundingBoxLeft, y - metrics.actualBoundingBoxAscent).matrixTransform(transform);
      const b = new DOMPoint(x + metrics.actualBoundingBoxRight, y + metrics.actualBoundingBoxDescent).matrixTransform(transform);
      const entries = paints.get(this.canvas) ?? [];
      entries.push({text, left: a.x, right: b.x, top: a.y, bottom: b.y, y});
      paints.set(this.canvas, entries);
      if (maxWidth === undefined) fill.call(this, text, x, y); else fill.call(this, text, x, y, maxWidth);
    };
    window.chartReadoutPaint = canvas => paints.get(canvas) ?? [];
  });
}

async function settled(chart: Locator): Promise<void> {
  await expect(chart.locator("canvas")).toBeVisible();
  await chart.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function hover(page: Page, chart: Locator, x = .5, y = .5): Promise<void> {
  await settled(chart);
  const box = (await chart.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
  await expect(chart.getByRole("tooltip")).toBeVisible();
}

async function centered(chart: Locator) {
  const geometry = await chart.evaluate(node => {
    const card = node.getBoundingClientRect(), heading = node.querySelector<HTMLElement>(".metric-heading")!;
    const title = heading.querySelector("h2")!, unit = heading.querySelector(".metric-unit")!;
    const range = document.createRange(); range.selectNodeContents(title);
    const text = range.getBoundingClientRect();
    const parts = [text];
    if (unit.textContent) {range.selectNodeContents(unit); parts.push(range.getBoundingClientRect());}
    const left = Math.min(...parts.map(part => part.left)), right = Math.max(...parts.map(part => part.right));
    const action = node.querySelector(".menu-trigger")?.getBoundingClientRect(), bounds = heading.getBoundingClientRect();
    const states = [...node.querySelectorAll<HTMLElement>(".panel-indicators > :not([hidden])")].map(state => state.getBoundingClientRect());
    return {centerOffset: (left + right - card.left - card.right) / 2, textWidth: right - left, cardWidth: card.width,
      headingRight: bounds.right, headingBottom: bounds.bottom, actionLeft: action?.left,
      stateTop: states.length ? Math.min(...states.map(state => state.top)) : null,
      titleFits: title.scrollWidth <= title.clientWidth};
  });
  expect(Math.abs(geometry.centerOffset)).toBeLessThanOrEqual(1);
  expect(geometry.titleFits).toBe(true);
  if (geometry.actionLeft !== undefined) expect(geometry.headingRight).toBeLessThanOrEqual(geometry.actionLeft);
  if (geometry.stateTop !== null) expect(geometry.stateTop).toBeGreaterThanOrEqual(geometry.headingBottom);
  return geometry;
}

async function bounded(tooltip: Locator, width: number, height: number): Promise<void> {
  const box = (await tooltip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(7);
  expect(box.y).toBeGreaterThanOrEqual(7);
  expect(box.x + box.width).toBeLessThanOrEqual(width - 7);
  expect(box.y + box.height).toBeLessThanOrEqual(height - 7);
  expect(await tooltip.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
}

test.use({timezoneId: "UTC"});

for (const width of [1440, 390]) for (const scenario of [
  {name: "hours", from: Date.UTC(2026, 8, 5, 8), points: 180},
  {name: "day-boundary", from: Date.UTC(2026, 8, 4, 23), points: 180},
  {name: "year-boundary", from: Date.UTC(2026, 11, 31, 23), points: 180},
  {name: "dates", from: Date.UTC(2026, 11, 28), points: 8 * 1440 + 1},
]) {
  test(`wall-time ${scenario.name} text is fully painted at ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 900});
    await recordText(page);
    await mockApi(page, {points: scenario.points, observationOrigins: {"run-1": scenario.from * 1e6}});
    await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
    await page.goto("/rvx?runs=run-1&axis=wall_time&live=0");
    const chart = page.locator(".section-grid .chart-card");
    await settled(chart);
    const paint = await chart.evaluate(node => {
      const canvas = node.querySelector("canvas")!, plot = node.querySelector(".u-over")!.getBoundingClientRect();
      const box = canvas.getBoundingClientRect(), ratio = canvas.height / box.height;
      const labels = window.chartReadoutPaint(canvas).filter(label => label.top >= (plot.bottom - box.top) * ratio);
      return {labels, canvas: {width: canvas.width, height: canvas.height}, plotHeight: plot.height,
        cardHeight: node.getBoundingClientRect().height, hostHeight: box.height,
        maxBottom: Math.max(...labels.map(label => label.bottom)), minLeft: Math.min(...labels.map(label => label.left)),
        maxRight: Math.max(...labels.map(label => label.right)), rows: new Set(labels.map(label => label.y)).size};
    });
    await mkdir("artifacts", {recursive: true});
    await page.screenshot({path: `artifacts/chart-readout-${scenario.name}-${width}.png`});
    await writeFile(`artifacts/chart-readout-${scenario.name}-${width}.json`, JSON.stringify(paint, null, 2));
    expect(paint.labels.length).toBeGreaterThan(2);
    expect(paint.rows).toBeGreaterThanOrEqual(2);
    expect(paint.maxBottom).toBeLessThanOrEqual(paint.canvas.height - 2);
    expect(paint.minLeft).toBeGreaterThanOrEqual(0);
    expect(paint.maxRight).toBeLessThanOrEqual(paint.canvas.width);
    expect(paint.plotHeight).toBeGreaterThanOrEqual(width === 390 ? 200 : 208);
  });
}

for (const width of [1440, 390]) test(`titles, units and wrapping stay card-centered through loading, zoom and fullscreen at ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height: 900});
  await mockApi(page);
  await seedWorkspace(page, [
    {path: "/progress/loss", size: "normal"},
    {path: "/resources/gpu_utilization", size: "normal", presentation: {title: "A long complete GPU utilization title that wraps without shifting its unit or options"}},
    {path: "/absent/metric", size: "normal", presentation: {title: "A field not recorded in this scope"}},
  ]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/snapshots/query", async route => {await gate; await route.fallback();});
  try {
    await page.goto("/rvx?runs=run-1&live=0");
    const cards = page.locator(".section-grid .chart-card"), first = cards.first();
    await expect(first.locator(".chart-status")).toBeVisible();
    const loading = await centered(first);
    release();
    await settled(first);
    if (width === 390) await page.getByRole("button", {name: "Switch to dark appearance"}).click();
    const measurements = [];
    for (const card of await cards.all()) {
      await card.scrollIntoViewIfNeeded();
      measurements.push(await centered(card));
    }
    await page.screenshot({path: `artifacts/chart-readout-centered-titles-${width}.png`});
    await first.scrollIntoViewIfNeeded();
    const canvas = await first.locator("canvas").elementHandle(), order = await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.panelId));
    const handle = first.locator(".panel-drag-handle");
    await handle.focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape");
    expect(await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.panelId))).toEqual(order);
    const box = (await first.locator(".u-over").boundingBox())!;
    await page.mouse.move(box.x + 12, box.y + 25); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .7, box.y + 25, {steps: 5}); await page.mouse.up();
    await expect(first.locator(".chart-zoom-state")).toBeVisible();
    const zoomed = await centered(first);
    await first.locator(".menu-trigger").click();
    await expect(first.getByRole("menuitem", {name: /Inspect/i})).toHaveCount(0);
    await expect(first.getByRole("menuitem", {name: "Reset zoom"})).toBeVisible();
    await first.getByRole("menuitem", {name: "Fullscreen", exact: true}).click();
    const expanded = page.getByRole("dialog", {name: "Policy loss", exact: true}).locator(".chart-card");
    await settled(expanded);
    const fullscreen = await centered(expanded);
    await expect(expanded.locator(".panel-drag-handle")).toBeDisabled();
    await hover(page, expanded, .95, .95);
    await bounded(expanded.getByRole("tooltip"), width, 900);
    await page.screenshot({path: `artifacts/chart-readout-centered-fullscreen-${width}.png`});
    expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
    await writeFile(`artifacts/chart-readout-centering-${width}.json`, JSON.stringify({loading, measurements, zoomed, fullscreen}, null, 2));
  } finally {release();}
});

test("a shared table title stays centered with loading status and the options anchor", async ({page}) => {
  await mockApi(page, {tableRows: 3});
  await seedUiState(page, {
    theme: "light", selected: {"experiment-1": "table-test"},
    sets: [{id: "table-test", name: "Table", experimentId: "experiment-1", sections: [{id: "initial", name: "", collapsed: false}],
      panels: [{id: "table-panel", kind: "snapshot-table", sectionId: "initial", path: "/tasks", size: "wide", title: "Recorded task state"}]}],
  });
  await page.goto("/rvx?runs=run-1&live=0");
  const table = page.locator(".table-card");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await centered(table);
  await table.locator(".menu-trigger").click();
  await expect(table.getByRole("menuitem", {name: "Fullscreen"})).toBeVisible();
  await page.screenshot({path: "artifacts/chart-readout-centered-table.png"});
});

test("aligned values use one compact coordinate header and no Inspect feature or raw reads", async ({page}) => {
  const requests = await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1,run-2,run-3,run-4&live=0");
  const chart = page.locator(".chart-card");
  await settled(chart);
  await chart.locator(".chart-host").focus(); await page.keyboard.press("ArrowRight");
  const tooltip = chart.getByRole("tooltip");
  await expect(tooltip.locator(".is-selected")).toHaveAttribute("data-snapshot-id", exactId);
  await expect(tooltip.locator(".chart-tooltip-heading")).toHaveText("Elapsed · 2h 59m");
  await expect(tooltip.locator(".chart-tooltip-row")).toHaveCount(4);
  expect(await tooltip.locator(".chart-tooltip-time").allTextContents()).toEqual(["", "", "", ""]);
  expect((await tooltip.textContent())!.length).toBeLessThan(160);
  await page.screenshot({path: "artifacts/chart-readout-compact-four-runs.png"});
  await hover(page, chart, .4, .4);
  await tooltip.evaluate(node => {
    node.dataset.textMutations = "0";
    new MutationObserver(records => {node.dataset.textMutations = String(Number(node.dataset.textMutations) + records.length);})
      .observe(node, {subtree: true, childList: true, characterData: true});
  });
  const box = (await chart.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + box.width * .4, box.y + box.height * .4 + 10);
  await expect(tooltip).toHaveAttribute("data-text-mutations", "0");
  await chart.locator(".menu-trigger").click();
  await expect(chart.getByRole("menuitem", {name: /Inspect/i, includeHidden: true})).toHaveCount(0);
  await expect(chart).not.toContainText(/Inspect|Nearest recorded observations/);
  await expect(chart.locator(".chart-host")).not.toHaveAttribute("aria-label", /Inspect/i);
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

for (const axis of ["elapsed", "wall_time"]) test(`asynchronous ${axis} rows annotate only differing coordinates and retain null and coverage truth`, async ({page}) => {
  const requests = await mockApi(page, {emptyRuns: ["run-4"], points: 6});
  await seedWorkspace(page, [{path: "/progress/loss", size: "wide"}]);
  await page.route("**/api/snapshots/query", route => route.fulfill({json: {axis, series: ["run-1", "run-2", "run-3"].map((runId, run) => {
    const count = run === 2 ? 3 : 6, seconds = Array.from({length: count}, (_, index) => index * 60 + (run === 1 ? 5 : 0));
    return {run_id: runId, source_id: `${runId}-source-0`, path: "/progress/loss",
      axes: seconds.map(value => value * 1e9 + (axis === "wall_time" ? firstObservation : 0)),
      observed_at_ns: seconds.map(value => firstObservation + value * 1e9),
      values: seconds.map((_, index) => run === 0 && index === 2 ? null : run),
      snapshot_ids: seconds.map((_, index) => run * 100000 + index + 1),
      sequences: seconds.map((_, index) => index), source_session_ids: seconds.map(() => "session")};
  })}}));
  await page.goto(`/rvx?runs=run-1,run-2,run-3,run-4&axis=${axis}&live=0`);
  const chart = page.locator(".chart-card");
  await hover(page, chart, 125 / 305, .5);
  const tooltip = chart.getByRole("tooltip"), rows = tooltip.locator(".chart-tooltip-row");
  await expect(rows.nth(0).locator(".chart-tooltip-value")).toHaveText("null");
  await expect(rows.nth(0)).toHaveAttribute("data-snapshot-id", "3");
  await expect(rows.nth(0).locator(".chart-tooltip-time")).toHaveText(axis === "elapsed" ? "at 2m" : "at 08:02:00");
  await expect(rows.nth(1)).toHaveClass(/is-selected/);
  await expect(rows.nth(1)).toHaveAttribute("data-snapshot-id", "100003");
  await expect(rows.nth(1).locator(".chart-tooltip-time")).toBeHidden();
  await expect(rows.nth(2).locator(".chart-tooltip-value")).toHaveText("outside span");
  await expect(rows.nth(2)).not.toHaveAttribute("data-snapshot-id");
  await expect(rows.nth(3).locator(".chart-tooltip-value")).toHaveText("not recorded");
  await expect(tooltip).not.toContainText("Nearest");
  await page.screenshot({path: `artifacts/chart-readout-asynchronous-${axis}.png`});
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("duplicate coordinates keep the last actual snapshot when navigating compact rows", async ({page}) => {
  const requests = await mockApi(page, {points: 6, logicalAxes: [0, 0, 1, 1, 2, 2]});
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1&axis=optimizer_step&live=0");
  const chart = page.locator(".chart-card");
  await hover(page, chart);
  await expect(chart.getByRole("tooltip").locator(".is-selected")).toHaveAttribute("data-snapshot-id", "4");
  await chart.locator(".chart-host").focus(); await page.keyboard.press("ArrowLeft");
  await expect(chart.getByRole("tooltip").locator(".is-selected")).toHaveAttribute("data-snapshot-id", "2");
  await expect(chart.getByRole("tooltip").locator(".chart-tooltip-heading")).toHaveText("Optimizer step · 0");
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("different sub-millisecond coordinates do not look like a simultaneous wall-time sample", async ({page}) => {
  await mockApi(page, {points: 3});
  await seedWorkspace(page, [{path: "/progress/loss", size: "wide"}]);
  await page.route("**/api/snapshots/query", route => route.fulfill({json: {axis: "wall_time",
    series: ["run-1", "run-2"].map((run_id, run) => {
      const axes = [0, 1e9, 2e9].map(value => firstObservation + value + run * 256);
      return {run_id, source_id: `${run_id}-source-0`, path: "/progress/loss", axes, observed_at_ns: axes,
        values: [run + 1, run + 1, run + 1], snapshot_ids: [1, 2, 3].map(id => id + run * 100),
        sequences: [0, 1, 2], source_session_ids: ["session", "session", "session"]};
    }),
  }}));
  await page.goto("/rvx?runs=run-1,run-2&axis=wall_time&live=0");
  const chart = page.locator(".chart-card");
  await hover(page, chart, .5, .1);
  const rows = chart.getByRole("tooltip").locator(".chart-tooltip-row");
  await expect(rows.nth(1)).toHaveClass(/is-selected/);
  await expect(rows.nth(0).locator(".chart-tooltip-time")).toHaveText("−256ns");
  await expect(rows.nth(1).locator(".chart-tooltip-time")).toBeHidden();
});

test("stationary readouts update live values and survive both host and viewport resizing", async ({page}) => {
  let offset = 0;
  const requests = await mockApi(page, {metricValues: {"run-1": {"/progress/loss": index => index + offset}}});
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1");
  const chart = page.locator(".chart-card");
  await hover(page, chart, .4, .4);
  const tooltip = chart.getByRole("tooltip"), value = tooltip.locator(".chart-tooltip-value");
  const id = await tooltip.locator(".is-selected").getAttribute("data-snapshot-id"), initial = Number(await value.textContent());
  offset = 100;
  await expect(value).toHaveText(String(initial + 100), {timeout: 9000});
  await expect(tooltip.locator(".is-selected")).toHaveAttribute("data-snapshot-id", id!);
  await chart.locator(".chart-host").evaluate(node => {node.style.height = "280px";});
  await expect.poll(() => chart.locator(".uplot").evaluate(node => node.clientHeight)).toBe(280);
  await expect(tooltip).toBeVisible();
  await page.setViewportSize({width: 1360, height: 840});
  await settled(chart);
  await expect(tooltip).toBeVisible();
  await bounded(tooltip, 1360, 840);
  await page.screenshot({path: "artifacts/chart-readout-stationary-resized.png"});
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("the 12-row window stays bounded and keyboard-selected traces remain visible on short screens", async ({page}) => {
  const requests = await mockApi(page), ids = ["run-1", "run-2", "run-3", "run-4"];
  const paths = Array.from({length: 12}, (_, index) => `/signal/${index}`);
  await seedWorkspace(page, [{path: paths[0]!, paths, size: "wide", presentation: {title: "Multiple recorded signals"}}]);
  await page.route("**/api/charts/catalog", route => route.fulfill({json: {
    runs: ids.map(run_id => ({run_id, snapshot_count: 2, first_observed_at_ns: firstObservation, last_observed_at_ns: firstObservation + 1e9})),
    defaults: [], axes: ["elapsed", "wall_time"], truncated: false,
    metrics: paths.map((path, index) => ({path, name: `Signal ${index}`, group: "Training", unit: "units", run_ids: ids,
      sources: ids.map(run_id => ({run_id, source_id: `${run_id}-source-0`, label: "Learner", role: "learner", rank: 0, node_id: null,
        primary: true, latest_value: index + 1, observed_at_ns: firstObservation + 1e9}))})),
  }}));
  await page.route("**/api/snapshots/query", route => route.fulfill({json: {axis: "elapsed",
    series: ids.flatMap((run_id, run) => paths.map((path, index) => ({
      run_id, source_id: `${run_id}-source-0`, path, snapshot_ids: [1 + index * 10 + run, 501 + index * 10 + run],
      source_session_ids: ["session", "session"], sequences: [0, 1], axes: [0, 1e9],
      observed_at_ns: [firstObservation, firstObservation + 1e9], values: [index + run / 100, index + 1 + run / 100],
    }))),
  }}));
  await page.goto(`/rvx?runs=${ids.join(",")}&live=0`);
  const chart = page.locator(".chart-card");
  await hover(page, chart, .5, .5);
  const tooltip = chart.getByRole("tooltip");
  await expect(tooltip.locator(".chart-tooltip-count")).toContainText("/48");
  expect(await tooltip.locator(".chart-tooltip-row").count()).toBeLessThanOrEqual(12);
  await chart.locator(".chart-host").focus();
  for (let index = 0; index < 15; index++) await page.keyboard.press("ArrowDown");
  const selectedId = await tooltip.locator(".is-selected").getAttribute("data-snapshot-id");
  await bounded(tooltip, 1440, 900);
  await page.screenshot({path: "artifacts/chart-readout-window-desktop.png"});
  await page.setViewportSize({width: 844, height: 390});
  await settled(chart);
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator(".is-selected")).toHaveAttribute("data-snapshot-id", selectedId!);
  expect(await tooltip.locator(".chart-tooltip-row").count()).toBeLessThanOrEqual(4);
  await bounded(tooltip, 844, 390);
  await page.screenshot({path: "artifacts/chart-readout-window-short.png"});
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("touch keeps a compact tapped readout without stealing vertical scrolling", async ({browser}) => {
  const context = await browser.newContext({baseURL: test.info().project.use.baseURL, viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  const page = await context.newPage();
  try {
    const requests = await mockApi(page);
    await page.goto("/rvx?runs=run-1&live=0");
    const chart = page.locator(".chart-card").first();
    await settled(chart);
    const box = (await chart.locator(".u-over").boundingBox())!;
    await chart.locator(".u-over").tap({position: {x: box.width * .25, y: box.height * .5}});
    await expect(chart.getByRole("tooltip")).toBeVisible();
    await expect(chart.getByRole("tooltip").locator(".is-selected")).toHaveAttribute("data-snapshot-id", /^\d+$/);
    await bounded(chart.getByRole("tooltip"), 390, 844);
    await page.screenshot({path: "artifacts/chart-readout-touch.png"});
    const session = await context.newCDPSession(page), x = box.x + box.width / 2, y = box.y + box.height * .8;
    await session.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y}]});
    for (let step = 1; step <= 5; step++) await session.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x, y: y - step * 30}]});
    await session.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
    await expect.poll(() => page.locator(".chart-scroll").evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect(chart.getByRole("tooltip")).toBeHidden();
    await expect(chart.locator(".chart-zoom-state")).toBeHidden();
    expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
    await session.detach();
  } finally {await context.close();}
});

test("native previews retain centered headings and complete date text above a compact top-layer readout", async ({page}) => {
  await recordText(page);
  const requests = await mockApi(page, {observationOrigins: {"run-1": Date.UTC(2026, 11, 31, 23) * 1e6}});
  await seedWorkspace(page, [{path: "/resources/gpu_utilization", size: "normal"}]);
  await page.goto("/rvx?runs=run-1&axis=wall_time&live=0");
  const chart = page.locator(".section-grid .chart-card");
  await settled(chart);
  await chart.locator(".menu-trigger").click();
  await chart.getByRole("menuitem", {name: "Edit chart", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Edit panel", exact: true}), preview = editor.locator(".chart-preview .chart-card");
  await settled(preview);
  await centered(preview);
  const paint = await preview.locator("canvas").evaluate(canvas => ({
    height: canvas.height, maxBottom: Math.max(...window.chartReadoutPaint(canvas).map(label => label.bottom)),
  }));
  expect(paint.maxBottom).toBeLessThanOrEqual(paint.height - 2);
  expect((await preview.locator(".u-over").boundingBox())!.height).toBeGreaterThanOrEqual(180);
  await hover(page, preview, .9, .8);
  await bounded(preview.getByRole("tooltip"), 1440, 900);
  await expect(preview).not.toContainText(/Inspect|Nearest/);
  await page.screenshot({path: "artifacts/chart-readout-preview-dates.png"});
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
});

test("elapsed plotting density and scientific Y-label width are preserved", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await mockApi(page, {points: 6, metricValues: {"run-1": {"/progress/loss": -1e-12}}});
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card");
  await settled(chart);
  const geometry = await chart.evaluate(node => {
    const host = node.querySelector(".chart-host")!.getBoundingClientRect(), plot = node.querySelector(".u-over")!.getBoundingClientRect();
    const ctx = node.querySelector("canvas")!.getContext("2d")!;
    ctx.save(); ctx.font = "11px system-ui, sans-serif";
    const labelWidth = ctx.measureText("-1.00e-12").width;
    ctx.restore();
    return {hostHeight: host.height, plotHeight: plot.height, leftAxis: plot.left - host.left, labelWidth};
  });
  expect(geometry.hostHeight).toBe(236);
  expect(geometry.plotHeight).toBe(200);
  expect(geometry.leftAxis).toBeGreaterThan(geometry.labelWidth + 6);
  await page.screenshot({path: "artifacts/chart-readout-scientific-elapsed.png"});
});
