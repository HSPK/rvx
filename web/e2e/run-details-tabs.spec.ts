import {test, expect} from "@playwright/test";
import {readFile} from "node:fs/promises";
import {mockApi, runs} from "./fixtures";

test("Run details show registry metadata and exact config without changing selected Runs or fetching snapshots", async ({page}) => {
  const requests = await mockApi(page);
  const config = '{"batch_size":128,"seed":18446744073709551615,"model":"demo","literal":"<script>not executable</script>"}';
  await page.route("**/api/experiments/runs", route => route.fulfill({json: {runs: runs.map(run => run.id === "run-1" ? {...run, config_json: config} : run)}}));
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  const canvas = await chart.locator("canvas").elementHandle(), url = page.url();
  const opener = page.locator(".runs-selector").getByRole("button", {name: "Run details for grpo · warm-start", exact: true});
  await page.locator('.run-row[data-run-id="run-1"]').hover();
  await opener.click();
  const drawer = page.getByRole("dialog", {name: "Run details", exact: true});
  await expect(drawer.getByRole("heading", {name: "grpo · warm-start", exact: true})).toBeVisible();
  await expect(drawer.locator(".run-detail-fields")).toContainText("Reasoning models");
  await expect(drawer.locator(".run-detail-fields")).toContainText("GRPO research");
  await expect(drawer.locator(".run-detail-id")).toHaveText("run-1");
  await expect(drawer.locator(".run-config-json")).toContainText('"seed": 18446744073709551615');
  await expect(drawer.locator(".run-config-json script")).toHaveCount(0);
  const downloadEvent = page.waitForEvent("download");
  await drawer.getByRole("button", {name: "Download JSON", exact: true}).click();
  const download = await downloadEvent;
  expect(await readFile((await download.path())!, "utf8")).toBe(config);
  await page.screenshot({path: "artifacts/run-details-config.png"});
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  expect(page.url()).toBe(url);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.locator(".run-checkbox:checked")).toHaveCount(2);
  await page.locator('.run-chip[data-run-id="run-1"]').getByRole("button", {name: "Run details for grpo · warm-start", exact: true}).click();
  await expect(drawer).toBeVisible();
  expect(requests.some(request => /^\/api\/snapshots\/\d+$/.test(request.path))).toBe(false);
  await expect(page.getByRole("menuitem", {name: /Inspect/, includeHidden: true})).toHaveCount(0);
});

test("mobile Run details return to the shared selector without toggling the inspected Run", async ({page}) => {
  await mockApi(page);
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/rvx?runs=run-1&live=0");
  await page.getByRole("button", {name: /^Select runs/}).click();
  const sheet = page.getByRole("dialog", {name: "Runs", exact: true});
  await sheet.locator('.run-row[data-run-id="run-2"]').hover();
  await sheet.getByRole("button", {name: "Run details for grpo · baseline", exact: true}).click();
  const drawer = page.getByRole("dialog", {name: "Run details", exact: true});
  await expect(drawer).toBeVisible();
  const box = (await drawer.boundingBox())!;
  expect(box.x).toBe(0); expect(box.width).toBe(390); expect(box.height).toBe(844);
  await page.screenshot({path: "artifacts/run-details-mobile.png"});
  await page.keyboard.press("Escape");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("checkbox", {name: "Select grpo · baseline", exact: true})).not.toBeChecked();
  await expect(sheet.getByRole("checkbox", {name: "Select grpo · warm-start", exact: true})).toBeChecked();
});

test("large configurations remain bounded while downloading the full original JSON", async ({page}) => {
  await mockApi(page);
  const config = JSON.stringify({long_text: "configuration ".repeat(10000)});
  await page.route("**/api/experiments/runs", route => route.fulfill({json: {runs: [{...runs[0]!, config_json: config}]}}));
  await page.goto("/rvx?runs=run-1&live=0");
  await page.locator(".run-chip").getByRole("button", {name: /^Run details/}).click();
  const drawer = page.getByRole("dialog", {name: "Run details", exact: true});
  await expect(drawer.getByRole("status")).toContainText("limited preview");
  expect((await drawer.locator(".run-config-json").textContent())!.length).toBeLessThanOrEqual(65536);
  const pending = page.waitForEvent("download");
  await drawer.getByRole("button", {name: "Download JSON"}).click();
  expect(await readFile((await (await pending).path())!, "utf8")).toBe(config);
});

test("wide-screen virtual Run selector stays flush left and allows details at the selection limit", async ({page}) => {
  await mockApi(page, {runCount: 50000});
  await page.setViewportSize({width: 2560, height: 1080});
  await page.goto("/rvx?runs=large-0,large-1,large-2,large-3&live=0");
  await expect(page.locator(".chart-card canvas").first()).toBeVisible();
  expect((await page.locator(".runs-dock").boundingBox())!.x).toBe(0);
  expect(await page.locator(".run-row").count()).toBeLessThanOrEqual(32);
  const row = page.locator('.run-row[data-run-id="large-4"]');
  await expect(row.getByRole("checkbox")).toBeDisabled();
  await row.hover();
  await row.getByRole("button", {name: /^Run details/}).click();
  await expect(page.getByRole("dialog", {name: "Run details"})).toContainText("training-00004");
  await page.keyboard.press("Escape");
  await expect(page.locator(".run-checkbox:checked")).toHaveCount(4);
  await page.screenshot({path: "artifacts/wide-run-list-left.png"});
});

test("Add types are keyboard-operable tabs with one active panel and no type dropdown", async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".chart-card canvas").first()).toBeVisible();
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await expect(editor.getByRole("combobox", {name: "Add type"})).toHaveCount(0);
  await expect(editor.getByRole("tab")).toHaveCount(4);
  await expect(editor.getByRole("tab", {name: "Chart", exact: true})).toHaveAttribute("aria-selected", "true");
  await editor.getByRole("checkbox", {name: "Select metric Policy loss", exact: true}).check();
  await editor.getByRole("tab", {name: "Chart", exact: true}).focus();
  await page.keyboard.press("ArrowRight");
  await expect(editor.getByRole("tab", {name: "Metric table", exact: true})).toHaveAttribute("aria-selected", "true");
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await expect(editor.getByRole("tab", {name: "Snapshot", exact: true})).toHaveAttribute("aria-selected", "true");
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(75);
  await page.keyboard.press("End");
  await expect(editor.getByRole("tab", {name: "Section", exact: true})).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  const active = editor.getByRole("tab", {name: "Chart", exact: true});
  await expect(active).toHaveAttribute("aria-selected", "true");
  await expect(editor.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", (await active.getAttribute("id"))!);
  await expect(editor.getByRole("checkbox", {name: "Select metric Policy loss", exact: true})).toBeChecked();
  await page.screenshot({path: "artifacts/add-type-tabs-desktop.png"});
  await editor.getByRole("button", {name: "Cancel"}).click();
  await expect(page.locator(".section-grid .chart-card")).toHaveCount(6);
});

test("all Add tabs remain usable on a short narrow viewport without underlines or clipped actions", async ({page}) => {
  await mockApi(page);
  await page.setViewportSize({width: 320, height: 640});
  await page.goto("/rvx?runs=run-1&live=0");
  await page.getByRole("button", {name: "Switch to dark appearance"}).click();
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  for (const name of ["Chart", "Metric table", "Snapshot", "Section"]) {
    const tab = editor.getByRole("tab", {name, exact: true});
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab).toHaveCSS("box-shadow", "none");
    await editor.getByRole("textbox", {name: "Panel title"}).fill("Example");
    await expect(editor.getByRole("button", {name: "Cancel"})).toBeVisible();
    const action = (await editor.getByRole("button", {name: "Cancel"}).boundingBox())!;
    expect(action.y + action.height).toBeLessThanOrEqual(640);
    expect(await editor.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({path: `artifacts/add-tabs-${name.replaceAll(" ", "-").toLowerCase()}-320.png`});
  }
});
