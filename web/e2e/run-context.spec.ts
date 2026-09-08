import {test, expect} from "@playwright/test";
import {mockApi, runs, firstObservation} from "./fixtures";

test("same-name Runs remain distinguishable across selection, charts and Run details", async ({page}) => {
  await mockApi(page);
  await page.route("**/api/experiments/runs", route => route.fulfill({json: {
    runs: runs.map(run => ["run-1", "run-3"].includes(run.id) ? {...run, name: "seed-0"} : run),
  }}));
  await page.goto("/rvx?runs=run-1,run-3&live=0");
  const chart = page.locator(".chart-card").first();
  await expect(chart.locator("canvas")).toBeVisible();
  await expect(page.getByRole("checkbox", {name: "Select GRPO research / seed-0", exact: true})).toBeChecked();
  await expect(page.getByRole("checkbox", {name: "Select PPO research / seed-0", exact: true})).toBeChecked();
  await expect(chart.locator(".chart-legend")).toContainText("GRPO research / seed-0");
  await expect(chart.locator(".chart-legend")).toContainText("PPO research / seed-0");
  await page.getByRole("combobox", {name: "Experiment", exact: true}).selectOption("experiment-1");
  await expect(page.getByRole("checkbox", {name: "Select GRPO research / seed-0", exact: true})).toBeChecked();
  await expect(page.locator('.run-chip[data-run-id="run-3"]')).toContainText("PPO research / seed-0");
  await page.locator('.run-chip[data-run-id="run-3"]').getByRole("button", {name: /^Run details/}).click();
  await expect(page.getByRole("dialog", {name: "Run details", exact: true}).locator(".run-detail-name")).toHaveText("PPO research / seed-0");
});

test("identical experiment names include project scope without expanding every Run name", async ({page}) => {
  await mockApi(page);
  await page.route("**/api/experiments/projects", route => route.fulfill({json: {projects: [
    {id: "project-1", name: "Project A", created_at_ns: firstObservation}, {id: "project-2", name: "Project B", created_at_ns: firstObservation},
  ]}}));
  await page.route("**/api/experiments/experiments", route => route.fulfill({json: {experiments: [
    {id: "experiment-1", project_id: "project-1", name: "Training", created_at_ns: firstObservation},
    {id: "experiment-2", project_id: "project-2", name: "Training", created_at_ns: firstObservation},
  ]}}));
  await page.route("**/api/experiments/runs", route => route.fulfill({json: {runs: runs.map(run => ["run-1", "run-3"].includes(run.id) ? {...run, name: "seed-0"} : run)}}));
  await page.goto("/rvx?runs=run-1,run-3&live=0");
  await expect(page.getByRole("checkbox", {name: "Select Project A / Training / seed-0", exact: true})).toBeChecked();
  await expect(page.getByRole("checkbox", {name: "Select Project B / Training / seed-0", exact: true})).toBeChecked();
  await expect(page.getByRole("checkbox", {name: "Select grpo · baseline", exact: true})).toBeVisible();
  await page.screenshot({path: "artifacts/project-run-identity.png"});
});

test("a fresh finished Run cannot hide another running Run's old observations", async ({page}) => {
  const now = Date.now() * 1e6, span = 179 * 60e9;
  await mockApi(page, {observationOrigins: {"run-1": now - span - 600e9, "run-2": now - span}});
  await page.goto("/rvx?runs=run-1,run-2&live=0");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  await expect(page.locator('.run-chip[data-run-id="run-1"]')).toContainText("No recent data");
  await expect(page.locator('.run-chip[data-run-id="run-2"]')).not.toContainText("No recent data");
  await expect(page.locator(".collection-freshness")).toContainText("Updated");
  await expect(page.locator(".chip-state.stale-text")).toHaveCount(1);
  await page.screenshot({path: "artifacts/individual-run-freshness.png"});
});

test("legacy paused links still show honest staleness as the wall clock advances", async ({page}) => {
  const now = Date.now() * 1e6;
  await mockApi(page, {observationOrigins: {"run-1": now - 179 * 60e9}});
  await page.goto("/rvx?runs=run-1&live=0");
  await expect(page.locator(".chart-card").first().locator("canvas")).toBeVisible();
  const chip = page.locator('.run-chip[data-run-id="run-1"]');
  await expect(chip).not.toContainText("No recent data");
  await page.evaluate(() => {const future = Date.now() + 600_000; Date.now = () => future;});
  await page.getByRole("combobox", {name: "Project", exact: true}).selectOption("project-1");
  await expect(chip).toContainText("No recent data");
});
