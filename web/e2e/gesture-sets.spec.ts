import {test, expect} from "@playwright/test";
import {mockApi, seedWorkspace, serverState, type FixtureOptions} from "./fixtures";

test("Add remains useful for sections and snapshot tables before numeric fields arrive", async ({page}) => {
  const options: FixtureOptions = {mode: "waiting"};
  await mockApi(page, options);
  await page.goto("/rvx?runs=run-1&live=0");
  const add = page.getByRole("button", {name: "Add", exact: true});
  await expect(page.getByText("Waiting for the first observation", {exact: true})).toBeVisible();
  await expect(add).toHaveCount(1);
  await expect(add).toBeEnabled();
  options.mode = "nonnumeric";
  await page.reload();
  await expect(page.getByText("Choose a snapshot view", {exact: true})).toBeVisible();
  await expect(add).toBeEnabled();
  delete options.mode;
  await page.reload();
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  await expect(add).toBeEnabled();
});

test("zoom committed outside the chart remains resettable and survives refresh", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const original = await chart.locator("canvas").elementHandle();
  for (const side of ["right", "left"]) {
    const before = await chart.locator(".chart-host").getAttribute("aria-description");
    const host = (await chart.locator(".chart-host").boundingBox())!;
    const overlay = (await chart.locator(".u-over").boundingBox())!;
    const start = overlay.x + overlay.width * (side === "right" ? .3 : .7);
    await page.mouse.move(start, overlay.y + 35); await page.mouse.down();
    await page.mouse.move(side === "right" ? host.x + host.width + 40 : host.x - 40, overlay.y + 35, {steps: 8});
    await page.mouse.up();
    await expect(chart.locator(".chart-host")).not.toHaveAttribute("aria-description", before!);
    await expect(chart.locator(".chart-zoom-state")).toBeVisible();
    const zoom = await chart.locator(".chart-host").getAttribute("aria-description");
    const count = requests.filter(request => request.path === "/api/snapshots/query").length;
    await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").length, {timeout: 9000}).toBeGreaterThan(count);
    await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", zoom!);
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await chart.locator(".menu-trigger").click(); await chart.getByRole("menuitem", {name: "Reset zoom"}).click();
  }
});

test("a gesture starting outside the plot does not invent a zoom state", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const before = await chart.locator(".chart-host").getAttribute("aria-description");
  const heading = (await chart.locator(".metric-heading").boundingBox())!;
  const overlay = (await chart.locator(".u-over").boundingBox())!;
  await page.mouse.move(heading.x + 10, heading.y + 10); await page.mouse.down();
  await page.mouse.move(overlay.x + overlay.width / 2, overlay.y + 35, {steps: 5}); await page.mouse.up();
  await expect(chart.locator(".chart-zoom-state")).toBeHidden();
  await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", before!);
});

test("chart menus dismiss with Escape and outside clicks, and only one stays open", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  const first = page.locator(".chart-card").first().locator(".panel-actions");
  const summary = first.locator(".menu-trigger");
  await summary.click();
  await page.keyboard.press("Escape");
  await expect(first.locator(".menu-content")).toBeHidden();
  await expect(summary).toBeFocused();
  await summary.click();
  await page.locator(".appbar").click();
  await expect(first.locator(".menu-content")).toBeHidden();
  await summary.click();
  const second = page.locator(".chart-card").nth(1).locator(".panel-actions");
  await second.locator(".menu-trigger").click();
  await expect(second.locator(".menu-content")).toBeVisible();
  await expect(page.locator(".menu-content:popover-open")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(second.locator(".menu-content")).toBeHidden();
});

test("long saved names fit narrow dialogs and replacement is explicit", async ({page}) => {
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}], "One panel");
  await mockApi(page);
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".chart-card")).toHaveCount(1);
  const name = "W".repeat(80);
  await page.getByRole("button", {name: "Workspace sets"}).click();
  const sets = page.getByRole("dialog", {name: "Workspace sets", exact: true});
  await sets.getByRole("button", {name: "Save as…", exact: true}).click();
  await sets.getByRole("textbox", {name: "Workspace set name"}).fill(name);
  await sets.getByRole("button", {name: "Save workspace set", exact: true}).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", {name: "Workspace sets"}).click();
  expect(await sets.locator(".dialog-body").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(sets.locator('[aria-current="true"]')).toHaveText(name);
  await sets.getByRole("button", {name: "Save as…", exact: true}).click();
  await expect(sets.getByRole("textbox", {name: "Workspace set name"})).toHaveValue(name);
  await sets.getByRole("textbox", {name: "Workspace set name"}).fill(name);
  await expect(sets.getByRole("button", {name: "Update workspace set", exact: true})).toBeVisible();
  await page.screenshot({path: "artifacts/long-chart-set-mobile.png"});
  await sets.getByRole("button", {name: "Update workspace set", exact: true}).click();
  expect((await serverState(page)).workspaces.sets.length).toBe(2);
});
