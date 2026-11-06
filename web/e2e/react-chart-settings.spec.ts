import {expect, test} from "@playwright/test";
import {mockApi, seedWorkspace} from "./fixtures";

test("React chart settings apply with the untouched default line width", async ({page}) => {
  const requests = await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".react-chart-panel").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const canvas = await chart.locator("canvas").elementHandle();
  const queryCount = requests.filter(request => request.path === "/api/snapshots/query").length;
  await expect(page.getByRole("button", {name: "Workspace settings", exact: true})).toHaveCount(0);
  await expect(page.locator(".selection-strip")).toHaveCount(0);
  await chart.getByRole("button", {name: "Chart settings", exact: true}).click();
  const settings = page.getByRole("dialog", {name: "Edit chart", exact: true});
  await expect(settings).toBeFocused();
  await expect(settings.getByRole("searchbox")).not.toBeFocused();
  expect((await settings.boundingBox())!.width).toBeLessThanOrEqual(880);
  expect((await settings.boundingBox())!.height).toBeLessThanOrEqual(640);
  await settings.getByRole("combobox", {name: "Panel width", exact: true}).click();
  await expect(page.getByRole("option")).toHaveText(["1/4", "1/3", "1/2", "1/1"]);
  await page.getByRole("option", {name: "1/4", exact: true}).click();
  await settings.getByLabel("Panel title", {exact: true}).fill("Readable loss");
  await settings.getByLabel("Y minimum", {exact: true}).fill("0");
  await settings.getByLabel("Y maximum", {exact: true}).fill("20");
  await settings.getByRole("button", {name: "Save changes", exact: true}).click();
  await expect(settings).toHaveCount(0);
  await expect(chart.locator(".panel-title-text")).toHaveText("Readable loss");
  await expect(chart).toHaveAttribute("data-panel-size", "quarter");
  await expect(chart.locator("canvas")).toBeVisible();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await chart.locator(".menu-trigger").click();
  await page.getByRole("menuitem", {name: "Edit chart", exact: true}).click();
  await expect(settings.getByRole("combobox", {name: "Y scale", exact: true})).toBeVisible();
  expect(requests.filter(request => request.path === "/api/snapshots/query")).toHaveLength(queryCount);
  await page.setViewportSize({width: 320, height: 844});
  await expect(settings.getByRole("button", {name: "Save changes", exact: true})).toBeInViewport({ratio: 1});
  await expect(settings.getByRole("button", {name: "Export PNG", exact: true})).toBeInViewport({ratio: 1});
  await settings.getByRole("button", {name: "Cancel", exact: true}).click();
});

test("React chart rejects nonpositive logarithmic bounds and exports a composed PNG", async ({page}) => {
  await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".react-chart-panel").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const canvas = await chart.locator("canvas").elementHandle();
  await chart.getByRole("button", {name: "Chart settings", exact: true}).click();
  const settings = page.getByRole("dialog", {name: "Edit chart", exact: true});
  await settings.getByRole("combobox", {name: "Y scale", exact: true}).click();
  await page.getByRole("option", {name: "Logarithmic", exact: true}).click();
  await settings.getByLabel("Y minimum", {exact: true}).fill("0");
  await expect(settings.getByRole("button", {name: "Save changes", exact: true})).toBeDisabled();
  await expect(settings.getByRole("alert")).toHaveText("Logarithmic bounds must be greater than zero.");
  await settings.getByLabel("Y minimum", {exact: true}).fill("0.01");
  await settings.getByLabel("Smoothing", {exact: true}).focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await settings.getByRole("button", {name: "Save changes", exact: true}).click();
  await expect(settings).toHaveCount(0);
  await expect(chart.locator("canvas")).toBeVisible();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await expect(chart).toHaveAttribute("data-loaded", "true");
  await chart.getByRole("button", {name: "Chart settings", exact: true}).click();
  const download = page.waitForEvent("download");
  await settings.getByRole("button", {name: "Export PNG", exact: true}).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
});

test("chart worker failures are explicit and retry never falls back to main-thread projection", async ({page}) => {
  const requests = await mockApi(page);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", {value: class {
      constructor() {throw new Error("Projection worker unavailable");}
    }});
  });
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".react-chart-panel");
  await expect(chart).toContainText("Projection worker unavailable");
  await expect(chart.locator("canvas")).toHaveCount(0);
  const queryCount = requests.filter(request => request.path === "/api/snapshots/query").length;
  await chart.getByRole("button", {name: "Retry", exact: true}).click();
  await expect(chart).toContainText("Projection worker unavailable");
  await expect(chart.locator("canvas")).toHaveCount(0);
  expect(requests.filter(request => request.path === "/api/snapshots/query")).toHaveLength(queryCount);
});
