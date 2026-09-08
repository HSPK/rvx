import {test, expect} from "@playwright/test";
import {mockApi} from "./fixtures";

test("an empty registry explains setup and refreshes into native Run selection", async ({page}) => {
  const requests = await mockApi(page);
  let ready = false, hold = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  for (const collection of ["projects", "experiments", "runs"]) {
    await page.route(`**/api/experiments/${collection}`, async route => {
      if (hold) await gate;
      return ready ? route.fallback() : route.fulfill({json: {[collection]: []}});
    });
  }
  try {
    await page.goto("/rvx?runs=");
    const empty = page.locator(".selection-empty");
    await expect(empty.getByRole("heading", {name: "No runs yet", exact: true})).toBeVisible();
    await expect(empty).toContainText("RVX CLI");
    await expect(empty.getByRole("button", {name: "Choose runs", exact: true})).toHaveCount(0);
    expect(requests.some(request => request.path === "/api/charts/catalog")).toBe(false);
    await page.setViewportSize({width: 390, height: 844});
    await page.screenshot({path: "artifacts/first-use-mobile.png"});
    ready = true; hold = true;
    const refresh = empty.getByRole("button", {name: "Refresh runs", exact: true});
    await refresh.click();
    await expect(refresh).toBeDisabled();
    release();
    await expect(empty.getByRole("heading", {name: "Select runs", exact: true})).toBeVisible();
    await page.getByRole("button", {name: "Select runs (0 selected)"}).click();
    const sheet = page.getByRole("dialog", {name: "Runs", exact: true});
    await sheet.getByRole("checkbox", {name: "Select grpo · warm-start"}).check();
    await sheet.getByRole("button", {name: "Close", exact: true}).click();
    await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/rvx");
  } finally {release();}
});

test("unknown selections and empty filters are not mistaken for an unconfigured registry", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?project=missing-project");
  await expect(page.locator(".selection-empty").getByRole("heading", {name: "Select runs", exact: true})).toBeVisible();
  await expect(page.locator(".selection-empty")).not.toContainText("RVX CLI");
  await page.route("**/api/experiments/runs", route => route.fulfill({json: {runs: []}}));
  await page.goto("/rvx?runs=deleted-run");
  await expect(page.locator(".selection-empty").getByRole("heading", {name: "Selected runs unavailable", exact: true})).toBeVisible();
});
