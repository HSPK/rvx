import {test, expect, type Locator, type Page} from "@playwright/test";
import {mkdir, writeFile} from "node:fs/promises";
import {mockApi, seedWorkspace, selectedObservation, serverState} from "./fixtures";

interface PaintedText {text: string; x: number; y: number}
declare global {
  interface Window {readChartPaintText: (canvas: HTMLCanvasElement) => PaintedText[]}
}

async function recordCanvasText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const text = new WeakMap<HTMLCanvasElement, PaintedText[]>();
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.clearRect = function(this: CanvasRenderingContext2D, x, y, width, height) {
      if (x <= 0 && y <= 0 && width >= this.canvas.width && height >= this.canvas.height) text.set(this.canvas, []);
      clear.call(this, x, y, width, height);
    };
    CanvasRenderingContext2D.prototype.fillText = function(this: CanvasRenderingContext2D, value, x, y, maxWidth) {
      const transform = this.getTransform();
      const entries = text.get(this.canvas) ?? [];
      entries.push({text: value, x: transform.a * x + transform.c * y + transform.e, y: transform.b * x + transform.d * y + transform.f});
      text.set(this.canvas, entries);
      if (maxWidth === undefined) fill.call(this, value, x, y);
      else fill.call(this, value, x, y, maxWidth);
    };
    window.readChartPaintText = canvas => text.get(canvas) ?? [];
  });
}

async function renderedPlot(root: Locator) {
  return root.evaluate(element => {
    const canvas = element.querySelector<HTMLCanvasElement>("canvas");
    const overlay = element.querySelector<HTMLElement>(".u-over");
    const legend = element.querySelector<HTMLElement>(".legend-item");
    if (!canvas || !overlay || !legend) throw new Error("Plot must be rendered before measuring its paint.");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas paint context.");
    const outer = canvas.getBoundingClientRect(), inner = overlay.getBoundingClientRect();
    const scaleX = canvas.width / outer.width, scaleY = canvas.height / outer.height;
    const left = Math.round((inner.left - outer.left) * scaleX), top = Math.round((inner.top - outer.top) * scaleY);
    const width = Math.max(1, Math.floor(inner.width * scaleX)), height = Math.max(1, Math.floor(inner.height * scaleY));
    const pixels = context.getImageData(left, top, width, height).data;
    const hue = legend.style.getPropertyValue("--run-color").trim().slice(1);
    const rgb = [0, 2, 4].map(index => Number.parseInt(hue.slice(index, index + 2), 16));
    const opaqueRows = new Set<number>();
    const coloredRows = new Set<number>();
    let opaque = 0, translucent = 0, sumY = 0, hash = 2166136261;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      for (let channel = 0; channel < 4; channel++) hash = Math.imul(hash ^ pixels[offset + channel]!, 16777619);
      const sameHue = rgb.every((value, channel) => Math.abs(value - pixels[offset + channel]!) <= 12);
      if (!sameHue) continue;
      const alpha = pixels[offset + 3]!, y = Math.floor(offset / 4 / width);
      if (alpha >= 15) coloredRows.add(y);
      if (alpha >= 220) {opaque++; opaqueRows.add(y); sumY += y + .5;}
      else if (alpha >= 15 && alpha <= 180) translucent++;
    }
    const yTicks = window.readChartPaintText(canvas)
      .filter(item => item.x < left - 1 && item.y >= top - 2 && item.y <= top + height + 2)
      .map(item => Number(item.text.replaceAll(",", ""))).filter(Number.isFinite);
    return {
      width, height, opaquePixels: opaque, translucentPixels: translucent,
      opaqueRows: opaqueRows.size, coloredRows: coloredRows.size, lineY: opaque ? sumY / opaque / height : null,
      yTicks: [...new Set(yTicks)].sort((a, b) => a - b), hash: hash >>> 0,
    };
  });
}

async function openLossEditor(page: Page): Promise<Locator> {
  const chart = page.locator('.chart-grid .chart-card[data-path="/progress/loss"]');
  await expect(chart.locator("canvas")).toBeVisible();
  await chart.getByRole("button", {name: "Policy loss chart options"}).click();
  await chart.getByRole("menuitem", {name: "Edit chart", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Edit panel", exact: true});
  await expect(editor.locator(".chart-preview canvas")).toBeVisible();
  return editor;
}

test("line width, points, area fill, legend and Y limits alter actual preview and applied paint", async ({page}) => {
  await recordCanvasText(page);
  const requests = await mockApi(page, {points: 6, metricValues: {"run-1": {"/progress/loss": 5}}});
  await page.goto("/rvx?runs=run-1&live=0");
  const editor = await openLossEditor(page);
  const preview = editor.locator(".chart-preview");
  await editor.getByRole("textbox", {name: "Y minimum"}).fill("0");
  await editor.getByRole("textbox", {name: "Y maximum"}).fill("10");
  await editor.getByRole("spinbutton", {name: "Line width"}).fill("1");
  await editor.getByRole("combobox", {name: "Points", exact: true}).selectOption("hide");
  const thin = await renderedPlot(preview);
  expect(thin.opaquePixels).toBeGreaterThan(100);
  expect(thin.lineY!).toBeCloseTo(.5, 1);
  expect(thin.yTicks.at(0)).toBe(0); expect(thin.yTicks.at(-1)).toBe(10);

  await editor.getByRole("spinbutton", {name: "Line width"}).fill("5");
  const thick = await renderedPlot(preview);
  expect(thick.opaquePixels).toBeGreaterThan(thin.opaquePixels * 2.5);

  await editor.getByRole("spinbutton", {name: "Line width"}).fill("1");
  await editor.getByRole("combobox", {name: "Points", exact: true}).selectOption("show");
  const points = await renderedPlot(preview);
  await page.screenshot({path: "artifacts/rendered-point-markers.png"});
  await mkdir("artifacts", {recursive: true});
  await writeFile("artifacts/rendered-marker-measurements.json", JSON.stringify({thin, thick, points}, null, 2));
  expect(points.coloredRows).toBeGreaterThan(thin.coloredRows);

  await editor.getByRole("combobox", {name: "Points", exact: true}).selectOption("hide");
  await editor.getByRole("combobox", {name: "Presentation", exact: true}).selectOption("area");
  const area = await renderedPlot(preview);
  expect(area.translucentPixels).toBeGreaterThan(Math.max(1000, thin.translucentPixels * 10));
  await editor.getByRole("combobox", {name: "Legend", exact: true}).selectOption("show");
  await expect(preview.locator(".chart-legend")).toBeVisible();
  await editor.getByRole("combobox", {name: "Legend", exact: true}).selectOption("hide");
  await expect(preview.locator(".chart-legend")).toBeHidden();
  await editor.getByRole("combobox", {name: "Legend", exact: true}).selectOption("show");
  await editor.getByRole("spinbutton", {name: "Line width"}).fill("5");
  await editor.getByRole("combobox", {name: "Points", exact: true}).selectOption("show");
  await page.screenshot({path: "artifacts/rendered-display-preview.png"});
  await editor.getByRole("button", {name: "Save changes"}).click();

  const chart = page.locator('.chart-grid .chart-card[data-path="/progress/loss"]');
  const applied = await renderedPlot(chart);
  expect(applied.translucentPixels).toBeGreaterThan(1000);
  expect(applied.opaqueRows).toBeGreaterThanOrEqual(thick.opaqueRows);
  expect(applied.yTicks.at(0)).toBe(0); expect(applied.yTicks.at(-1)).toBe(10);
  await expect(chart.locator(".chart-legend")).toBeVisible();
  await chart.locator(".chart-host").focus(); await page.keyboard.press("ArrowRight");
  await expect(selectedObservation(chart).locator(".chart-tooltip-value")).toHaveText("5");
  await page.screenshot({path: "artifacts/rendered-display-applied.png"});
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
  await mkdir("artifacts", {recursive: true});
  await writeFile("artifacts/rendered-display-measurements.json", JSON.stringify({thin, thick, points, area, applied}, null, 2));
});

test("two-sided and out-of-data one-sided Y bounds change painted axes; blanks restore automatic scale", async ({page}) => {
  await recordCanvasText(page);
  await mockApi(page, {points: 6, metricValues: {"run-1": {"/progress/loss": 5}}});
  await page.goto("/rvx?runs=run-1&live=0");
  let editor = await openLossEditor(page);
  let preview = editor.locator(".chart-preview");
  let lower = editor.getByRole("textbox", {name: "Y minimum"}), upper = editor.getByRole("textbox", {name: "Y maximum"});
  const main = page.locator('.chart-grid .chart-card[data-path="/progress/loss"]');
  const automatic = await renderedPlot(preview);
  await lower.fill("0"); await upper.fill("20");
  const bounded = await renderedPlot(preview);
  expect(bounded.lineY!).toBeCloseTo(.75, 1);
  expect(bounded.yTicks.at(0)).toBe(0); expect(bounded.yTicks.at(-1)).toBe(20);
  await upper.fill(""); await lower.fill("20");
  const onlyMinimum = await renderedPlot(preview);
  expect(onlyMinimum.opaquePixels).toBe(0);
  expect(onlyMinimum.yTicks.at(0)).toBe(20);
  expect(onlyMinimum.yTicks.at(-1)).toBeGreaterThan(20);
  await page.screenshot({path: "artifacts/rendered-y-min-outside-data.png"});
  await editor.getByRole("button", {name: "Save changes"}).click();
  const appliedMinimum = await renderedPlot(main);
  expect(appliedMinimum.opaquePixels).toBe(0);
  expect(appliedMinimum.yTicks.at(0)).toBe(20);
  expect(appliedMinimum.yTicks.at(-1)).toBeGreaterThan(20);
  await page.screenshot({path: "artifacts/rendered-y-min-applied.png"});

  editor = await openLossEditor(page); preview = editor.locator(".chart-preview");
  lower = editor.getByRole("textbox", {name: "Y minimum"}); upper = editor.getByRole("textbox", {name: "Y maximum"});
  await lower.fill(""); await upper.fill("-10");
  const onlyMaximum = await renderedPlot(preview);
  expect(onlyMaximum.opaquePixels).toBe(0);
  expect(onlyMaximum.yTicks.at(-1)).toBe(-10);
  expect(onlyMaximum.yTicks.at(0)).toBeLessThan(-10);
  await page.screenshot({path: "artifacts/rendered-y-max-outside-data.png"});
  await editor.getByRole("button", {name: "Save changes"}).click();
  const appliedMaximum = await renderedPlot(main);
  expect(appliedMaximum.opaquePixels).toBe(0);
  expect(appliedMaximum.yTicks.at(-1)).toBe(-10);
  expect(appliedMaximum.yTicks.at(0)).toBeLessThan(-10);
  await page.screenshot({path: "artifacts/rendered-y-max-applied.png"});

  editor = await openLossEditor(page); preview = editor.locator(".chart-preview");
  upper = editor.getByRole("textbox", {name: "Y maximum"});
  await upper.fill("");
  const restored = await renderedPlot(preview);
  expect(restored.yTicks).toEqual(automatic.yTicks);
  expect(restored.lineY).toBe(automatic.lineY);
  expect(restored.opaquePixels).toBeGreaterThan(100);
  await editor.getByRole("button", {name: "Save changes"}).click();
  const appliedRestored = await renderedPlot(main);
  expect(appliedRestored.opaquePixels).toBeGreaterThan(100);
  expect(appliedRestored.yTicks.at(0)).toBe(automatic.yTicks.at(0));
  expect(appliedRestored.yTicks.at(-1)).toBe(automatic.yTicks.at(-1));
  await mkdir("artifacts", {recursive: true});
  await writeFile("artifacts/rendered-y-measurements.json", JSON.stringify({automatic, bounded, onlyMinimum, appliedMinimum, onlyMaximum, appliedMaximum, restored, appliedRestored}, null, 2));
});

test("invalid Y bounds cannot commit, and Cancel preserves nested saved settings and original paint", async ({page}) => {
  await recordCanvasText(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "wide", presentation: {title: "Original display", style: "area", lineWidth: 3, points: true, legend: "show", yMin: 0, yMax: 10}}], "Original");
  await mockApi(page, {points: 6, metricValues: {"run-1": {"/progress/loss": 5}}});
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-grid .chart-card");
  await expect(chart.locator("canvas")).toBeVisible();
  const before = await renderedPlot(chart);
  const stored = (await serverState(page)).workspaces;
  const originalCanvas = await chart.locator("canvas").elementHandle();
  await chart.locator(".chart-host").focus(); await page.keyboard.press("ArrowRight");
  const id = await selectedObservation(chart).getAttribute("data-snapshot-id");
  await chart.getByRole("button", {name: "Original display chart options"}).click();
  await chart.getByRole("menuitem", {name: "Edit chart"}).click();
  const editor = page.getByRole("dialog", {name: "Edit panel", exact: true});
  await expect(editor.locator(".chart-preview canvas")).toBeVisible();
  await editor.getByRole("textbox", {name: "Panel title"}).fill("Uncommitted title");
  await editor.getByRole("combobox", {name: "Presentation", exact: true}).selectOption("line");
  await editor.getByRole("spinbutton", {name: "Line width"}).fill("5");
  await editor.getByRole("combobox", {name: "Points", exact: true}).selectOption("hide");
  await editor.getByRole("combobox", {name: "Legend", exact: true}).selectOption("hide");
  const lower = editor.getByRole("textbox", {name: "Y minimum"}), upper = editor.getByRole("textbox", {name: "Y maximum"});
  for (const [min, max, message] of [
    ["Infinity", "", "finite"], ["", "-Infinity", "finite"], ["NaN", "", "finite"],
    ["not a number", "10", "finite"], ["5", "5", "less than"], ["8", "2", "less than"],
  ]) {
    await lower.fill(min!); await upper.fill(max!);
    await expect(editor.getByRole("alert")).toContainText(message!);
    await expect(editor.getByRole("button", {name: "Save changes"})).toBeDisabled();
    expect((await renderedPlot(chart)).hash).toBe(before.hash);
  }
  await page.screenshot({path: "artifacts/rendered-invalid-y-cancel.png"});
  await editor.getByRole("button", {name: "Cancel", exact: true}).click();
  expect(await originalCanvas!.evaluate(node => node.isConnected)).toBe(true);
  expect((await renderedPlot(chart)).hash).toBe(before.hash);
  await expect(chart.getByRole("heading", {name: "Original display"})).toBeVisible();
  await chart.locator(".chart-host").focus(); await page.keyboard.press("ArrowRight");
  await expect(selectedObservation(chart)).toHaveAttribute("data-snapshot-id", id!);
  expect((await serverState(page)).workspaces).toEqual(stored);
});
