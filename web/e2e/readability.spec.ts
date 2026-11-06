import {test, expect, type Locator} from "@playwright/test";
import {mkdir, writeFile} from "node:fs/promises";
import {mockApi, setTheme} from "./fixtures";
import {palette} from "../src/app/model";

function luminance(color: string): number {
  const hex = color.startsWith("#") ? color.slice(1) : null;
  const rgb = hex ? (hex.length === 3 ? [...hex].map(value => value + value).join("") : hex).match(/../g)!.map(value => Number.parseInt(value, 16))
    : color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const linear = rgb.map(channel => channel / 255 <= .04045 ? channel / 255 / 12.92 : ((channel / 255 + .055) / 1.055) ** 2.4);
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

async function paintedColor(locator: Locator, property: string): Promise<string> {
  return locator.evaluate((node, property) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = getComputedStyle(node).getPropertyValue(property);
    context.fillRect(0, 0, 1, 1);
    return `rgb(${[...context.getImageData(0, 0, 1, 1).data].slice(0, 3).join(", ")})`;
  }, property);
}

for (const theme of ["light", "dark"]) test(`${theme} theme keeps enabled small text readable for every Run hue`, async ({page}) => {
  await mockApi(page);
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  if (theme === "dark") await setTheme(page, "dark");
  const row = page.locator('.run-row[data-run-id="run-1"]');
  const originalHue = await row.evaluate(node => (node as HTMLElement).style.getPropertyValue("--run-color"));
  const background = await paintedColor(row, "background-color");
  const report: {element: string; contrast: number}[] = [];
  for (const hue of palette) {
    await row.evaluate((node, hue) => (node as HTMLElement).style.setProperty("--run-color", hue), hue);
    const foreground = await paintedColor(row.locator(".run-name strong"), "color");
    const ratio = contrast(foreground, background);
    report.push({element: `selected Run name, hue ${hue}`, contrast: ratio});
    expect.soft(ratio, `${theme}: selected Run name with ${hue}`).toBeGreaterThanOrEqual(4.5);
  }
  await row.evaluate((node, hue) => (node as HTMLElement).style.setProperty("--run-color", hue), originalHue);
  const secondary = await paintedColor(page.locator(".collection-freshness"), "color");
  const pageBackground = await paintedColor(page.locator(".workspace-controls"), "background-color");
  report.push({element: "collection freshness", contrast: contrast(secondary, pageBackground)});
  expect.soft(contrast(secondary, pageBackground), `${theme}: secondary text`).toBeGreaterThanOrEqual(4.5);
  const warning = await paintedColor(page.locator(".run-observation.stale-text").first(), "color");
  report.push({element: "observation-age warning", contrast: contrast(warning, pageBackground)});
  expect.soft(contrast(warning, pageBackground), `${theme}: observation-age warning`).toBeGreaterThanOrEqual(4.5);
  const chartBackground = await paintedColor(page.locator(".chart-card").first(), "background-color");
  for (const hue of palette) {
    report.push({element: `trace ${hue}`, contrast: contrast(hue, chartBackground)});
    expect.soft(contrast(hue, chartBackground), `${theme}: trace ${hue}`).toBeGreaterThanOrEqual(3);
  }
  await mkdir("artifacts", {recursive: true});
  await writeFile(`artifacts/readability-${theme}.json`, JSON.stringify(report, null, 2));
  await page.screenshot({path: `artifacts/readability-${theme}.png`});
});
