import {defineConfig} from "@playwright/test";

const baseURL = process.env.RVX_TEST_BASE_URL ?? "http://127.0.0.1:4174";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: "line",
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    viewport: {width: 1440, height: 900},
    trace: "retain-on-failure",
  },
  webServer: process.env.RVX_TEST_BASE_URL ? undefined : {
    command: "npm run preview",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
