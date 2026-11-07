import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node --import tsx tests/start-server.ts",
    url: "http://127.0.0.1:3100/sign-in",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
    timeout: 120_000,
  },
});
