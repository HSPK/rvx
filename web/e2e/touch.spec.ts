import {test, expect} from "@playwright/test";
import {exactId, mockApi, selectedObservation} from "./fixtures";

test.use({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});

test("touch taps select a real observation and preserve native Run comparison", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const original = await chart.locator("canvas").elementHandle();
  const overlay = (await chart.locator(".u-over").boundingBox())!;
  await chart.locator(".u-over").tap({position: {x: overlay.width * .25, y: overlay.height * .5}});
  const selected = selectedObservation(chart);
  await expect(selected).not.toHaveAttribute("data-snapshot-id", exactId);
  const id = await selected.getAttribute("data-snapshot-id");
  expect(id).toMatch(/^\d+$/);
  await expect(chart.locator(".chart-zoom-state")).toBeHidden();
  await expect(chart.getByRole("tooltip")).toBeVisible();
  await page.locator(".run-chip").getByRole("button", {name: /^Run details/}).tap();
  const drawer = page.getByRole("dialog", {name: "Run details", exact: true});
  await expect(drawer.getByRole("heading", {name: "Configuration", exact: true})).toBeVisible();
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
  await drawer.getByRole("button", {name: "Close", exact: true}).tap();
  await page.getByRole("button", {name: "Select runs (1 selected)"}).tap();
  const sheet = page.getByRole("dialog", {name: "Runs", exact: true});
  await sheet.getByRole("checkbox", {name: "Select grpo · baseline"}).tap();
  await sheet.getByRole("button", {name: "Close", exact: true}).tap();
  await expect(chart.locator(".legend-item")).toHaveCount(2);
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await page.screenshot({path: "artifacts/touch-native-comparison.png"});
});

test("vertical swipes scroll only the chart region without creating a zoom", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const range = await chart.locator(".chart-host").getAttribute("aria-description");
  const box = (await chart.locator(".u-over").boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2, y = box.y + box.height * .8;
  await session.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y}]});
  for (let step = 1; step <= 5; step++) {
    await session.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x, y: y - step * 30}]});
    await page.waitForTimeout(20);
  }
  await session.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
  await expect.poll(() => page.locator(".chart-scroll").evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await expect(chart.locator(".chart-zoom-state")).toBeHidden();
  await expect(chart.getByRole("tooltip")).toBeHidden();
  await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", range!);
  await session.detach();
});
