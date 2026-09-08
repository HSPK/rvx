import {test, expect, type Page} from "@playwright/test";
import {mockApi, selectAddType, seedUiState, serverState} from "./fixtures";

async function seed(page: Page, selected: string | null = "a"): Promise<void> {
  await seedUiState(page, {
    theme: "light", selected: selected ? {"experiment-1": selected} : {},
    sets: ["a", "b"].map(id => ({id, name: id === "a" ? "Training overview" : "Resources", experimentId: "experiment-1",
      sections: [{id: `section-${id}`, name: "Training", collapsed: false}],
      panels: [{id: `panel-${id}`, sectionId: `section-${id}`, kind: "chart", path: "/progress/loss", size: "normal"}]})),
  });
}

async function resizeChart(page: Page, label = "Make wide"): Promise<void> {
  const chart = page.locator(".section-grid .chart-card").first();
  await chart.getByRole("button", {name: /chart options$/}).click();
  await chart.getByRole("menuitem", {name: label, exact: true}).click();
}

test("header shows current workspace, detects real edits and saves directly without resetting plots", async ({page}) => {
  await mockApi(page); await seed(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const header = page.locator(".workspace-header");
  await expect(header.getByRole("button", {name: "Workspace sets"})).toHaveText("Training overview");
  await expect(header.locator(".workspace-save-status")).toHaveText("Saved");
  const save = header.getByRole("button", {name: "Save current workspace"});
  await expect(save).toHaveCount(0);
  const canvas = await page.locator(".chart-card canvas").first().elementHandle();
  await resizeChart(page);
  await expect(header.locator(".workspace-save-status")).toHaveCount(0);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(header.locator(".workspace-save-status")).toHaveText("Saved");
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  expect((await serverState(page)).workspaces.sets.find(set => set.id === "a")!.panels[0]!.size).toBe("wide");
  await page.screenshot({path: "artifacts/workspace-header-saved.png"});
  await resizeChart(page, "Normal width"); await resizeChart(page);
  await expect(header.locator(".workspace-save-status")).toHaveText("Saved");
  await page.getByRole("combobox", {name: "Time range", exact: true}).selectOption("604800");
  await expect(header.locator(".workspace-save-status")).toHaveText("Saved");
  await page.reload();
  await expect(header.locator(".workspace-save-status")).toHaveText("Saved");
  await expect(header.getByRole("button", {name: "Workspace sets"})).toHaveText("Training overview");
  await expect(page.locator(".chart-card").first()).toHaveClass(/wide/);
  await expect(page.getByRole("combobox", {name: "Time range", exact: true})).toHaveValue("604800");
});

test("unsaved workspace switching supports cancel, successful save, and explicit discard", async ({page}) => {
  await mockApi(page); await seed(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".chart-card canvas").first()).toBeVisible();
  await resizeChart(page);
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("button", {name: "Resources", exact: true}).click();
  let prompt = page.getByRole("dialog", {name: "Unsaved changes", exact: true});
  await expect(prompt).toBeVisible();
  await page.screenshot({path: "artifacts/workspace-unsaved-switch.png"});
  await prompt.getByRole("button", {name: "Cancel", exact: true}).click();
  await expect(page.locator(".workspace-picker")).toHaveText("Training overview");
  await expect(page.locator(".chart-card").first()).toHaveClass(/wide/);
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("button", {name: "Resources", exact: true}).click();
  prompt = page.getByRole("dialog", {name: "Unsaved changes", exact: true});
  await prompt.getByRole("button", {name: "Save and continue"}).click();
  await expect(page.locator(".workspace-picker")).toHaveText("Resources");
  await expect(page.locator(".workspace-save-status")).toHaveText("Saved");
  expect((await serverState(page)).workspaces.sets.find(set => set.id === "a")!.panels[0]!.size).toBe("wide");
  await resizeChart(page);
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("button", {name: "Training overview", exact: true}).click();
  await page.getByRole("dialog", {name: "Unsaved changes"}).getByRole("button", {name: "Discard changes"}).click();
  await expect(page.locator(".workspace-picker")).toHaveText("Training overview");
  expect((await serverState(page)).workspaces.sets.find(set => set.id === "b")!.panels[0]!.size).toBe("normal");
});

test("failed save remains unsaved, does not switch or overwrite data, and retry saves the draft", async ({page}) => {
  await mockApi(page); await seed(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".chart-card canvas").first()).toBeVisible();
  await resizeChart(page);
  let denied = true;
  await page.route("**/api/ui/workspaces", route => {
    return denied ? route.fulfill({status: 400, json: {error: "Server rejected the workspace"}}) : route.fallback();
  });
  await page.getByRole("button", {name: "Save current workspace"}).click();
  await expect(page.getByRole("button", {name: "Retry saving workspace"})).toBeVisible();
  expect((await serverState(page)).workspaces.sets.find(set => set.id === "a")!.panels[0]!.size).toBe("normal");
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("button", {name: "Resources", exact: true}).click();
  await page.getByRole("button", {name: "Save and continue"}).click();
  await expect(page.getByRole("dialog", {name: "Unsaved changes"})).toBeVisible();
  await expect(page.locator(".workspace-picker")).toHaveText("Training overview");
  await page.getByRole("button", {name: "Cancel", exact: true}).click();
  await page.screenshot({path: "artifacts/workspace-save-failed.png"});
  denied = false;
  await page.getByRole("button", {name: "Retry saving workspace"}).click();
  await expect(page.locator(".workspace-save-status")).toHaveText("Saved");
});

test("default drafts request a name, section edits are dirty, and active deletion does not lose panels", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".chart-card canvas").first()).toBeVisible();
  await expect(page.locator(".workspace-picker")).toHaveText("Default");
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  await page.getByRole("button", {name: "Save current workspace"}).click();
  await page.getByRole("textbox", {name: "Workspace set name"}).fill("My training workspace");
  await page.getByRole("button", {name: "Save workspace set"}).click();
  await expect(page.locator(".workspace-picker")).toHaveText("My training workspace");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "section");
  await editor.getByRole("textbox", {name: "Panel title"}).fill("Resources");
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  await page.getByRole("button", {name: "Save current workspace"}).click();
  const count = await page.locator(".section-grid .chart-card").count();
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("button", {name: "Delete workspace set My training workspace"}).click();
  await expect(page.locator(".workspace-picker")).toHaveText("Untitled");
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  expect(await page.locator(".section-grid .chart-card").count()).toBe(count);
});

test("header identity and save status remain readable in a narrow dark viewport", async ({page}) => {
  await mockApi(page); await seed(page);
  await page.setViewportSize({width: 320, height: 844});
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".workspace-save-status")).toHaveText("Saved");
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
  await resizeChart(page);
  await expect(page.locator(".workspace-save-status")).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: "artifacts/workspace-header-mobile-dark.png"});
});

test("table paging is transient while search and column changes are unsaved configuration", async ({page}) => {
  await mockApi(page, {tableRows: 200});
  await seedUiState(page, {
    theme: "light", selected: {"experiment-1": "table"},
    sets: [{id: "table", name: "Workers", experimentId: "experiment-1",
      sections: [{id: "initial", name: "", collapsed: false}],
      panels: [{id: "table", sectionId: "initial", kind: "snapshot-table", path: "/tasks", size: "wide"}]}],
  });
  await page.goto("/rvx?runs=run-1&live=0");
  const table = page.locator(".table-card");
  await expect(table.locator("tbody tr")).toHaveCount(75);
  await table.getByRole("button", {name: "Next page"}).click();
  await expect(table.locator(".table-footer")).toContainText("76–150");
  await expect(page.locator(".workspace-save-status")).toHaveText("Saved");
  await table.getByRole("searchbox", {name: "Search table rows"}).fill("worker-00001");
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  await table.getByRole("searchbox", {name: "Search table rows"}).fill("");
  await expect(page.locator(".workspace-save-status")).toHaveText("Saved");
  await table.getByRole("button", {name: "Columns", exact: true}).click();
  await page.getByRole("checkbox", {name: "Show healthy", exact: true}).uncheck();
  await page.getByRole("dialog", {name: "Columns"}).getByRole("button", {name: "Close", exact: true}).click();
  await expect(page.getByRole("button", {name: "Save current workspace"})).toBeVisible();
  await page.getByRole("button", {name: "Save current workspace"}).click();
  await expect(page.locator(".workspace-save-status")).toHaveText("Saved");
});

test("save-and-continue resolves a destination that was overwritten by the user's chosen save name", async ({page}) => {
  await mockApi(page); await seed(page, null);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".section-grid .chart-card")).toHaveCount(6);
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await selectAddType(editor, "section");
  await editor.getByRole("textbox", {name: "Panel title"}).fill("New section");
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await page.getByRole("button", {name: "Resources", exact: true}).click();
  await page.getByRole("button", {name: "Save and continue"}).click();
  await page.getByRole("textbox", {name: "Workspace set name"}).fill("Resources");
  await page.getByRole("button", {name: "Update workspace set"}).click();
  await expect(page.locator(".workspace-picker")).toHaveText("Resources");
  await expect(page.locator(".workspace-save-status")).toHaveText("Saved");
  await expect(page.locator(".section-grid .chart-card")).toHaveCount(6);
  await expect(page.getByRole("button", {name: "New section", exact: true})).toBeVisible();
});
