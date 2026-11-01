import {test, expect} from "@playwright/test";
import {mockApi, seedUiState} from "./fixtures";

test.beforeEach(async ({page}) => {
  await seedUiState(page, {selected: {"experiment-1": "tables"}, sets: [{
    id: "tables", name: "Tables", experimentId: "experiment-1",
    sections: [{id: "main", name: "", collapsed: false}],
    panels: [{id: "tasks", sectionId: "main", kind: "snapshot-table", size: "wide", path: "/tasks"}],
  }]});
});

test("unchanged refreshes retain rows, headers and cells without rewriting cell attributes", async ({page}) => {
  await mockApi(page, {tableRows: 200});
  await page.goto("/rvx?runs=run-1");
  const table = page.locator(".table-card");
  await expect(table.locator("tbody tr")).toHaveCount(75);
  const row = await table.locator("tbody tr").first().elementHandle();
  const header = await table.locator("thead").elementHandle();
  await table.evaluate(node => {
    const body = node.querySelector("tbody")!;
    body.dataset.cellMutations = "0";
    const observer = new MutationObserver(records => {
      const cells = records.filter(record => record.target instanceof HTMLTableCellElement);
      body.dataset.cellMutations = String(Number(body.dataset.cellMutations) + cells.length);
    });
    observer.observe(body, {attributes: true, characterData: true, childList: true, subtree: true});
  });
  const response = page.waitForResponse(response => response.url().endsWith("/api/tables/rows"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await response;
  await expect(table.locator(".chart-status")).toBeHidden();
  await expect(table.locator("tbody")).toHaveAttribute("data-cell-mutations", "0");
  expect(await row!.evaluate(node => node.isConnected && node === node.parentElement?.firstElementChild)).toBe(true);
  expect(await header!.evaluate(node => node.isConnected)).toBe(true);
});

test("live table painting waits for scrolling to settle and retains both scroll positions", async ({page}) => {
  const options = {tableRows: 200, tableVersion: 0};
  await mockApi(page, options);
  await page.goto("/rvx?runs=run-1");
  const table = page.locator(".table-card"), viewport = table.locator(".table-scroll");
  const value = table.locator('tbody tr').first().locator('[data-column="/load"]');
  await expect(value).toHaveText("0");
  await viewport.evaluate(node => {node.scrollLeft = 300; node.scrollTop = 300;});
  const before = await viewport.evaluate(node => ({left: node.scrollLeft, top: node.scrollTop}));
  const row = await table.locator("tbody tr").first().elementHandle();
  await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".table-scroll")!;
    const timer = setInterval(() => viewport.dispatchEvent(new Event("scroll")), 25);
    viewport.dataset.scrollTimer = String(timer);
  });
  options.tableVersion = 1;
  const response = page.waitForResponse(response => response.url().endsWith("/api/tables/rows"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await response;
  await page.waitForTimeout(250);
  await expect(value).toHaveText("0");
  await viewport.evaluate(node => clearInterval(Number((node as HTMLElement).dataset.scrollTimer)));
  await expect(value).toHaveText("10000");
  expect(await viewport.evaluate(node => ({left: node.scrollLeft, top: node.scrollTop}))).toEqual(before);
  expect(await row!.evaluate(node => node.isConnected)).toBe(true);
});

test("horizontal scrolling stays keyboard accessible without a horizontal scrollbar", async ({page}) => {
  await mockApi(page, {tableRows: 200});
  await page.goto("/rvx?runs=run-1");
  const viewport = page.locator(".table-scroll");
  await expect(page.locator(".table-card tbody tr")).toHaveCount(75);
  await expect(viewport).toHaveCSS("overflow-x", "auto");
  expect(await viewport.evaluate(node => getComputedStyle(node, "::-webkit-scrollbar").height)).toBe("0px");
  expect(await viewport.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await viewport.evaluate(node => {
    const style = getComputedStyle(node);
    return node.offsetHeight - node.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
  })).toBe(0);
  await viewport.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => viewport.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
});
