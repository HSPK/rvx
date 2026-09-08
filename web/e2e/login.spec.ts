import {test, expect, type Page, type WebSocketRoute} from "@playwright/test";
import {mockApi, seedWorkspace, uiServer} from "./fixtures";

const password = "fixture-only-server-password-0123456789";
async function authentication(page: Page, initial = false) {
  const state = {authenticated: initial, loginCalls: 0, logoutCalls: 0, failLogout: false, cookieAccepted: true};
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname.startsWith("/api/auth/")) return route.fallback();
    return state.authenticated ? route.fallback() : route.fulfill({status: 401, json: {error: "Authentication required."}});
  });
  await page.route("**/api/auth/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/session")) return route.fulfill({json: {authenticated: state.authenticated, authentication_required: true}});
    if (path.endsWith("/login")) {
      state.loginCalls++;
      if (route.request().postDataJSON().password !== password) return route.fulfill({status: 401, json: {error: "Invalid password."}});
      state.authenticated = state.cookieAccepted;
      return route.fulfill({json: {authenticated: true, authentication_required: true},
        headers: {"Set-Cookie": "rvx_session=fixture-session; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800"}});
    }
    state.logoutCalls++;
    if (state.failLogout) return route.fulfill({status: 503, json: {error: "Unavailable"}});
    state.authenticated = false;
    return route.fulfill({status: 204, headers: {"Set-Cookie": "rvx_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"}});
  });
  return state;
}

test("standalone login is branded, keyboard accessible and loads only isolated public assets", async ({page}) => {
  await mockApi(page); const auth = await authentication(page);
  const privateAssets: string[] = [];
  page.on("request", request => {if (new URL(request.url()).pathname.startsWith("/assets/")) privateAssets.push(request.url());});
  await page.goto("/login?next=%2Frvx%3Fruns%3Drun-1%2Crun-2%26range%3D3600");
  await expect(page).toHaveTitle("Sign in · RVX");
  const input = page.getByLabel("Password", {exact: true});
  await expect(input).toBeFocused(); await expect(input).toHaveAttribute("autocomplete", "current-password");
  await expect(page.locator("form")).toHaveAttribute("method", "post");
  await input.fill("not-the-password");
  await page.getByRole("button", {name: "Show password"}).click(); await expect(input).toHaveAttribute("type", "text");
  await page.getByRole("button", {name: "Hide password"}).click(); await expect(input).toHaveAttribute("type", "password");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Incorrect password");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await page.screenshot({path: "artifacts/login-invalid-password.png"});
  expect(privateAssets).toEqual([]);
  await input.fill(password); await input.press("Enter");
  await expect(page).toHaveURL(/\/rvx\?.*runs=run-1%2Crun-2|\/rvx\?.*runs=run-1,run-2/);
  await expect(page.locator(".run-checkbox:checked")).toHaveCount(2);
  expect(page.url()).not.toContain(password); expect(auth.loginCalls).toBe(2);
  expect((await page.context().cookies()).find(cookie => cookie.name === "rvx_session")?.httpOnly).toBe(true);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("login remains clean at desktop/mobile sizes and in light/dark appearance", async ({page}) => {
  await mockApi(page); await authentication(page);
  await page.goto("/login/");
  for (const width of [1440, 390, 320]) for (const colorScheme of ["light", "dark"] as const) {
    await page.setViewportSize({width, height: width > 400 ? 900 : 844});
    await page.emulateMedia({colorScheme});
    const input = page.getByLabel("Password", {exact: true});
    await expect(input).toBeVisible();
    const card = (await page.locator(".auth-card").boundingBox())!;
    expect(card.width).toBeLessThanOrEqual(360); expect(card.x).toBeGreaterThanOrEqual(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: `artifacts/login-${width}-${colorScheme}.png`});
  }
  await page.setViewportSize({width: 844, height: 390});
  await expect(page.getByRole("button", {name: "Sign in", exact: true})).toBeInViewport();
  await page.screenshot({path: "artifacts/login-short-landscape.png"});
});

test("pending and throttled attempts do not send duplicate passwords", async ({page}) => {
  await page.clock.install(); await mockApi(page); await authentication(page);
  let attempts = 0, release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/auth/login", async route => {
    attempts++; await gate;
    await route.fulfill({status: 429, headers: {"Retry-After": "3"}, json: {error: "Too many attempts"}});
  });
  await page.goto("/login/");
  await page.getByLabel("Password", {exact: true}).fill(password);
  await page.getByRole("button", {name: "Sign in", exact: true}).click();
  await expect(page.getByRole("button", {name: "Signing in…", exact: true})).toBeDisabled();
  await page.getByLabel("Password", {exact: true}).press("Enter");
  expect(attempts).toBe(1); await page.screenshot({path: "artifacts/login-pending.png"});
  release();
  await expect(page.getByRole("button", {name: "Try again in 3s", exact: true})).toBeDisabled();
  await page.screenshot({path: "artifacts/login-rate-limit.png"});
  await page.clock.runFor(3100);
  await expect(page.getByRole("button", {name: "Sign in", exact: true})).toBeEnabled();
});

test("expired sessions lock in place, stop reads and preserve unsaved work on reauthentication", async ({page}) => {
  await page.clock.install();
  const requests = await mockApi(page); const auth = await authentication(page, true);
  let protectedCalls = 0;
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/") && !path.startsWith("/api/auth/")) protectedCalls++;
  });
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1");
  const card = page.locator(".chart-card");
  await expect(card.locator("canvas")).toBeVisible();
  const canvas = await card.locator("canvas").elementHandle(), url = page.url();
  await card.locator(".menu-trigger").click(); await card.getByRole("menuitem", {name: "Make wide"}).click();
  auth.authenticated = false;
  await page.clock.runFor(5100);
  const lock = page.getByRole("dialog", {name: "Sign in again", exact: true});
  await expect(lock).toBeVisible();
  const count = requests.length, transportCount = protectedCalls;
  await page.clock.runFor(10000); expect(requests.length).toBe(count); expect(protectedCalls).toBe(transportCount);
  await page.keyboard.press("Escape"); await expect(lock).toBeVisible();
  await page.screenshot({path: "artifacts/login-expired-workspace.png"});
  await lock.getByLabel("Password", {exact: true}).fill(password);
  await lock.getByRole("button", {name: "Sign in", exact: true}).click();
  await expect(lock).toHaveCount(0);
  await expect(card).toHaveClass(/wide/);
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  expect(page.url()).toBe(url);
  await expect(page.getByRole("button", {name: "Save current workspace", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Save current workspace", exact: true}).click();
  await expect(page.locator(".workspace-save-slot")).toHaveText("Saved");
});

test("sign out respects unsaved drafts and revokes the session before leaving", async ({page}) => {
  await mockApi(page); const auth = await authentication(page, true);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  await page.goto("/rvx?runs=run-1");
  const card = page.locator(".chart-card"); await expect(card.locator("canvas")).toBeVisible();
  await card.locator(".menu-trigger").click(); await card.getByRole("menuitem", {name: "Make wide"}).click();
  await page.getByRole("button", {name: "Sign out", exact: true}).click();
  await page.getByRole("button", {name: "Cancel", exact: true}).click();
  expect(auth.logoutCalls).toBe(0);
  auth.failLogout = true;
  await page.getByRole("button", {name: "Sign out", exact: true}).click();
  await page.getByRole("button", {name: "Discard changes", exact: true}).click();
  await expect(page.locator(".preferences-notice")).toContainText("Sign out failed");
  await expect(card).toHaveClass(/wide/);
  auth.failLogout = false;
  await page.getByRole("button", {name: "Sign out", exact: true}).click();
  await page.getByRole("button", {name: "Discard changes", exact: true}).click();
  await expect(page.getByRole("heading", {name: "Sign in", exact: true})).toBeVisible();
  expect(auth.authenticated).toBe(false);
  await expect(page.locator(".chart-card")).toHaveCount(0);
});

test("revoked sockets lock collapsed workspaces, but a cookie renewed by another tab resumes automatically", async ({page}) => {
  await page.clock.install(); await mockApi(page); const auth = await authentication(page, true);
  await seedWorkspace(page, [{path: "/progress/loss", size: "normal"}]);
  const section = uiServer(page).workspaces.sets[0]!.sections[0]!;
  section.name = "Training"; section.collapsed = true;
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/ui/connection", socket => {
    sockets.push(socket);
    socket.onMessage(message => socket.send(JSON.stringify({type: "pong", id: JSON.parse(String(message)).id})));
  });
  await page.goto("/rvx?runs=run-1");
  await expect(page.locator(".connection-status")).toHaveAttribute("data-state", "connected");
  sockets[0]!.close({code: 1008, reason: "session expired or revoked"});
  await expect.poll(() => sockets.length).toBe(2);
  await expect(page.getByRole("dialog", {name: "Sign in again"})).toHaveCount(0);
  auth.authenticated = false;
  sockets[1]!.close({code: 1008, reason: "session expired or revoked"});
  await expect(page.getByRole("dialog", {name: "Sign in again"})).toBeVisible();
});

test("blocked cookies and unavailable bootstrap remain explicit without unsafe redirects", async ({page}) => {
  await mockApi(page); const auth = await authentication(page); auth.cookieAccepted = false;
  await page.goto("/login/?next=https%3A%2F%2Fevil.example");
  await page.getByLabel("Password", {exact: true}).fill(password);
  await page.getByRole("button", {name: "Sign in", exact: true}).click();
  await expect(page.getByRole("alert")).toContainText("Allow cookies");
  expect(page.url()).toContain("/login/");
  await page.route("**/api/auth/session", route => route.fulfill({status: 503, json: {error: "Unavailable"}}));
  await page.reload();
  await expect(page.getByRole("heading", {name: "Unable to connect"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Retry"})).toBeEnabled();
});
