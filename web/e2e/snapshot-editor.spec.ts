import {test, expect, type Page} from "@playwright/test";
import {firstObservation, mockApi, serverState} from "./fixtures";
import type {SnapshotAggregateRequest, SnapshotRecordsRequest} from "../src/domain/snapshot-views";
import type {TableCell, TableSource} from "../src/domain/tables";

const cell = (text: string, kind: TableCell["kind"] = "string"): TableCell => ({kind, text, truncated: false});
const snapshot: TableSource = {run_id: "run-1", source_id: "run-1-source-0", snapshot_id: "1001",
  label: "Learner", role: "learner", rank: 0, node_id: "node-a", observed_at_ns: firstObservation, row_count: 2};
const records = [
  {id: cell("a"), name: cell("Alpha"), status: cell("Running"), queue: cell("main"), running_gpus: cell("8", "number")},
  {id: cell("b"), name: cell("Beta"), status: cell("Pending"), queue: cell("main"), running_gpus: cell("4", "number")},
];

async function visualApi(page: Page) {
  const calls: {aggregate: SnapshotAggregateRequest[]; records: SnapshotRecordsRequest[]} = {aggregate: [], records: []};
  await mockApi(page, {tableRows: 2});
  const columns = [{path: "$key", name: "Key", kinds: ["string"]},
    ...Object.keys(records[0]!).map(name => ({path: `/${name}`, name, kinds: [name === "running_gpus" ? "number" : "string"]}))];
  await page.route("**/api/tables/catalog", route => route.fulfill({json: {tables: [{
    path: "/tasks", name: "Tasks", columns, collection_kinds: ["array"], sources: [snapshot],
  }], truncated: false}}));
  await page.route("**/api/snapshots/records", route => {
    const body: SnapshotRecordsRequest = route.request().postDataJSON(); calls.records.push(body);
    return route.fulfill({json: {
      columns, offset: 0, limit: body.limit ?? 1000, total: 2, snapshots: [snapshot],
      identities: ["run-1/source/a", "run-1/source/b"],
      rows: records.map((record, index) => ({run_id: "run-1", source_id: "run-1-source-0", snapshot_id: "1001", row_key: String(index),
        cells: Object.fromEntries(Object.entries(record).map(([key, value]) => [`/${key}`, value]))})),
    }});
  });
  await page.route("**/api/snapshots/aggregate", route => {
    const body: SnapshotAggregateRequest = route.request().postDataJSON(); calls.aggregate.push(body);
    const status = body.group_by[0] === "/status";
    return route.fulfill({json: {
      groups: records.map((record, index) => ({
        key: `${status ? "status" : "category"}-${index}`, cells: [status ? record.status : record.name],
        series: [{run_id: "run-1", source_id: "run-1-source-0", snapshot_id: "1001",
          measures: Object.fromEntries(body.measures.map(measure => [measure.id, {
            value: cell(measure.op === "count" ? "1" : record.running_gpus.text, "number"),
            ...(measure.op === "min" ? {minimum_magnitude: record.running_gpus} : {}),
            count: 1, missing: 0, non_numeric: 0, approximate: false,
          }]))}],
      })),
      total_groups: 2, matched_rows: 2, offset: 0, limit: body.limit ?? 50, snapshots: [snapshot],
    }});
  });
  return calls;
}

test("one Snapshot editor switches Table/Bar/Status with saved mappings and stable panel identity", async ({page}) => {
  const calls = await visualApi(page);
  await page.goto("/rvx?runs=run-1");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await editor.getByRole("tab", {name: "Snapshot", exact: true}).click();
  await expect(editor.locator(".table-preview tbody tr")).toHaveCount(2);
  await editor.getByRole("tab", {name: "Bar", exact: true}).click();
  await expect(editor.locator(".snapshot-visual-card")).toBeVisible();
  await expect.poll(() => calls.aggregate.length).toBeGreaterThan(0);
  expect(calls.aggregate.at(-1)).toMatchObject({group_by: ["/name"], measures: [{id: "m0", op: "sum", path: "/running_gpus"}]});
  await page.screenshot({path: "artifacts/snapshot-editor-bar.png"});
  await editor.getByRole("button", {name: "Add", exact: true}).click();
  const visual = page.locator(".section-grid .snapshot-visual-card");
  await expect(visual).toBeVisible();
  const id = await visual.getAttribute("data-panel-id");
  await page.getByRole("button", {name: "Save current workspace"}).click();
  await page.getByRole("textbox", {name: "Workspace set name"}).fill("Snapshot views");
  await page.getByRole("textbox", {name: "Workspace set name"}).press("Enter");
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
  const stored = (await serverState(page)).workspaces.sets[0]!.panels.find(panel => panel.id === id)!;
  expect(stored).toMatchObject({kind: "snapshot-table", path: "/tasks", view: {type: "bar", valuePaths: ["/running_gpus"], categoryPath: "/name"}});
  await visual.locator(".menu-trigger").click();
  await visual.getByRole("menuitem", {name: "Edit snapshot", exact: true}).click();
  const edit = page.getByRole("dialog", {name: "Edit panel", exact: true});
  await edit.getByRole("tab", {name: "Status", exact: true}).click();
  await expect.poll(() => calls.records.length).toBeGreaterThan(0);
  expect(calls.records.at(-1)).toMatchObject({identity_paths: ["/id"], path: "/tasks"});
  await expect.poll(() => calls.aggregate.some(call => call.group_by[0] === "/status" && call.snapshot_ids?.[0] === "1001")).toBe(true);
  await edit.getByRole("combobox", {name: "Sort by", exact: true}).selectOption("/running_gpus");
  await edit.getByRole("combobox", {name: "Sort direction", exact: true}).selectOption("desc");
  await edit.getByRole("combobox", {name: "Columns", exact: true}).selectOption("8");
  await edit.getByRole("combobox", {name: "Cell size", exact: true}).selectOption("20");
  await edit.getByRole("combobox", {name: "Gap", exact: true}).selectOption("4");
  await edit.getByRole("combobox", {name: "Shade by", exact: true}).selectOption("/running_gpus");
  await edit.getByRole("combobox", {name: "Shade scale", exact: true}).selectOption("linear");
  await expect(edit.locator(".sv-shade-key")).toContainText("4 – 8");
  await expect.poll(() => calls.records.at(-1)?.sort).toEqual({path: "/running_gpus", direction: "desc"});
  await page.screenshot({path: "artifacts/snapshot-editor-status.png"});
  await edit.getByRole("button", {name: "Save changes", exact: true}).click();
  await expect(visual).toHaveAttribute("data-panel-id", id!);
  await visual.locator(".menu-trigger").click();
  await visual.getByRole("menuitem", {name: "Edit snapshot", exact: true}).click();
  await expect(edit.getByRole("combobox", {name: "Columns", exact: true})).toHaveValue("8");
  await expect(edit.getByRole("combobox", {name: "Cell size", exact: true})).toHaveValue("20");
  await expect(edit.getByRole("combobox", {name: "Gap", exact: true})).toHaveValue("4");
  await expect(edit.getByRole("combobox", {name: "Shade by", exact: true})).toHaveValue("/running_gpus");
  await expect(edit.getByRole("combobox", {name: "Shade scale", exact: true})).toHaveValue("linear");
  await edit.getByRole("tab", {name: "Table", exact: true}).click();
  await expect(edit.locator(".table-preview tbody tr")).toHaveCount(2);
  await edit.getByRole("button", {name: "Save changes", exact: true}).click();
  const table = page.locator(`.section-grid .table-card[data-panel-id="${id}"]`);
  await expect(table).toBeVisible();
  const handle = table.locator(".panel-drag-handle");
  await handle.focus(); await handle.press("Space");
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await handle.press("Escape");
});

test("snapshot bindings fit mobile and reject incomplete identities without issuing visual queries", async ({page}) => {
  const calls = await visualApi(page);
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/rvx?runs=run-1");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  const editor = page.getByRole("dialog", {name: "Add", exact: true});
  await editor.getByRole("tab", {name: "Snapshot", exact: true}).click();
  await editor.getByRole("tab", {name: "Status", exact: true}).click();
  await expect(editor.locator(".snapshot-visual-card")).toBeVisible();
  const identity = editor.locator(".snapshot-field-set").filter({hasText: "Identity"});
  await identity.locator("summary").click();
  await identity.getByRole("checkbox", {name: "Identity field id", exact: true}).uncheck();
  await expect(editor.getByRole("button", {name: "Add", exact: true})).toBeDisabled();
  await expect(editor.locator(".editor-error")).toContainText("identity");
  const reads = calls.records.length;
  await page.waitForTimeout(100); expect(calls.records.length).toBe(reads);
  await identity.getByRole("checkbox", {name: "Identity field name", exact: true}).check();
  await identity.locator("summary").click();
  await expect(editor.getByRole("button", {name: "Add", exact: true})).toBeEnabled();
  expect(await editor.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({path: "artifacts/snapshot-editor-mobile.png"});
});
