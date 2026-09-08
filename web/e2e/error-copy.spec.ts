import {test, expect} from "@playwright/test";
import {mockApi} from "./fixtures";

test("native JSON errors show readable details rather than their transport wrapper", async ({page}) => {
  await mockApi(page);
  await page.route("**/api/snapshots/query", route => route.fulfill({
    status: 400, json: {error: "Snapshot query scan budget exceeded; choose a narrower time range."},
  }));
  await page.goto("/rvx?runs=run-1&live=0");
  const card = page.locator(".chart-card").first();
  await expect(card.locator(".chart-status")).toHaveText("Request failed");
  await expect(card.locator(".chart-empty")).toHaveText("Request failed (400): Snapshot query scan budget exceeded; choose a narrower time range.");
  await expect(card.locator(".chart-footer,.point-readout")).toHaveCount(0);
  await expect(card.getByRole("button", {name: "Retry", exact: true})).toBeVisible();
  await expect(card).not.toContainText('{"error"');
});

test("structured error text is never interpreted as HTML", async ({page}) => {
  await mockApi(page);
  await page.route("**/api/charts/catalog", route => route.fulfill({
    status: 503, json: {error: "<img src=x onerror=window.__errorInjected=true> Unavailable"},
  }));
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.getByRole("heading", {name: "Could not load panels"})).toBeVisible();
  await expect(page.locator(".chart-grid img")).toHaveCount(0);
  expect(await page.evaluate(() => Object.hasOwn(window, "__errorInjected"))).toBe(false);
});
