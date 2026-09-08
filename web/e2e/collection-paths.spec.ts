import {test, expect} from "@playwright/test";
import {mockApi} from "./fixtures";
import type {TableCatalogResponse} from "../src/domain/tables";

test("Add shows complete collection paths for unique and duplicate names without relying on hover", async ({page}) => {
  await mockApi(page, {tableRows: 2});
  await page.goto("/rvx?runs=run-1");
  const catalog: TableCatalogResponse = await page.evaluate(async () => (await fetch("/api/tables/catalog", {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({run_ids: ["run-1"]}),
  })).json());
  const paths = ["/collectors/actors/document/workloads", "/collectors/evaluator/document/workloads",
    `/collectors/${"long_namespace_".repeat(12)}/document/records`, "/metrics/foo~1bar"];
  await page.route("**/api/tables/catalog", route => route.fulfill({json: {
    tables: [...paths.map(path => ({...catalog.tables[0]!, path, name: path.slice(1)})),
      catalog.tables.find(table => table.path === "")!], truncated: false,
  }}));
  const selected: string[] = [];
  await page.route("**/api/tables/rows", route => {
    const body = route.request().postDataJSON(); selected.push(body.path);
    return route.fallback({postData: JSON.stringify({...body, path: "/tasks"})});
  });
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await editor.getByRole("tab", {name: "Snapshot", exact: true}).click();
  for (const path of paths) {
    const option = editor.locator(`.collection-option[data-path="${path}"]`);
    await expect(option.locator(".collection-path")).toHaveText(path);
    await expect(option.locator(".collection-count")).toHaveText("2 rows");
  }
  await expect(editor.locator('.collection-option[data-path=""] .collection-path')).toHaveText("(root)");
  const search = editor.getByRole("searchbox", {name: "Search collections"});
  await search.fill("/collectors/evaluator");
  await expect(editor.locator(".collection-option")).toHaveCount(1);
  await editor.locator(".collection-option").click();
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(2);
  expect(selected.at(-1)).toBe(paths[1]);
  await search.fill("");
  await page.screenshot({path: "artifacts/collection-paths-desktop.png"});
  await editor.locator(`.collection-option[data-path="${paths[2]}"]`).scrollIntoViewIfNeeded();
  const code = editor.locator(`.collection-option[data-path="${paths[2]}"] .collection-path`);
  expect(await code.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({path: "artifacts/collection-paths-long.png"});
  await page.setViewportSize({width: 390, height: 844});
  await search.fill("workloads");
  await expect(editor.locator(".collection-option")).toHaveCount(2);
  expect(await editor.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({path: "artifacts/collection-paths-mobile.png"});
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  await expect(page.locator(`.section-grid .table-card[data-path="${paths[1]}"]`)).toHaveCount(1);
});
