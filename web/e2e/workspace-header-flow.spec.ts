import {test, expect, type Page} from "@playwright/test";
import {mockApi, seedUiState, serverState, uiServer} from "./fixtures";
import type {WorkspaceSet} from "../src/app/panels";

const training: WorkspaceSet = {id: "training", name: "Training", experimentId: "experiment-1",
  sections: [{id: "main", name: "", collapsed: false}], panels: [
    {id: "chart", kind: "chart", sectionId: "main", size: "normal", path: "/progress/loss"},
    {id: "table", kind: "metric-table", sectionId: "main", size: "normal", paths: ["/progress/loss"]},
  ]};
const resources: WorkspaceSet = {id: "resources", name: "Resources", experimentId: "experiment-1",
  sections: [{id: "main", name: "", collapsed: false}], panels: [
    {id: "resource", kind: "chart", sectionId: "main", size: "wide", path: "/resources/gpu_utilization"},
  ]};
async function setup(page: Page): Promise<void> {
  await mockApi(page);
  await seedUiState(page, {sets: [training, resources], selected: {"experiment-1": training.id}});
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".chart-card canvas")).toBeVisible();
}
async function makeWide(page: Page): Promise<void> {
  const card = page.locator('[data-panel-id="chart"]');
  await card.locator(".menu-trigger").click();
  await card.getByRole("menuitem", {name: "Make wide", exact: true}).click();
}

test("Saved expires once without live ticks reviving it and all feedback stays beside the name", async ({page}) => {
  await page.clock.install(); await setup(page);
  const slot = page.locator(".workspace-save-slot"), picker = page.locator(".workspace-picker");
  await expect(slot).toBeVisible();
  const initial = (await slot.boundingBox())!;
  const anchor = (await picker.boundingBox())!;
  expect(initial.x - anchor.x - anchor.width).toBeLessThanOrEqual(4);
  await page.clock.runFor(3100); await expect(slot).toBeHidden();
  await page.clock.runFor(10000); await expect(slot).toBeHidden();
  await makeWide(page);
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  expect((await slot.boundingBox())!.x).toBe(initial.x);
  await page.getByRole("button", {name: "Save current workspace"}).click();
  await expect(slot).toHaveText("Saved"); await expect(slot).toBeVisible();
  await page.screenshot({path: "artifacts/header-saved-group.png"});
  await page.clock.runFor(3100); await expect(slot).toBeHidden();
  await page.screenshot({path: "artifacts/header-saved-expired.png"});
});

test("workspace switching is anchored and renaming updates the same ID without saving panel edits", async ({page}) => {
  await setup(page);
  const picker = page.locator(".workspace-picker"), canvas = await page.locator(".chart-card canvas").elementHandle();
  await picker.click();
  const popup = page.getByRole("dialog", {name: "Workspace sets", exact: true});
  const anchor = (await picker.boundingBox())!, box = (await popup.boundingBox())!;
  expect(box.width).toBe(240);
  await expect(picker).toHaveCSS("padding-left", "8px");
  await expect(picker).toHaveCSS("padding-right", "8px");
  expect(Math.abs(box.x - anchor.x)).toBeLessThan(2);
  expect(box.y - anchor.y - anchor.height).toBeGreaterThanOrEqual(0);
  expect(box.y - anchor.y - anchor.height).toBeLessThanOrEqual(8);
  await expect(popup.locator(".saved-set-name").first()).toHaveText("Training");
  await popup.getByRole("button", {name: "Rename workspace", exact: true}).click();
  await popup.getByRole("textbox", {name: "Workspace name", exact: true}).fill("Training overview");
  await page.screenshot({path: "artifacts/header-inline-rename.png"});
  await popup.getByRole("textbox", {name: "Workspace name", exact: true}).press("Enter");
  await expect(picker).toHaveText("Training overview");
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  expect((await serverState(page)).workspaces.sets.map(set => set.id).sort()).toEqual(["resources", "training"]);
  await makeWide(page);
  await picker.focus(); await page.keyboard.press("F2");
  await popup.getByRole("textbox", {name: "Workspace name", exact: true}).fill("Renamed draft");
  await popup.getByRole("textbox", {name: "Workspace name", exact: true}).press("Enter");
  await expect(picker).toHaveText("Renamed draft");
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  expect((await serverState(page)).workspaces.sets.find(set => set.id === "training")!.panels[0]!.size).toBe("normal");
  await expect(page.locator('[data-panel-id="chart"]')).toHaveClass(/wide/);
  await page.getByRole("button", {name: "Save current workspace"}).click();
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  await picker.click(); await popup.getByRole("button", {name: "Resources", exact: true}).click();
  await expect(picker).toHaveText("Resources");
  await picker.click(); await popup.getByRole("button", {name: "Renamed draft", exact: true}).click();
  await expect(picker).toHaveText("Renamed draft");
});

test("a slow list refresh cannot steal rename input and pending rename retries keep newer text", async ({page}) => {
  await setup(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/ui/state", async route => {await gate; await route.fallback();});
  const picker = page.locator(".workspace-picker");
  await picker.focus(); await page.keyboard.press("F2");
  const input = page.getByRole("textbox", {name: "Workspace name", exact: true});
  await input.fill("First rename");
  uiServer(page).workspaces.revision++;
  release();
  await expect(input).toHaveValue("First rename");
  let attempts = 0;
  const bodies: string[] = [];
  await page.route("**/api/ui/workspaces", route => {
    bodies.push(route.request().postData()!);
    return ++attempts === 1 ? route.fulfill({status: 503, json: {error: "Unknown save outcome"}}) : route.fallback();
  });
  await input.press("Enter");
  await expect(input).toBeEnabled();
  await expect(page.locator(".workspace-rename-error")).toContainText("Unknown save outcome");
  await input.fill("Second rename"); await input.press("Enter");
  await expect(page.locator(".workspace-rename-error")).toContainText("Previous rename confirmed");
  expect(bodies[1]).toBe(bodies[0]);
  await expect(input).toHaveValue("Second rename"); await input.press("Enter");
  await expect(picker).toHaveText("Second rename");
});

test("large workspace lists search in place, and Updated plus metric table spacing align across widths", async ({page}) => {
  await mockApi(page);
  await seedUiState(page, {selected: {"experiment-1": "training"}, sets: [training,
    ...Array.from({length: 80}, (_, index) => ({...resources, id: `set-${index}`, name: `Experiment view ${index}`}))]});
  await page.goto("/rvx?runs=run-1");
  const picker = page.locator(".workspace-picker");
  await picker.click();
  await page.getByRole("searchbox", {name: "Search workspaces"}).fill("view 79");
  await expect(page.locator(".workspace-set-list .saved-set")).toHaveCount(1);
  await page.getByRole("button", {name: "Experiment view 79", exact: true}).click();
  await expect(picker).toHaveText("Experiment view 79");
  await picker.click(); await page.getByRole("searchbox", {name: "Search workspaces"}).fill("Training");
  await page.getByRole("button", {name: "Training", exact: true}).click();
  for (const width of [1440, 901, 390, 320]) {
    await page.setViewportSize({width, height: 900});
    await expect(picker).toHaveCSS("padding-left", "8px");
    await expect(picker).toHaveCSS("padding-right", "8px");
    if (width === 390) await page.getByRole("button", {name: "Switch to dark appearance"}).click();
    const updated = page.locator(".collection-freshness");
    await expect(updated).toHaveText(/^Updated \d{2}:\d{2}:\d{2}$/);
    const time = (await updated.boundingBox())!, add = (await page.getByRole("button", {name: "Add", exact: true}).boundingBox())!;
    expect(Math.abs(time.y + time.height / 2 - add.y - add.height / 2)).toBeLessThan(1);
    expect((await page.locator(".brand-wordmark").boundingBox())?.width ?? 0).toBeLessThanOrEqual(38);
    const table = page.locator(".table-card"); await table.scrollIntoViewIfNeeded();
    await expect(table.locator("tbody tr")).toHaveCount(1);
    const spacing = await table.evaluate(node => {
      const header = node.querySelector(".panel-header")!.getBoundingClientRect();
      const tools = node.querySelector(".table-tools")!.getBoundingClientRect();
      const search = node.querySelector(".table-search")!.getBoundingClientRect();
      const body = node.querySelector(".table-scroll")!.getBoundingClientRect();
      return {titleToTools: search.top - header.bottom, toolsToBody: body.top - search.bottom, top: tools.top};
    });
    expect(spacing.titleToTools).toBe(8); expect(spacing.toolsToBody).toBe(8);
    await page.screenshot({path: `artifacts/header-table-spacing-${width}.png`});
    await page.locator(".chart-scroll").evaluate(node => {node.scrollTop = 0;});
    await picker.click();
    await page.screenshot({path: `artifacts/header-picker-${width}.png`});
    const popup = (await page.locator(".workspace-popover").boundingBox())!;
    expect(popup.width).toBe(240);
    expect(popup.x).toBeGreaterThanOrEqual(0); expect(popup.x + popup.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
  }
});
