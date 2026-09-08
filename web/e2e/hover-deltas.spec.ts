import {test, expect} from "@playwright/test";
import {mkdir, writeFile} from "node:fs/promises";
import {firstObservation, mockApi} from "./fixtures";

test("hover and keyboard focus do not draw bottom bars on controls or chart titles", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".section-grid .chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", {name: "Switch to dark appearance"}).click();
    const search = page.getByRole("searchbox", {name: "Search runs"});
    await search.click(); await search.fill("grpo");
    await expect(search).toHaveCSS("box-shadow", "none");
    await expect(page.locator(".search-box")).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    await page.screenshot({path: `artifacts/no-focus-bar-search-${theme}.png`});
    const title = chart.locator(".panel-drag-handle");
    await title.hover();
    await expect(title).toHaveCSS("box-shadow", "none");
    await page.screenshot({path: `artifacts/no-focus-bar-title-hover-${theme}.png`});
    await page.keyboard.press("Tab"); await title.focus();
    await expect.poll(() => title.evaluate(node => node.matches(":focus-visible"))).toBe(true);
    await expect(title).toHaveCSS("box-shadow", "none");
    await chart.locator(".chart-host").focus(); await page.keyboard.press("ArrowLeft");
    await expect(title).toHaveCSS("box-shadow", "none");
    await chart.locator(".menu-trigger").focus();
    await expect(chart.locator(".menu-trigger")).toHaveCSS("box-shadow", "none");
    const status = page.getByRole("combobox", {name: "Status", exact: true});
    await status.click();
    await expect(status).toHaveCSS("box-shadow", "none");
    await expect(status).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    await page.keyboard.press("Escape");
    await page.getByRole("button", {name: "Add", exact: true}).click();
    const editor = page.getByRole("dialog", {name: "Add", exact: true});
    const input = editor.getByRole("textbox", {name: "Panel title"});
    await input.fill("No focus underline");
    await expect(input).toHaveCSS("box-shadow", "none");
    await expect(input).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    await page.screenshot({path: `artifacts/no-focus-bar-editor-${theme}.png`});
    await editor.getByRole("button", {name: "Cancel", exact: true}).click();
  }
});

test("measures selected RX beside hovered TX, hovered native options, and centered SVG actions", async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await mockApi(page);
  const paths = ["/metrics/network~1eth0~1rx_mbps", "/metrics/network~1eth0~1tx_mbps"];
  await page.route("**/api/charts/catalog", route => route.fulfill({json: {
    runs: [{run_id: "run-1", snapshot_count: 180, first_observed_at_ns: firstObservation, last_observed_at_ns: firstObservation + 179 * 60e9}],
    defaults: paths, axes: ["elapsed", "wall_time"], truncated: false,
    metrics: paths.map((path, index) => ({
      path, name: `Network Eth0 ${index ? "TX" : "RX"}`, group: "Throughput", unit: "Mbps", run_ids: ["run-1"],
      sources: [{run_id: "run-1", source_id: "run-1-source-0", label: "Host monitor", role: "hostmon", rank: null, node_id: "node-a", primary: true, latest_value: 1, observed_at_ns: firstObservation + 179 * 60e9}],
    })),
  }}));
  await page.route("**/api/snapshots/query", route => {
    const request = route.request().postDataJSON();
    return route.fulfill({json: {axis: request.axis, series: request.paths.map((path: string, trace: number) => ({
      run_id: "run-1", source_id: "run-1-source-0", path,
      axes: Array.from({length: 180}, (_, index) => request.axis === "wall_time" ? firstObservation + index * 60e9 : index * 60e9),
      values: Array.from({length: 180}, (_, index) => 1 + trace + Math.sin(index / 10) * .4),
      snapshot_ids: Array.from({length: 180}, (_, index) => index + 1), sequences: Array.from({length: 180}, (_, index) => index),
      source_session_ids: Array.from({length: 180}, () => "network-session"),
      observed_at_ns: Array.from({length: 180}, (_, index) => firstObservation + index * 60e9),
    }))}});
  });
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".section-grid canvas").first()).toBeVisible();
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await editor.getByRole("checkbox", {name: "Select metric Network Eth0 RX", exact: true}).check();
  const tx = editor.locator('.metric-option[data-path="/metrics/network~1eth0~1tx_mbps"]');
  await tx.hover();
  await expect(editor.locator(".chart-preview canvas")).toBeVisible();
  const metrics = await editor.locator(".metric-option").evaluateAll(items => items.map(item => {
    const box = item.getBoundingClientRect(), label = item.querySelector("strong")!;
    const style = getComputedStyle(label);
    return {text: label.textContent, top: box.top, bottom: box.bottom, height: box.height, font: style.fontSize, weight: style.fontWeight,
      background: getComputedStyle(item).backgroundColor, hovered: item.matches(":hover"), selected: item.querySelector("input")?.checked};
  }));
  expect(metrics[0]?.selected).toBe(true); expect(metrics[1]?.hovered).toBe(true);
  const metricGap = metrics[1]!.top - metrics[0]!.bottom;
  expect(metricGap).toBeGreaterThanOrEqual(3);
  expect(Number.parseFloat(metrics[0]!.font)).toBeLessThanOrEqual(13);
  await mkdir("artifacts", {recursive: true});
  await page.screenshot({path: "artifacts/workspace-after-metric-hover.png"});
  await editor.getByRole("button", {name: "Cancel", exact: true}).click();

  const status = page.getByRole("combobox", {name: "Status", exact: true});
  await status.click();
  await page.getByRole("option", {name: "Running", exact: true}).hover();
  const options = await status.locator("option").evaluateAll(items => items.map(item => {
    const box = item.getBoundingClientRect();
    return {text: item.textContent, top: box.top, bottom: box.bottom, height: box.height, hovered: item.matches(":hover")};
  }));
  const optionGap = options[1]!.top - options[0]!.bottom;
  expect(options[1]?.hovered).toBe(true); expect(optionGap).toBeGreaterThanOrEqual(3);
  await page.screenshot({path: "artifacts/workspace-after-dropdown-hover.png"});
  await page.keyboard.press("Escape");

  const action = page.locator(".section-grid .chart-card").first().locator(".menu-trigger");
  await action.hover();
  const buttonBox = (await action.boundingBox())!, svgBox = (await action.locator("svg").boundingBox())!;
  const icon = {
    button: buttonBox, svg: svgBox, viewBox: await action.locator("svg").getAttribute("viewBox"),
    offsetX: svgBox.x + svgBox.width / 2 - buttonBox.x - buttonBox.width / 2,
    offsetY: svgBox.y + svgBox.height / 2 - buttonBox.y - buttonBox.height / 2,
    literalEllipsis: await action.evaluate(node => node.textContent?.includes("···") ?? false),
  };
  expect(icon.offsetX).toBe(0); expect(icon.offsetY).toBe(0); expect(icon.literalEllipsis).toBe(false);
  await page.screenshot({path: "artifacts/workspace-after-options-hover.png"});
  await writeFile("artifacts/workspace-after-geometry.json", JSON.stringify({
    environment: "Rebuilt local web/dist in Chromium; simulated numeric network projections, not a deployment change.",
    parentBaseline: {metricGap: 0, optionGap: 0, metricFont: "14px", metricHeights: [64, 64, 60], literalOptionsGlyph: "···", optionsTarget: 28},
    metricGap, metrics, optionGap, options, icon,
  }, null, 2));
});
