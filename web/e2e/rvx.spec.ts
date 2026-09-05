import {expect, test, type Page} from "@playwright/test";
import {mockRvxApi, snapshots} from "./fixtures";
import {parseExactJson, stringifyExact} from "../src/core/exact-json";
import type {StoredSnapshot} from "../src/domain/snapshots";
import {WORKSPACE_STORAGE_KEY} from "../src/rvx/workspace-store";

test.beforeEach(async ({page}) => mockRvxApi(page));

test("migrates legacy saved tabs, filters and layout while canonicalizing workspace bookmarks", async ({page}) => {
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "Field trends");
  await page.getByLabel("Recorded numeric fields").selectOption("/progress/loss");
  await page.getByLabel("Projection axis").selectOption("optimizer_step");
  await page.getByLabel("optimizer_step from", {exact: true}).fill("-10");
  await page.getByLabel("optimizer_step to", {exact: true}).fill("80");
  await page.getByRole("button", {name: "Apply projection range", exact: true}).click();
  await expect(page.locator(".uplot")).toHaveCount(1);
  await page.locator(".rvx-tab.active").click({button: "right"});
  await page.getByRole("menuitem", {name: "Move to second pane"}).click();
  await page.locator('.rvx-pane[data-pane="secondary"] .rvx-tab.active').click({button: "right"});
  await page.getByRole("menuitem", {name: "Duplicate view"}).click();
  await page.locator('.rvx-pane[data-pane="secondary"] .rvx-tab.active').getByTitle("Close view").click();

  const saved = await page.evaluate(key => {
    const workspace = localStorage.getItem(key)!;
    // Legacy keys intentionally emulate browser state from before the rename.
    localStorage.setItem("ryx.workspace.snapshots.v1", workspace);
    localStorage.setItem("ryx.layout.context", "312");
    localStorage.setItem("ryx.layout.split", "62");
    localStorage.removeItem(key);
    localStorage.removeItem("rvx.layout.context");
    localStorage.removeItem("rvx.layout.split");
    return JSON.parse(workspace);
  }, WORKSPACE_STORAGE_KEY);
  await page.goto("/ryx/workspace?runs=run-1&filter=a%20b&return=%2Fryx%2Fprojects%2Fproject-1%2Fexperiments%2Fexperiment-1&filter=x+y#saved");
  await expect(page).toHaveURL(/\/rvx\/workspace\?runs=run-1&filter=a%20b&return=%2Frvx%2Fprojects%2Fproject-1%2Fexperiments%2Fexperiment-1&filter=x\+y#saved$/);
  await expect(page).toHaveTitle("RVX");
  await expect(page.getByRole("navigation", {name: "RVX navigation", exact: true})).toBeVisible();
  await expect(page.locator(".rvx-pane")).toHaveCount(2);
  await expect(page.locator(".rvx-field-chips")).toContainText("/progress/loss");
  await expect(page.getByLabel("optimizer_step from", {exact: true})).toHaveValue("-10");
  await expect(page.getByLabel("optimizer_step to", {exact: true})).toHaveValue("80");
  const migrated = await page.evaluate(key => ({
    workspace: JSON.parse(localStorage.getItem(key)!),
    context: localStorage.getItem("rvx.layout.context"),
    split: localStorage.getItem("rvx.layout.split"),
    style: document.querySelector<HTMLElement>(".rvx-app-shell")!.style.cssText,
  }), WORKSPACE_STORAGE_KEY);
  expect(migrated.workspace.tabs).toEqual(saved.tabs);
  expect(migrated.workspace.recentlyClosed).toEqual(saved.recentlyClosed);
  expect(migrated.workspace.active).toEqual(saved.active);
  expect(migrated.context).toBe("312");
  expect(migrated.split).toBe("62");
  expect(migrated.style).toContain("--rvx-context-width: 312px");
  expect(migrated.style).toContain("--rvx-split: 62%");

  await page.evaluate(() => localStorage.setItem("rvx.layout.context", "280"));
  await page.reload();
  await expect(page.getByLabel("optimizer_step from", {exact: true})).toHaveValue("-10");
  await expect(page.locator(".rvx-app-shell")).toHaveAttribute("style", /--rvx-context-width: 280px/);
  await page.getByRole("button", {name: "← Back", exact: true}).click();
  await expect(page).toHaveURL(/\/rvx\/projects\/project-1\/experiments\/experiment-1$/);
});

test("opens legacy Browser bookmarks without losing query strings or permitting external returns", async ({page}) => {
  for (const path of ["", "/", "/runs", "/projects/project-1", "/system"]) {
    await page.goto(`/ryx${path}?filter=a%20b&filter=x+y#saved`);
    await expect(page.locator(".rvx-statusbar")).toContainText("Snapshots");
    const location = new URL(page.url());
    expect(location.pathname).toBe(`/rvx${path}`);
    expect(location.search).toBe("?filter=a%20b&filter=x+y");
    expect(location.hash).toBe("#saved");
    await expect(page).toHaveTitle("RVX");
    await expect(page.locator(".rvx-brand")).toHaveText("RVX");
  }
  await page.goto("/ryx/workspace?runs=run-1&return=https%3A%2F%2Fevil.example%2Fryx%2Fruns");
  await expect(page.locator(".rvx-state-json")).toBeVisible();
  await page.getByRole("button", {name: "← Back", exact: true}).click();
  await expect(page).toHaveURL(/\/rvx\/runs$/);
});

async function view(page: Page, name: string): Promise<void> {
  if (await page.getByRole("button", {name: "Views", exact: true}).isVisible()) {
    await page.getByRole("button", {name: "Views", exact: true}).click();
  }
  await page.locator(".rvx-context-list").getByRole("button", {name, exact: true}).click();
}

test("browses compact Project Experiment and virtual Runs registries without metric queries", async ({page}) => {
  const queries: string[] = [];
  page.on("request", request => {
    if (/query/.test(request.url())) queries.push(request.url());
  });
  await page.goto("/rvx/projects");
  await expect(page.locator(".rvx-tabbar")).toHaveCount(0);
  await expect(page.locator(".rvx-object-card")).toHaveCount(0);
  await page.locator(".rvx-browser-page").getByRole("button", {name: "async-rl"}).click();
  await expect(page).toHaveURL(/projects\/project-1$/);
  await expect(page.locator(".rvx-catalog-section")).toHaveCount(3);
  await page.locator(".rvx-context-list").getByRole("button", {name: "grpo", exact: true}).click();
  await expect(page.locator(".rvx-catalog-section")).toHaveCount(4);
  await expect(page.locator(".rvx-catalog-section").first()).toContainText("State freshness");
  expect(queries).toEqual([]);
  await page.locator(".rvx-global-rail").getByRole("button", {name: "Runs"}).click();
  await expect(page.locator(".rvx-virtual-row")).toHaveCount(2);
  await page.locator(".rvx-catalog-controls input").fill("status:finished");
  await expect(page.locator(".rvx-virtual-row")).toHaveCount(1);
  await expect(page.locator(".rvx-virtual-row")).toContainText("trial-2");
  await page.locator(".rvx-catalog-controls input").fill("");
  await page.getByRole("button", {name: "Sort by Run", exact: true}).click();
  await page.getByRole("button", {name: "Sort by Run", exact: true}).click();
  await expect(page.locator(".rvx-virtual-row").first()).toContainText("trial-2");
});

test("inspects actual structured latest state, paginates Sources, and preserves DOM on poll", async ({page}) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/rvx/workspace?runs=run-1");
  await expect(page.locator(".rvx-tab.active")).toContainText("Snapshots");
  await expect(page.locator(".rvx-state-json")).toContainText('"workers": [');
  await expect(page.locator(".rvx-state-json")).toContainText('"nullable": null');
  await expect(page.locator(".rvx-state-json")).toContainText('"healthy": true');
  await expect(page.locator(".rvx-state-json")).toContainText("<img src=x");
  expect(await page.evaluate(() => (window as unknown as {__injected?: boolean}).__injected)).toBeUndefined();
  await expect(page.locator(".rvx-raw-inspector")).toContainText("session-restarted");
  await expect(page.locator(".rvx-raw-inspector")).toContainText("Schema version");
  await expect(page.locator(".rvx-snapshot-intro")).toContainText("not a globally atomic");
  await page.locator(".rvx-state-json").evaluate(element => element.dataset.stable = "yes");
  await page.waitForTimeout(5_400);
  await expect(page.locator('.rvx-state-json[data-stable="yes"]')).toHaveCount(1);
  await page.getByRole("button", {name: "Load more Sources", exact: true}).click();
  await expect(page.locator(".rvx-snapshot-table tbody tr")).toHaveCount(2);
  await page.getByRole("button", {name: "Inspect snapshot 13", exact: true}).click();
  await expect(page.locator(".rvx-state-json")).toContainText('"phase": "waiting"');
  await expect(page.locator(".rvx-statusbar")).toContainText("Snapshots 17");
  await expect(page.locator(".rvx-statusbar")).toContainText("Legacy points");
  expect(errors).toEqual([]);
});

test("selects stored history, fetches older without changing selection, and replays bounded page", async ({page}) => {
  const requests: Array<{before_id: number | null; limit: number}> = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/snapshots/history")) requests.push(request.postDataJSON());
  });
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "History");
  await expect(page.locator(".rvx-snapshot-table tbody tr")).toHaveCount(3);
  await page.getByRole("button", {name: "Inspect snapshot 12", exact: true}).click();
  await expect(page.locator(".rvx-raw-inspector")).toHaveAttribute("data-stored-id", "12");
  await page.getByRole("button", {name: "Fetch older", exact: true}).click();
  await expect(page.locator(".rvx-snapshot-table tbody tr").first()).toContainText("#10");
  await expect(page.locator(".rvx-raw-inspector")).toHaveAttribute("data-stored-id", "12");
  await page.getByRole("button", {name: "Replay page", exact: true}).click();
  await expect(page.locator(".rvx-raw-inspector")).toHaveAttribute("data-stored-id", "8");
  await page.getByRole("button", {name: "Pause replay", exact: true}).click();
  await page.getByRole("button", {name: "Next state", exact: true}).click();
  await expect(page.locator(".rvx-raw-inspector")).toHaveAttribute("data-stored-id", "9");
  expect(requests[1]!.before_id).toBe(11);
  expect(requests.every(request => request.limit <= 100)).toBe(true);
});

test("derives trends only from snapshot JSON pointers and keeps gaps and charts stable", async ({page}) => {
  const requests: Array<{run_ids: string[]; paths: string[]; axis: string; max_points: number; source_ids?: string[]; from?: number; to?: number}> = [];
  let legacyQueries = 0;
  page.on("request", request => {
    if (request.url().endsWith("/api/snapshots/query")) requests.push(request.postDataJSON());
    if (request.url().endsWith("/api/experiments/query")) legacyQueries++;
  });
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "Field trends");
  await expect(page.getByLabel("Recorded numeric fields")).toContainText("/progress/loss");
  await page.getByLabel("State JSON pointer").fill("/metrics/cpu~1percent");
  await page.getByRole("button", {name: "Add field", exact: true}).click();
  await expect(page.locator(".uplot")).toHaveCount(1);
  await expect(page.locator(".rvx-projection-summary")).toContainText("gaps");
  await expect(page.locator(".rvx-projection-values")).toContainText("gap (null / absent / nonnumeric)");
  expect(requests[0]!.axis).toBe("wall_time");
  expect(requests[0]!.paths).toEqual(["/metrics/cpu~1percent"]);
  await page.locator(".uplot").evaluate(element => element.dataset.stable = "yes");
  await page.waitForTimeout(5_400);
  await expect(page.locator('.uplot[data-stable="yes"]')).toHaveCount(1);
  await page.getByLabel("Projection Source", {exact: true}).selectOption("source-1");
  await page.getByLabel("Observed from", {exact: true}).fill("2026-09-05T08:00");
  await page.getByLabel("Observed to", {exact: true}).fill("2026-09-05T08:00:11");
  await page.getByRole("button", {name: "Apply projection range", exact: true}).click();
  await expect.poll(() => requests.at(-1)?.source_ids).toEqual(["source-1"]);
  await expect.poll(() => requests.at(-1)?.to).toBeGreaterThan(1e18);
  expect(requests.at(-1)!.from).toBeLessThan(requests.at(-1)!.to!);
  await page.getByLabel("Projection axis").selectOption("optimizer_step");
  await expect.poll(() => requests.at(-1)?.axis).toBe("optimizer_step");
  expect(requests.at(-1)!.from).toBeUndefined();
  expect(requests.at(-1)!.to).toBeUndefined();
  await expect(page.getByLabel("optimizer_step from", {exact: true})).toHaveAttribute("type", "number");
  await expect(page.getByLabel("optimizer_step from", {exact: true})).toHaveValue("");
  await page.getByLabel("optimizer_step from", {exact: true}).fill("-10");
  await page.getByLabel("optimizer_step to", {exact: true}).fill("80");
  await page.getByRole("button", {name: "Apply projection range", exact: true}).click();
  await expect.poll(() => requests.at(-1)?.from).toBe(-10);
  expect(requests.at(-1)!.to).toBe(80);
  await expect(page.locator(".rvx-field-chips")).toContainText("/metrics/cpu~1percent");
  await page.getByLabel("optimizer_step from", {exact: true}).fill("9007199254740992");
  await page.getByRole("button", {name: "Apply projection range", exact: true}).click();
  await expect(page.locator(".rvx-read-status")).toContainText("signed safe integers");
  expect(requests.at(-1)!.from).toBe(-10);
  await page.getByLabel("optimizer_step from", {exact: true}).fill("0.5");
  await page.getByRole("button", {name: "Apply projection range", exact: true}).click();
  await expect(page.locator(".rvx-read-status")).toContainText("signed safe integers");
  expect(requests.at(-1)!.from).toBe(-10);
  await page.getByLabel("Projection axis").selectOption("policy_version");
  await expect.poll(() => requests.at(-1)?.axis).toBe("policy_version");
  expect(requests.at(-1)!.from).toBeUndefined();
  await page.getByLabel("policy_version from", {exact: true}).fill("0");
  await page.getByRole("button", {name: "Apply projection range", exact: true}).click();
  await expect.poll(() => requests.at(-1)?.from).toBe(0);
  await page.getByLabel("Projection axis").selectOption("wall_time");
  await expect.poll(() => requests.at(-1)?.axis).toBe("wall_time");
  expect(requests.at(-1)!.from).toBeUndefined();
  expect(requests.at(-1)!.to).toBeUndefined();
  await expect(page.getByLabel("Observed from", {exact: true})).toHaveAttribute("type", "datetime-local");
  await expect(page.getByLabel("Observed from", {exact: true})).toHaveValue("");
  expect(requests.every(request => request.max_points === 1600)).toBe(true);
  expect(legacyQueries).toBe(0);
});

test("keeps history bounds in observation nanoseconds when the workspace axis changes", async ({page}) => {
  const requests: Array<{from?: number; to?: number; axis?: string}> = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/snapshots/history")) requests.push(request.postDataJSON());
  });
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "History");
  await page.getByLabel("Observed from", {exact: true}).fill("2026-09-05T08:00");
  await page.getByLabel("Observed to", {exact: true}).fill("2026-09-05T08:00:11");
  await page.getByLabel("Projection axis").selectOption("optimizer_step");
  await expect(page.getByLabel("Observed from", {exact: true})).toHaveValue("2026-09-05T08:00");
  await expect(page.getByLabel("Observed from", {exact: true})).toHaveAttribute("type", "datetime-local");
  await page.getByRole("button", {name: "Apply time range", exact: true}).click();
  await expect.poll(() => requests.at(-1)?.from).toBeGreaterThan(1e18);
  expect(requests.at(-1)!.to).toBeGreaterThan(requests.at(-1)!.from!);
  expect(requests.at(-1)!.axis).toBeUndefined();
});

test("draws interleaved Sources and per-path samples without false alignment gaps", async ({page}) => {
  const sampled = [
    {source_id: "source-1", path: "/pathA", axes: [0, 1, 2, 3, 4], values: [20, 20, null, 20, 20]},
    {source_id: "source-1", path: "/pathB", axes: [0, 2, 4], values: [10, 10, 10]},
    {source_id: "source-3", path: "/pathA", axes: [.5, 1.5, 2.5, 3.5], values: [40, 40, null, 40]},
    {source_id: "source-3", path: "/pathB", axes: [.5, 3.5], values: [30, 30]},
  ];
  await page.route("**/api/snapshots/query", route => {
    const request = route.request().postDataJSON();
    return route.fulfill({json: {
      axis: "wall_time",
      series: sampled.filter(series => request.paths.includes(series.path)).map(series => ({
        ...series, run_id: "run-1",
        axes: series.axes.map(value => 1788595200000000000 + value * 1e9),
        observed_at_ns: series.axes.map(value => 1788595200000000000 + value * 1e9),
        sequences: series.axes.map((_, index) => index),
        source_session_ids: series.axes.map(() => series.source_id),
      })),
    }});
  });
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "Field trends");
  for (const path of ["/pathA", "/pathB"]) {
    await page.getByLabel("State JSON pointer").fill(path);
    await page.getByRole("button", {name: "Add field", exact: true}).click();
  }
  await expect(page.locator(".rvx-projection-summary")).toContainText("4 series · 2 gaps");
  const paintedSegments = async () => page.locator(".uplot canvas").evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return [[143, 169, 188], [126, 170, 148]].map(color => {
      const columns: number[] = [];
      for (let x = 0; x < canvas.width; x++) {
        for (let y = 0; y < canvas.height; y++) {
          const index = (y * canvas.width + x) * 4;
          if (pixels[index + 3]! > 100 && color.every((value, channel) => Math.abs(pixels[index + channel]! - value) <= 12)) {
            columns.push(x);
            break;
          }
        }
      }
      return {
        pixels: columns.length,
        segments: columns.filter((x, index) => index === 0 || x - columns[index - 1]! > 4).length,
      };
    });
  });
  await expect.poll(async () => (await paintedSegments())[1]!.pixels).toBeGreaterThan(300);
  const [withGap, withoutGap] = await paintedSegments();
  expect(withoutGap!.segments).toBe(1);
  expect(withGap!.segments).toBe(2);
  expect(withGap!.pixels).toBeGreaterThan(100);
  expect(withGap!.pixels).toBeLessThan(withoutGap!.pixels);
  await page.screenshot({path: "artifacts/snapshots/desktop-interleaved-trends.png", fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.locator(".uplot").scrollIntoViewIfNeeded();
  await page.screenshot({path: "artifacts/snapshots/mobile-interleaved-trends.png", fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("discards incompatible date bounds in saved logical-axis tabs", async ({page}) => {
  const requests: Array<{axis?: string; from?: number; to?: number}> = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/snapshots/query")) requests.push(request.postDataJSON());
  });
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "Field trends");
  await page.getByLabel("Recorded numeric fields").selectOption("/progress/loss");
  await expect(page.locator(".uplot")).toHaveCount(1);
  await page.evaluate(key => {
    const workspace = JSON.parse(localStorage.getItem(key)!);
    const tab = workspace.tabs.find((tab: {view: {kind: string}}) => tab.view.kind === "metric");
    tab.state.axis = "optimizer_step";
    tab.state.filters.observedFrom = 1788595200000000000;
    tab.state.filters.observedTo = 1788595300000000000;
    delete tab.state.filters.rangeAxis;
    delete tab.state.filters.rangeFrom;
    delete tab.state.filters.rangeTo;
    localStorage.setItem(key, JSON.stringify(workspace));
  }, WORKSPACE_STORAGE_KEY);
  await page.reload();
  await expect(page.getByLabel("optimizer_step from", {exact: true})).toHaveValue("");
  await expect.poll(() => requests.at(-1)?.axis).toBe("optimizer_step");
  expect(requests.at(-1)!.from).toBeUndefined();
  expect(requests.at(-1)!.to).toBeUndefined();
});

const exactStateWire = '{"large":9007199254740993,"u64_max":18446744073709551615,"i64_min":-9223372036854775808,"nested":{"values":[9007199254740993,18446744073709551615,-9223372036854775808,null,true]},"text":"not a numeric string"}';
const exactSnapshotWire = '{"id":9007199254740993,"run_id":"run-1","source_id":"source-1","source_session_id":"exact-session","sequence":18446744073709551615,"schema_version":1,"observed_at_ns":1788595200000000123,"ingested_at_ns":1788595200000000789,"axes":{"optimizer_step":9007199254740993},"state":' + exactStateWire + '}';

test("preserves literal wire integers in raw latest/history, metadata, and full JSON export", async ({page}) => {
  await page.route("**/api/snapshots/latest", route => route.fulfill({
    contentType: "application/json", body: '{"snapshots":[' + exactSnapshotWire + '],"next_source_id":null}',
  }));
  await page.route("**/api/snapshots/history", route => route.fulfill({
    contentType: "application/json", body: '{"snapshots":[' + exactSnapshotWire + '],"next_before_id":null}',
  }));
  await page.goto("/rvx/workspace?runs=run-1");
  for (const text of ["9007199254740993", "18446744073709551615", "-9223372036854775808"]) {
    await expect(page.locator(".rvx-state-json")).toContainText(text);
  }
  await page.locator(".rvx-state-metadata summary").click();
  await expect(page.locator(".rvx-state-metadata")).toContainText("1788595200000000123 ns");
  await expect(page.locator(".rvx-state-metadata")).toContainText("1788595200000000789 ns");
  await expect(page.locator(".rvx-state-metadata")).toContainText('{"optimizer_step":9007199254740993}');
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", {name: "Download full snapshot JSON", exact: true}).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("snapshot-9007199254740993.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  expect(stringifyExact(parseExactJson<StoredSnapshot>(text))).toBe(exactSnapshotWire);
  expect(typeof JSON.parse(text).sequence).toBe("number");
  expect(typeof JSON.parse(text).state.u64_max).toBe("number");
  await page.screenshot({path: "artifacts/snapshots/desktop-exact-state.png", fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.locator(".rvx-state-metadata summary").click();
  await page.locator(".rvx-state-json").scrollIntoViewIfNeeded();
  await page.screenshot({path: "artifacts/snapshots/mobile-exact-state.png", fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await view(page, "History");
  await expect(page.locator(".rvx-state-json")).toContainText('"u64_max": 18446744073709551615');
});

test("preserves literal scalar and nested diff numbers and refuses unsupported-browser rounding", async ({page}) => {
  await page.route("**/api/snapshots/diff", route => route.fulfill({
    contentType: "application/json",
    body: '{"before_id":11,"after_id":12,"truncated":false,"changes":[{"path":"/large","kind":"changed","before":9007199254740993,"after":18446744073709551615},{"path":"/nested","kind":"added","after":{"n":-9223372036854775808}}]}',
  }));
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "Changes");
  await expect(page.locator('[data-change="changed"]')).toContainText("9007199254740993");
  await expect(page.locator('[data-change="changed"]')).toContainText("18446744073709551615");
  await expect(page.locator('[data-change="added"]')).toContainText('{"n":-9223372036854775808}');
  await page.screenshot({path: "artifacts/snapshots/desktop-exact-diff.png", fullPage: true});
  await page.addInitScript(() => {
    Object.defineProperty(JSON, "rawJSON", {value: undefined, configurable: true});
  });
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "Snapshots");
  await expect(page.locator(".rvx-read-status")).toContainText("rounded snapshot data will not be displayed");
  await expect(page.locator(".rvx-state-json")).toHaveCount(0);
});

test("compares raw snapshots across Runs and displays null-versus-absent and truncated diffs", async ({page}) => {
  const queries: Array<{run_ids: string[]}> = [];
  const diffs: Array<{before_id: number; after_id: number}> = [];
  await page.route("**/api/snapshots/diff", route => {
    const body = route.request().postDataJSON();
    diffs.push(body);
    return route.fulfill({json: {...body, truncated: true, changes: [
      {path: "/optional", kind: "added", after: null},
      {path: "/removed", kind: "removed", before: null},
      {path: "/phase", kind: "changed", before: false, after: {nested: ["a", 2]}},
    ]}});
  });
  page.on("request", request => {
    if (request.url().endsWith("/api/snapshots/query")) queries.push(request.postDataJSON());
  });
  await page.goto("/rvx/runs");
  await page.getByRole("checkbox", {name: "Select trial-1"}).check();
  await page.getByRole("checkbox", {name: "Select trial-2"}).click();
  await expect(page).toHaveURL(/workspace\?runs=run-1%2Crun-2/);
  await expect(page.locator(".rvx-diff-body")).toContainText("DIFF TRUNCATED");
  await expect(page.locator('[data-change="added"]')).toContainText("(absent)");
  await expect(page.locator('[data-change="added"]')).toContainText("null");
  expect(diffs[0]!.before_id).toBeGreaterThan(100);
  expect(diffs[0]!.after_id).toBeLessThan(100);
  await page.locator(".rvx-diff-raw summary").first().click();
  await expect(page.locator(".rvx-diff-raw .rvx-state-json").first()).toBeVisible();
  await page.getByLabel("State JSON pointer").fill("/progress/loss");
  await page.getByRole("button", {name: "Add field", exact: true}).click();
  await expect(page.locator(".uplot")).toHaveCount(1);
  expect(queries[0]!.run_ids).toEqual(["run-1", "run-2"]);
});

test("clearly separates legacy-only history and allows explicit read-only access", async ({page}) => {
  await page.route("**/api/snapshots/latest", route => route.fulfill({json: {snapshots: [], next_source_id: null}}));
  await page.goto("/rvx/workspace?runs=run-2");
  await expect(page.locator(".rvx-empty-state")).toContainText("cannot reconstruct runtime state");
  await view(page, "Legacy history");
  await page.getByLabel("Legacy metric name").fill("train/loss");
  await page.getByRole("button", {name: "Read legacy history"}).click();
  await expect(page.locator(".rvx-legacy-results")).toContainText("train/loss");
  await expect(page.locator(".rvx-warning")).toContainText("LEGACY");
});

test("bounds large JSON previews and allows full inspection", async ({page}) => {
  const wire = exactSnapshotWire.replace(exactStateWire, '{"payload":"' + "x".repeat(40_000) + '","large":9007199254740993,"last":"complete"}');
  await page.route("**/api/snapshots/latest", route => route.fulfill({
    contentType: "application/json", body: '{"snapshots":[' + wire + '],"next_source_id":null}',
  }));
  await page.goto("/rvx/workspace?runs=run-1");
  await expect(page.locator(".rvx-raw-inspector")).toContainText("JSON PREVIEW TRUNCATED");
  expect((await page.locator(".rvx-state-json").textContent())!.length).toBe(32_000);
  await page.getByRole("button", {name: "Show full state", exact: true}).click();
  await expect(page.locator(".rvx-state-json")).toContainText('"last": "complete"');
  await expect(page.locator(".rvx-state-json")).toContainText('"large": 9007199254740993');
  const download = page.waitForEvent("download");
  await page.getByRole("button", {name: "Download full snapshot JSON"}).click();
  expect((await download).suggestedFilename()).toBe("snapshot-9007199254740993.json");
});

test("preserves analytical tabs, duplicate, pin, split, axis and restore", async ({page}) => {
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "Field trends");
  await page.getByLabel("Recorded numeric fields").selectOption("/progress/loss");
  await expect(page.locator(".uplot")).toHaveCount(1);
  await page.locator(".rvx-tab.active").click({button: "right"});
  await page.getByRole("menuitem", {name: "Move to second pane"}).click();
  await expect(page.locator(".rvx-pane")).toHaveCount(2);
  await expect(page.locator(".uplot")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".rvx-pane")).toHaveCount(2);
  await expect(page.locator(".rvx-field-chips")).toContainText("/progress/loss");
  await expect(page.locator(".uplot")).toHaveCount(1);
  await page.locator('.rvx-pane[data-pane="secondary"] .rvx-tab.active').click({button: "right"});
  await page.getByRole("menuitem", {name: "Duplicate view"}).click();
  await expect(page.locator('.rvx-pane[data-pane="secondary"] .rvx-tab')).toHaveCount(2);
  await expect(page.locator(".rvx-field-chips")).toContainText("/progress/loss");
  await page.locator('.rvx-pane[data-pane="secondary"] .rvx-tab.active').getByTitle("Close view").click();
  await page.locator('.rvx-pane[data-pane="secondary"] .rvx-add-view').click();
  await page.getByRole("menuitem", {name: "Restore closed view"}).click();
  await expect(page.locator('.rvx-pane[data-pane="secondary"] .rvx-tab')).toHaveCount(2);
  await page.getByRole("button", {name: "← Back"}).click();
  await expect(page.locator(".rvx-tabbar")).toHaveCount(0);
});

test("retains useful hostmon operational read-through separate from stored state", async ({page}) => {
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "Run Details");
  await page.getByText("Resolved configuration", {exact: true}).click();
  await expect(page.locator(".rvx-config-view")).toBeVisible();
  for (const [title, content] of [
    ["Live metrics", "cpu/percent"], ["Collectors", "cpu"], ["Alerts", "high-cpu"],
    ["GPU Fleet", "56 / 64"], ["Workloads", "training-job-001"], ["Host system", "test-host"],
  ]) {
    await page.locator(".rvx-section-navigation").getByRole("button", {name: title!, exact: true}).click();
    await expect(page.locator(".rvx-hostmon-result")).toContainText(content!);
  }
  await page.locator(".rvx-section-navigation").getByRole("button", {name: "Settings", exact: true}).click();
  await expect(page.getByRole("link", {name: "Open hostmon settings"})).toHaveAttribute("href", "/hostmon?page=settings");
});

test("updates Run and Source lifecycle only through existing metadata PATCH contracts", async ({page}) => {
  const changes: Array<{url: string; body: unknown; method: string}> = [];
  await page.route("**/api/experiments/runs/run-1", route => {
    const request = route.request();
    changes.push({url: new URL(request.url()).pathname, body: request.postDataJSON(), method: request.method()});
    return route.fulfill({json: {status: "finished"}});
  });
  await page.route("**/api/experiments/sources/source-1", route => {
    const request = route.request();
    changes.push({url: new URL(request.url()).pathname, body: request.postDataJSON(), method: request.method()});
    return route.fulfill({json: {state: "draining"}});
  });
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "Run Details");
  await expect(page.getByLabel("Run lifecycle").locator("option")).toHaveCount(4);
  await expect(page.locator(".rvx-view")).toContainText("Does not kill or restart remote processes");
  await page.getByLabel("Run lifecycle").selectOption("finished");
  await page.getByRole("button", {name: "Apply lifecycle"}).click();
  await expect(page.locator("output")).toContainText("Stored snapshots are retained");
  await expect(page.getByLabel("Run lifecycle")).toBeDisabled();
  await expect(page.getByRole("button", {name: "Apply lifecycle"})).toBeDisabled();
  await page.screenshot({path: "artifacts/snapshots/desktop-run-details.png", fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: "artifacts/snapshots/mobile-run-details.png", fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({width: 1440, height: 900});
  await view(page, "Sources");
  await page.locator(".rvx-view").getByRole("button", {name: "hostmon", exact: true}).click();
  await page.getByLabel("Source lifecycle").selectOption("draining");
  await page.getByRole("button", {name: "Apply lifecycle"}).click();
  await expect(page.locator("output")).toContainText("Lifecycle updated");
  await expect(page.getByLabel("Source lifecycle").locator("option")).toHaveText(["draining", "ended", "lost"]);
  expect(changes).toEqual([
    {url: "/api/experiments/runs/run-1", body: {status: "finished"}, method: "PATCH"},
    {url: "/api/experiments/sources/source-1", body: {state: "draining"}, method: "PATCH"},
  ]);
});

test("updates a new full-state latest observation in place without carrying removed fields", async ({page}) => {
  let latest = {...snapshots[0]!, state: {keep: 1, removed: "old"}};
  await page.route("**/api/snapshots/latest", route => route.fulfill({json: {snapshots: [latest], next_source_id: null}}));
  await page.goto("/rvx/workspace?runs=run-1");
  await expect(page.locator(".rvx-state-json")).toContainText('"removed": "old"');
  await page.locator(".rvx-state-json").evaluate(element => element.dataset.stable = "yes");
  latest = {...snapshots[1]!, state: {keep: 2, removed: null}} as unknown as typeof latest;
  await page.waitForTimeout(5_400);
  await expect(page.locator('.rvx-state-json[data-stable="yes"]')).toContainText('"removed": null');
  await expect(page.locator(".rvx-state-json")).not.toContainText('"old"');
  await expect(page.locator(".rvx-raw-inspector")).toHaveAttribute("data-stored-id", "2");
});

test("virtualizes ten thousand Runs", async ({page}) => {
  const runs = Array.from({length: 10_000}, (_, index) => ({
    id: `run-${index}`, experiment_id: "experiment-1", name: `trial-${index}`,
    status: index % 5 === 0 ? "failed" : "finished",
    config_json: JSON.stringify({seed: index % 8, optimizer: {learning_rate: .001}}),
    created_at_ns: index + 1, updated_at_ns: index + 1,
  }));
  await page.route("**/api/experiments/runs", route => route.fulfill({json: {runs}}));
  await page.goto("/rvx/runs");
  await expect(page.locator(".rvx-catalog-controls")).toContainText("10,000 runs");
  expect(await page.locator(".rvx-virtual-row").count()).toBeLessThan(80);
  await page.locator(".rvx-catalog-controls input").fill("status:failed param.seed=0");
  await expect(page.locator(".rvx-catalog-controls")).toContainText("250 runs");
});

test("refreshes durable snapshot counters independently of legacy points", async ({page}) => {
  let count = 17;
  await page.route("**/api/experiments/stats", route => route.fulfill({json: {
    projects: 1, experiments: 2, runs: 2, sources: 3, active_sources: 2,
    snapshots: count, hot_points: 200, parquet_files: 1, wal_bytes: 1024,
    ingested_points: 200, compacted_values: 100, duplicate_points: 0, cursor_gaps: 0, scrape_failures: 0,
  }}));
  await page.goto("/rvx/system");
  await expect(page.locator('[data-counter="snapshots"]')).toContainText("17");
  await expect(page.locator('[data-counter="ingested_points"]')).toContainText("Legacy");
  await page.locator(".rvx-browser-page").evaluate(element => element.dataset.stable = "yes");
  count = 18;
  await expect(page.locator('[data-counter="snapshots"]')).toContainText("18", {timeout: 12_000});
  await expect(page.locator('.rvx-browser-page[data-stable="yes"]')).toHaveCount(1);
  await expect(page.locator('[data-counter="ingested_points"]')).toContainText("200");
});

test("captures industrial desktop and mobile Browser Workspace and drawer surfaces", async ({page}) => {
  await page.setViewportSize({width: 1440, height: 960});
  for (const [name, path] of [
    ["projects", "/rvx/projects"],
    ["project", "/rvx/projects/project-1"],
    ["experiment", "/rvx/projects/project-1/experiments/experiment-1"],
    ["runs", "/rvx/runs"],
    ["system", "/rvx/system"],
    ["workspace", "/rvx/workspace?runs=run-1"],
  ]) {
    await page.goto(path!);
    await expect(page.locator(".rvx-statusbar")).toContainText("Snapshots");
    if (name === "workspace") await expect(page.locator(".rvx-state-json")).toBeVisible();
    await page.screenshot({path: `artifacts/snapshots/desktop-${name}.png`, fullPage: true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  }
  await view(page, "Field trends");
  await page.getByLabel("Recorded numeric fields").selectOption("/progress/loss");
  await expect(page.locator(".uplot")).toHaveCount(1);
  await page.screenshot({path: "artifacts/snapshots/desktop-trends.png", fullPage: true});
  await page.getByLabel("Projection axis").selectOption("optimizer_step");
  await page.getByLabel("optimizer_step from", {exact: true}).fill("-10");
  await page.getByLabel("optimizer_step to", {exact: true}).fill("80");
  await page.getByRole("button", {name: "Apply projection range", exact: true}).click();
  await expect(page.locator(".rvx-chart > header")).toContainText("optimizer_step");
  await page.screenshot({path: "artifacts/snapshots/desktop-logical-trends.png", fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: "artifacts/snapshots/mobile-logical-trends.png", fullPage: true});
  await page.getByLabel("Projection axis").selectOption("wall_time");
  await expect(page.locator(".rvx-chart > header")).toContainText("observed time");
  await page.screenshot({path: "artifacts/snapshots/mobile-trends.png", fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto("/rvx/projects");
  await expect(page.locator(".rvx-browser-page")).toBeVisible();
  await page.screenshot({path: "artifacts/snapshots/mobile-browser.png", fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto("/rvx/workspace?runs=run-1");
  await view(page, "Snapshots");
  await expect(page.locator(".rvx-state-json")).toBeVisible();
  await page.screenshot({path: "artifacts/snapshots/mobile-workspace.png", fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", {name: "Views", exact: true}).click();
  await expect(page.locator(".rvx-context-browser")).toBeInViewport();
  await page.screenshot({path: "artifacts/snapshots/mobile-drawer.png", fullPage: true});
  await page.keyboard.press("Escape");
  await expect(page.locator(".rvx-context-browser")).not.toBeInViewport();
});
