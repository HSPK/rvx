import {test, expect} from "@playwright/test";
import {mockApi, seedUiState} from "./fixtures";

test("React record controls preserve exact cells through decimal display, sorting, filters and page export", async ({page}) => {
  await mockApi(page, {tableRows: 200});
  await seedUiState(page, {selected: {"experiment-1": "records"}, sets: [{
    id: "records", name: "Records", experimentId: "experiment-1",
    sections: [{id: "main", name: "", collapsed: false}],
    panels: [{id: "records", sectionId: "main", kind: "snapshot-table", size: "wide", path: "/tasks"}],
  }]});
  await page.goto("/rvx?runs=run-1&live=0");
  const card = page.locator('.section-grid .table-card');
  await expect(card.locator("tbody tr")).toHaveCount(75);
  const counter = card.locator("tbody tr").first().locator('[data-column="/counter"]');
  await expect(counter).toHaveText("18446744073709551615");
  await card.getByRole("button", {name: "Columns", exact: true}).click();
  await expect(page.getByRole("dialog", {name: "Columns", exact: true}).getByRole("heading", {name: "Columns", exact: true})).not.toBeVisible();
  await page.getByRole("combobox", {name: "Decimal places for counter"}).click();
  await page.getByRole("option", {name: "2", exact: true}).click();
  await page.getByRole("button", {name: "Close", exact: true}).click();
  await expect(counter).toHaveText("18446744073709551615.00");
  const csv = page.waitForEvent("download");
  await card.getByRole("button", {name: "Export page CSV"}).click();
  expect((await csv).suggestedFilename()).toBe("rvx-table-page.csv");
  const response = page.waitForRequest(request => request.url().endsWith("/api/tables/rows") && request.postDataJSON().sort?.path === "/counter");
  await card.getByRole("button", {name: "counter", exact: true}).click();
  expect((await response).postDataJSON().sort).toEqual({path: "/counter", direction: "asc"});
  await card.getByRole("button", {name: "Filter", exact: true}).click();
  await page.getByRole("combobox", {name: "Filter column"}).click();
  await page.getByRole("option", {name: "name", exact: true}).click();
  await page.getByRole("textbox", {name: "Filter value"}).fill("worker");
  const filterRequest = page.waitForRequest(request => request.url().endsWith("/api/tables/rows") && request.postDataJSON().filters?.length === 1);
  await page.getByRole("button", {name: "Add filter", exact: true}).click();
  expect((await filterRequest).postDataJSON().filters).toEqual([{path: "/name", op: "contains", value: "worker"}]);
  await expect(card.getByRole("button", {name: "Filter (1)", exact: true})).toBeVisible();
  await card.getByRole("button", {name: "Filter (1)", exact: true}).click();
  await page.getByRole("tab", {name: "Groups", exact: true}).click();
  await page.getByRole("button", {name: "Add filter group", exact: true}).click();
  await page.getByRole("textbox", {name: "Group name"}).fill("Health");
  await page.getByRole("combobox", {name: "Group column"}).click();
  await page.getByRole("option", {name: "healthy", exact: true}).click();
  await page.getByRole("combobox", {name: "Group display"}).click();
  await page.getByRole("option", {name: "Radio group", exact: true}).click();
  await page.getByRole("textbox", {name: "Option value 1", exact: true}).fill("true");
  await page.getByRole("textbox", {name: "Option label 1", exact: true}).fill("Healthy");
  await page.getByRole("button", {name: "Save group", exact: true}).click();
  await page.getByRole("button", {name: "Close", exact: true}).click();
  await expect(card.getByRole("radio", {name: "All", exact: true})).toBeChecked();
  const groupedRequest = page.waitForRequest(request => request.url().endsWith("/api/tables/rows") && request.postDataJSON().filters?.length === 2);
  await card.getByRole("radio", {name: "Healthy", exact: true}).click();
  expect((await groupedRequest).postDataJSON().filters).toEqual([
    {path: "/name", op: "contains", value: "worker"}, {path: "/healthy", op: "eq", value: "true"},
  ]);
  await expect(card.getByRole("radio", {name: "Healthy", exact: true})).toBeChecked();
});
