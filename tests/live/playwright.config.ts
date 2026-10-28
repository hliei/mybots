import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "deepseek.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 300000,
  expect: { timeout: 15000 },
  use: { browserName: "chromium", headless: true, trace: "off", screenshot: "off", video: "off" },
  reporter: "list",
});
