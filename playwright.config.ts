import { defineConfig, devices } from "@playwright/test";

// End-to-end view tests: the invoices example served with built views, driven through a real MCP Apps host page.
export default defineConfig({
  testDir: "examples/invoices/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: "http://localhost:4319", ...devices["Desktop Chrome"] },
  webServer: {
    command: "pnpm --filter @syrinx/example-invoices e2e:serve",
    url: "http://localhost:4319/e2e/host.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
