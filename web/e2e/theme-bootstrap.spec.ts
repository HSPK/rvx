import {test, expect} from "@playwright/test";
import {mockApi, seedUiState} from "./fixtures";

test("server-rendered dark mode never paints light during delayed session and preference bootstrap", async ({page}) => {
  await page.emulateMedia({colorScheme: "light"});
  await mockApi(page);
  await seedUiState(page, {theme: "dark", selected: {"experiment-1": "theme"}, sets: [{
    id: "theme", name: "Dark workspace", experimentId: "experiment-1",
    sections: [{id: "main", name: "", collapsed: false}],
    panels: [{id: "loss", kind: "chart", sectionId: "main", size: "normal", path: "/progress/loss"}],
  }]});
  await page.route(url => url.pathname === "/rvx", async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: (await response.text())
      .replace('data-theme="light"', 'data-theme="dark"')
      .replace('content="#f6f7f9"', 'content="#171b23"')});
  });
  await page.addInitScript(() => {
    const frames: {theme: string | undefined; html: string; surface: string}[] = [];
    Object.defineProperty(window, "themePaints", {value: frames});
    const record = (): void => {
      if (document.documentElement && document.body) {
        let node: Element | null = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        let surface = "rgba(0, 0, 0, 0)";
        while (node && surface === "rgba(0, 0, 0, 0)") {surface = getComputedStyle(node).backgroundColor; node = node.parentElement;}
        frames.push({theme: document.documentElement.dataset.theme, html: getComputedStyle(document.documentElement).backgroundColor, surface});
      }
      if (frames.length < 300) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  });
  let releaseSession!: () => void, releasePreferences!: () => void;
  const session = new Promise<void>(resolve => {releaseSession = resolve;});
  const preferences = new Promise<void>(resolve => {releasePreferences = resolve;});
  await page.route("**/api/auth/session", async route => {await session; await route.fallback();});
  await page.route("**/api/ui/state", async route => {await preferences; await route.fallback();});
  try {
    await page.goto("/rvx?runs=run-1", {waitUntil: "commit"});
    await expect(page.locator(".auth-page")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(".auth-page")).toHaveCSS("background-color", "rgb(23, 27, 35)");
    await page.screenshot({path: "artifacts/dark-before-session.png"});
    releaseSession();
    await expect(page.getByRole("heading", {name: "Loading workspace settings"})).toBeVisible();
    await expect(page.getByRole("button", {name: "Switch to light appearance"})).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({path: "artifacts/dark-before-preferences.png"});
    releasePreferences();
    await expect(page.locator(".chart-card canvas")).toBeVisible();
    await page.screenshot({path: "artifacts/dark-after-bootstrap.png"});
    await page.reload();
    await expect(page.locator(".chart-card canvas")).toBeVisible();
    const frames = await page.evaluate(() => Reflect.get(window, "themePaints") as {theme: string; html: string; surface: string}[]);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(frame => frame.theme === "dark" && frame.html === "rgb(23, 27, 35)")).toBe(true);
    expect(frames.some(frame => ["rgb(255, 255, 255)", "rgb(246, 247, 249)"].includes(frame.surface))).toBe(false);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  } finally {releaseSession(); releasePreferences();}
});

test("an explicit light document overrides dark system preference during startup", async ({page}) => {
  await page.emulateMedia({colorScheme: "dark"});
  await mockApi(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/auth/session", async route => {await pending; await route.fallback();});
  try {
    await page.goto("/rvx?runs=run-1", {waitUntil: "commit"});
    await expect(page.locator(".auth-page")).toHaveCSS("background-color", "rgb(246, 247, 249)");
    release();
    await expect(page.locator(".chart-card canvas").first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  } finally {release();}
});
