const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests/console",
  testMatch: "*.spec.cjs",
  timeout: 120000,
  expect: { timeout: 10000 },
  workers: 1,
  fullyParallel: false,
  use: {
    actionTimeout: 15000,
    baseURL: "http://127.0.0.1:3210",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    command: "node tests/console/server.cjs",
    url: "http://127.0.0.1:3210/api/health",
    timeout: 60000,
    reuseExistingServer: false,
  },
});
