import {test, expect} from "@playwright/test";
import {mockApi, seedWorkspace, serverState, type FixtureOptions} from "./fixtures";

test("panel menus, reset zoom, workspace saves and deletion remain directly operable", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const first = page.locator(".chart-card").first();
  await expect(first.locator("canvas")).toBeVisible();
  const canvas = await first.locator("canvas").elementHandle();
  const menu = first.getByRole("button", {name: "Policy loss chart options"});
  await menu.click();
  await expect(first.getByRole("menuitem", {name: /Move earlier|Move later/})).toHaveCount(0);
  await first.getByRole("menuitem", {name: "Make wide"}).click();
  await expect(first).toHaveClass(/wide/);
  await menu.click(); await first.getByRole("menuitem", {name: "Normal width"}).click();
  const box = (await first.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 25, box.y + 30, {steps: 5}); await page.mouse.up();
  await menu.click(); await first.getByRole("menuitem", {name: "Reset zoom"}).click();
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await page.getByRole("button", {name: "Workspace sets"}).click();
  const sets = page.getByRole("dialog", {name: "Workspace sets"});
  await sets.getByRole("button", {name: "Save workspace set", exact: true}).click();
  await expect(sets).toContainText("Give the workspace set a name");
  await sets.getByRole("textbox", {name: "Workspace set name"}).fill("Review set");
  await sets.getByRole("button", {name: "Save workspace set", exact: true}).click();
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await sets.getByRole("button", {name: "Delete workspace set Review set"}).click();
  await expect.poll(async () => (await serverState(page)).workspaces.sets.length).toBe(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", {name: "Add", exact: true})).toBeFocused();
});

test("retry preserves last successful data and metadata filters never change Run selection", async ({page}) => {
  const options: FixtureOptions = {};
  await mockApi(page, options);
  await page.goto("/rvx?runs=run-1");
  const first = page.locator(".chart-card").first();
  await expect(first.locator("canvas")).toBeVisible();
  const canvas = await first.locator("canvas").elementHandle();
  options.failQueries = true;
  await expect(first.getByRole("button", {name: "Retry", exact: true})).toBeVisible({timeout: 9000});
  options.failQueries = false;
  await first.getByRole("button", {name: "Retry", exact: true}).click();
  await expect(first.locator(".chart-status")).toBeHidden();
  await page.getByRole("combobox", {name: "Status", exact: true}).selectOption("finished");
  await expect(page.locator(".selection-count")).toContainText("outside filters");
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
});

test("panel capacity is explicit and obsolete preferences remain untouched", async ({page}) => {
  await seedWorkspace(page, Array.from({length: 24}, (_, index) => ({path: index ? `/unused/${index}` : "/progress/loss", size: "normal"})));
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".section-grid .chart-card")).toHaveCount(24);
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await editor.getByRole("checkbox", {name: "Select metric Policy loss", exact: true}).check();
  await expect(editor.getByRole("alert")).toContainText("24 panels");
  await expect(editor.getByRole("button", {name: "Add", exact: true})).toBeDisabled();
  await editor.getByRole("button", {name: "Cancel", exact: true}).click();
  expect(await page.locator(".section-grid .chart-card").count()).toBe(24);
});
