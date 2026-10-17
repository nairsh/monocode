import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  outputDir: process.env.MONOCODE_QA_OUTPUT
    ? `${process.env.MONOCODE_QA_OUTPUT}/browser-results`
    : "test-results",
  use: {
    baseURL: "http://127.0.0.1:1435",
    viewport: { width: 1000, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {},
      },
    },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1435",
    url: "http://127.0.0.1:1435/tests/browser/transcript.html",
    reuseExistingServer: process.env.MONOCODE_QA_REUSE_SERVER === "1",
  },
});
