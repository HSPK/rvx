import {test, expect} from "@playwright/test";
import {mockApi} from "./fixtures";

test.use({timezoneId: "UTC"});

test("opening and applying an unchanged preset retains its live window and zoom", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&range=3600&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const box = (await chart.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + 35); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 25, box.y + 35, {steps: 4}); await page.mouse.up();
  const zoom = await chart.locator(".chart-host").getAttribute("aria-description");
  const range = page.getByRole("combobox", {name: "Time range", exact: true});
  await range.selectOption("custom");
  const settings = page.getByRole("dialog", {name: "Time settings"});
  await expect(settings.getByLabel("From (elapsed)")).toHaveValue("1h 59m");
  await expect(settings.getByLabel("To (elapsed)")).toHaveValue("2h 59m");
  await settings.getByRole("button", {name: "Apply time settings"}).click();
  await expect(range).toHaveValue("3600");
  await expect(chart.locator(".chart-host")).toHaveAttribute("aria-description", zoom!);
});

test("every range preset and human elapsed bounds keep native multi-run coordinates", async ({page}) => {
  const requests = await mockApi(page);
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  const range = page.getByRole("combobox", {name: "Time range", exact: true});
  expect(await range.locator("option").allTextContents()).toEqual(["15m", "1h", "6h", "24h", "3d", "7d", "All", "Custom…"]);
  for (const value of ["900", "3600", "21600", "86400", "259200", "604800", "all"]) {
    await range.selectOption(value);
    const expectedFrom = value === "all" ? undefined : Math.max(0, 10740e9 - Number(value) * 1e9);
    if (value === "all") {
      expect(requests.some(request => request.path === "/api/snapshots/query" && request.body?.from === undefined && request.body?.to === undefined)).toBe(true);
    } else {
      await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body?.from).toBe(expectedFrom);
    }
    await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body?.axis).toBe("elapsed");
    expect(new URL(page.url()).searchParams.get("range")).toBe(value);
  }
  await range.selectOption("custom");
  const settings = page.getByRole("dialog", {name: "Time settings"});
  await settings.getByLabel("From (elapsed)").fill("1h 15m");
  await settings.getByLabel("To (elapsed)").fill("2h");
  await settings.getByRole("button", {name: "Apply time settings"}).click();
  await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body?.from).toBe(4500e9);
  expect(requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body?.to).toBe(7200e9);
  await range.selectOption("custom");
  await expect(settings.getByLabel("From (elapsed)")).toHaveValue("1h 15m");
  await settings.getByLabel("To (elapsed)").fill("1h");
  await settings.getByRole("button", {name: "Apply time settings"}).click();
  await expect(settings.getByRole("alert")).toHaveText("The end must not be before the start.");
  await settings.getByLabel("To (elapsed)").fill("five minutes");
  await settings.getByRole("button", {name: "Apply time settings"}).click();
  await expect(settings.getByRole("alert")).toContainText("Use a duration");
  await settings.getByLabel("From (elapsed)").fill("0");
  await settings.getByLabel("To (elapsed)").fill("30m");
  await page.screenshot({path: "artifacts/human-elapsed-range.png"});
  await settings.getByRole("button", {name: "Apply time settings"}).click();
  await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body?.from).toBe(0);
  await range.selectOption("custom");
  await settings.getByLabel("From (elapsed)").fill("");
  await settings.getByLabel("To (elapsed)").fill("");
  await settings.getByRole("button", {name: "Apply time settings"}).click();
  await expect(range).toHaveValue("all");
  await page.getByRole("button", {name: "Workspace sets"}).click();
  await expect(page.getByRole("dialog", {name: "Workspace sets"}).getByRole("button", {name: /time/i})).toHaveCount(0);
});

test("local date controls submit wall time and preserve unchanged subsecond URL bounds", async ({page}) => {
  const requests = await mockApi(page);
  const original = Date.UTC(2026, 8, 5, 8, 0, 0) * 1e6 + 123456000;
  await page.goto(`/rvx?runs=run-1&axis=wall_time&range=custom&from=${original}&live=0`);
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  const range = page.getByRole("combobox", {name: "Time range", exact: true});
  await range.selectOption("custom");
  const settings = page.getByRole("dialog", {name: "Time settings"});
  await expect(settings.getByLabel("From (local time)")).toHaveValue("2026-09-05T08:00");
  await settings.getByRole("button", {name: "Apply time settings"}).click();
  expect(new URL(page.url()).searchParams.get("from")).toBe(String(original));
  await range.selectOption("custom");
  await settings.getByLabel("From (local time)").fill("2026-09-05T08:30:15");
  await settings.getByLabel("To (local time)").fill("2026-09-05T09:30:15");
  await page.screenshot({path: "artifacts/human-wall-range.png"});
  await settings.getByRole("button", {name: "Apply time settings"}).click();
  await expect.poll(() => requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body?.from).toBe(Date.UTC(2026, 8, 5, 8, 30, 15) * 1e6);
  expect(requests.filter(request => request.path === "/api/snapshots/query").at(-1)?.body?.axis).toBe("wall_time");
});

test("nonexistent daylight-saving times and rounded logical integers fail explicitly", async ({browser}) => {
  const context = await browser.newContext({baseURL: test.info().project.use.baseURL, timezoneId: "America/New_York", viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  try {
    await mockApi(page);
    await page.goto("/rvx?runs=run-1");
    await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
    await page.getByRole("combobox", {name: "Time range", exact: true}).selectOption("custom");
    const settings = page.getByRole("dialog", {name: "Time settings"});
    const alignment = settings.getByRole("combobox", {name: "Alignment", exact: true});
    await alignment.selectOption("wall_time");
    await settings.getByLabel("From (local time)").fill("2026-03-08T02:30");
    await settings.getByRole("button", {name: "Apply time settings"}).click();
    await expect(settings.getByRole("alert")).toHaveText("This local date or time does not exist.");
    await alignment.selectOption("optimizer_step");
    await settings.getByLabel("From (Optimizer step)").fill("9007199254740993");
    await settings.getByRole("button", {name: "Apply time settings"}).click();
    await expect(settings.getByRole("alert")).toContainText("too precise");
    await settings.getByLabel("From (Optimizer step)").fill("100");
    await settings.getByLabel("To (Optimizer step)").fill("600");
    await page.screenshot({path: "artifacts/human-logical-range-mobile.png"});
    await settings.getByRole("button", {name: "Apply time settings"}).click();
    await expect(page.getByRole("combobox", {name: "Time range", exact: true})).toHaveValue("custom");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {await context.close();}
});
