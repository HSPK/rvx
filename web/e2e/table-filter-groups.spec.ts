import {expectControlValue, selectOption} from "./react-controls";
import {test, expect, type Locator, type Page} from "@playwright/test";
import {firstObservation, mockApi, seedUiState, serverState} from "./fixtures";
import type {TableFilterGroup} from "../src/app/panels";
import type {TableFilter} from "../src/domain/tables";

async function fixture(page: Page, filterGroups: TableFilterGroup[] = []) {
  await mockApi(page);
  const filters: TableFilter[][] = [];
  const source = {run_id: "run-1", source_id: "run-1-source-0", snapshot_id: "1", label: "Learner", role: "learner",
    rank: 0, node_id: "node-a", observed_at_ns: firstObservation, row_count: 5};
  const columns = ["$key", "/status", "/queue"].map(path => ({path, name: path === "$key" ? "Key" : path.slice(1)}));
  await page.route("**/api/tables/catalog", route => route.fulfill({json: {tables: [{path: "/tasks", name: "Tasks", columns, sources: [source]}], truncated: false}}));
  await page.route("**/api/tables/rows", route => {
    const body = route.request().postDataJSON(); filters.push(body.filters);
    const rows = [["running", "b01"], ["queued", "b01"], ["running", "b04"], ["failed", "b04"], ["completed", "b01"]].map(([status, queue], index) => ({
      run_id: "run-1", source_id: source.source_id, snapshot_id: "1", row_key: String(index),
      cells: Object.fromEntries([["$key", String(index)], ["/status", status], ["/queue", queue]].map(([path, text]) => [path, {kind: "string", text, truncated: false}])),
    })).filter(row => body.filters.every((filter: TableFilter) => row.cells[filter.path]?.text === filter.value));
    return route.fulfill({json: {columns, snapshots: [source], rows: rows.slice(body.offset, body.offset + body.limit), total: rows.length, offset: body.offset, limit: body.limit}});
  });
  await seedUiState(page, {selected: {"experiment-1": "filters"}, sets: [{
    id: "filters", name: "Tasks", experimentId: "experiment-1", sections: [{id: "main", name: "", collapsed: false}],
    panels: [{kind: "snapshot-table", id: "table", sectionId: "main", size: "wide", path: "/tasks", query: {filterGroups}}],
  }]});
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".table-card tbody tr")).toHaveCount(5);
  return filters;
}

async function group(modal: Locator, name: string, path: string, display: string, values: string[]) {
  await modal.getByRole("tab", {name: "Groups", exact: true}).click();
  await modal.getByRole("button", {name: "Add filter group", exact: true}).click();
  await modal.getByRole("textbox", {name: "Group name", exact: true}).fill(name);
  await selectOption(modal.getByRole("combobox", {name: "Group column", exact: true}), path);
  await selectOption(modal.getByRole("combobox", {name: "Group display", exact: true}), display);
  for (const [index, value] of values.entries()) {
    if (index) await modal.getByRole("button", {name: "Add option", exact: true}).click();
    await modal.getByRole("textbox", {name: `Option value ${index + 1}`, exact: true}).fill(value);
    await modal.getByRole("textbox", {name: `Option label ${index + 1}`, exact: true}).fill(value.toUpperCase());
  }
  await modal.getByRole("button", {name: "Save group", exact: true}).click();
  await expect(modal.getByRole("textbox", {name: "Group name", exact: true})).toHaveCount(0);
}

test("custom Status radio and Queue dropdown AND their filters and survive workspace save/reload", async ({page}) => {
  const requests = await fixture(page), card = page.locator(".table-card");
  await card.getByRole("button", {name: "Filter", exact: true}).click();
  const modal = page.getByRole("dialog", {name: "Filter rows", exact: true});
  await group(modal, "Status", "/status", "radio", ["running", "queued", "failed", "completed"]);
  await group(modal, "Queue", "/queue", "select", ["b01", "b04"]);
  await modal.getByRole("button", {name: "Close", exact: true}).click();
  const status = card.getByRole("radiogroup", {name: "Status", exact: true}), queue = card.getByRole("combobox", {name: "Queue", exact: true});
  await status.getByRole("radio", {name: "RUNNING", exact: true}).check();
  const checked = status.getByRole("radio", {name: "RUNNING", exact: true});
  expect(await checked.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await expect(checked).toHaveCSS("box-shadow", "none");
  await expect(checked.locator("span")).toHaveCSS("box-shadow", "none");
  await expect(card.locator(".filter-group-separator")).toHaveText("\uFF5C");
  await expect(card.locator("tbody tr")).toHaveCount(2);
  await selectOption(queue, "b01");
  await expect(card.locator("tbody tr")).toHaveCount(1);
  expect(requests.at(-1)).toEqual([{path: "/status", op: "eq", value: "running"}, {path: "/queue", op: "eq", value: "b01"}]);
  await page.getByRole("button", {name: "Save current workspace", exact: true}).click();
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  const saved = (await serverState(page)).workspaces.sets[0]!.panels[0]!;
  expect(saved.kind !== "chart" && saved.query?.filterGroups?.map(group => group.selected)).toEqual(["running", "b01"]);
  await page.reload(); await expect(card.locator("tbody tr")).toHaveCount(1);
  await expect(status.getByRole("radio", {name: "RUNNING", exact: true})).toBeChecked();
  await expectControlValue(queue, "b01");
  await selectOption(queue, ""); await expect(card.locator("tbody tr")).toHaveCount(2);
  await status.getByRole("radio", {name: "All", exact: true}).check(); await expect(card.locator("tbody tr")).toHaveCount(5);
  for (const width of [390, 320]) {
    await page.setViewportSize({width, height: 844});
    expect(await card.locator(".table-tools").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(status.getByRole("radio", {name: "COMPLETED", exact: true})).toBeVisible();
    await card.getByRole("button", {name: "Filter", exact: true}).click();
    await modal.getByRole("tab", {name: "Groups", exact: true}).click();
    await modal.getByRole("button", {name: "Edit filter group Status", exact: true}).click();
    await modal.getByRole("button", {name: "Save group", exact: true}).scrollIntoViewIfNeeded();
    await expect(modal.getByRole("button", {name: "Save group", exact: true})).toBeInViewport({ratio: 1});
    await modal.getByRole("button", {name: "Cancel group", exact: true}).click();
    await modal.getByRole("button", {name: "Done", exact: true}).scrollIntoViewIfNeeded();
    await expect(modal.getByRole("button", {name: "Done", exact: true})).toBeInViewport({ratio: 1});
    await modal.getByRole("button", {name: "Done", exact: true}).click();
  }
});

test("group editing rejects duplicate values, clears removed selections and removes toolbar filters", async ({page}) => {
  await fixture(page, [{id: "queue", name: "Queue", path: "/queue", display: "select", options: [{label: "B01", value: "b01"}, {label: "B04", value: "b04"}]}]);
  const card = page.locator(".table-card"), queue = card.getByRole("combobox", {name: "Queue", exact: true});
  await selectOption(queue, "b01"); await expect(card.locator("tbody tr")).toHaveCount(3);
  await card.getByRole("button", {name: "Filter (1)", exact: true}).click();
  const modal = page.getByRole("dialog", {name: "Filter rows", exact: true});
  await modal.getByRole("tab", {name: "Groups", exact: true}).click();
  await modal.getByRole("button", {name: "Edit filter group Queue", exact: true}).click();
  await modal.getByRole("textbox", {name: "Option value 2", exact: true}).fill("b01");
  await modal.getByRole("button", {name: "Save group", exact: true}).click();
  await expect(modal.locator(".filter-group-editor [role=alert]")).toContainText("unique");
  await modal.getByRole("button", {name: "Delete option 1", exact: true}).click();
  await modal.getByRole("textbox", {name: "Option value 1", exact: true}).fill("b04");
  await modal.getByRole("button", {name: "Save group", exact: true}).click();
  await expect(card.locator("tbody tr")).toHaveCount(5);
  await expectControlValue(card.getByRole("combobox", {name: "Queue", exact: true, includeHidden: true}), "");
  await modal.getByRole("button", {name: "Delete filter group Queue", exact: true}).click();
  await modal.getByRole("button", {name: "Close", exact: true}).click();
  await expect(queue).toHaveCount(0);
  await expect(card.getByRole("button", {name: "Filter", exact: true})).toBeVisible();
});

test("filter tabs keep unfinished conditions and groups separate and retain drafts across keyboard navigation", async ({page}) => {
  const requests = await fixture(page), card = page.locator(".table-card");
  await card.getByRole("button", {name: "Filter", exact: true}).click();
  const modal = page.getByRole("dialog", {name: "Filter rows", exact: true});
  const conditions = modal.getByRole("tab", {name: "Conditions", exact: true}), groups = modal.getByRole("tab", {name: "Groups", exact: true});
  const value = modal.getByRole("textbox", {name: "Filter value", exact: true});
  await expect(conditions).toHaveAttribute("aria-selected", "true");
  await expect(modal.getByRole("button", {name: "Add filter group", exact: true})).toBeHidden();
  await selectOption(modal.getByRole("combobox", {name: "Filter column", exact: true}), "/status");
  await selectOption(modal.getByRole("combobox", {name: "Filter operation", exact: true}), "eq");
  await value.fill("running");
  const reads = requests.length;
  await conditions.focus(); await page.keyboard.press("ArrowRight");
  await expect(groups).toBeFocused(); await expect(groups).toHaveAttribute("aria-selected", "true");
  await expect(value).toBeHidden();
  await modal.getByRole("button", {name: "Add filter group", exact: true}).click();
  await modal.getByRole("textbox", {name: "Group name", exact: true}).fill("Queue");
  await selectOption(modal.getByRole("combobox", {name: "Group column", exact: true}), "/queue");
  await modal.getByRole("textbox", {name: "Option value 1", exact: true}).fill("b01");
  for (const [index, option] of ["b04", "b07", "b12"].entries()) {
    await modal.getByRole("button", {name: "Add option", exact: true}).click();
    await modal.getByRole("textbox", {name: `Option value ${index + 2}`, exact: true}).fill(option);
  }
  await groups.focus(); await page.keyboard.press("Home");
  await expect(conditions).toBeFocused(); await expectControlValue(value, "running");
  await page.keyboard.press("End");
  await expectControlValue(modal.getByRole("textbox", {name: "Group name", exact: true}), "Queue");
  await expectControlValue(modal.getByRole("textbox", {name: "Option value 1", exact: true}), "b01");
  for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}, {width: 320, height: 568}]) {
    await page.setViewportSize(viewport);
    expect(await modal.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(modal.getByRole("button", {name: "Save group", exact: true})).toBeInViewport();
  }
  expect(requests).toHaveLength(reads);
  await modal.getByRole("button", {name: "Save group", exact: true}).click();
  await conditions.click();
  await expectControlValue(value, "running");
  await modal.getByRole("button", {name: "Add filter", exact: true}).click();
  await expect(card.locator("tbody tr")).toHaveCount(2);
  await expect(card.getByRole("combobox", {name: "Queue", exact: true})).toBeVisible();
  expect(requests.at(-1)).toEqual([{path: "/status", op: "eq", value: "running"}]);
});
