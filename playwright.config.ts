import { defineConfig, devices } from "@playwright/test";

// Override when port 3000 is taken: E2E_BASE_URL=http://localhost:3100 pnpm test:e2e
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const port = new URL(baseURL).port || "3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: process.env.CI ? [["list"]] : "list",
  globalTimeout: process.env.CI ? 10 * 60_000 : undefined,
  expect: { timeout: 10_000 }, // the dev server compiles routes on first hit
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // CI tests the production build (`pnpm build` runs first); locally it uses the dev server.
    command: process.env.CI
      ? `node node_modules/next/dist/bin/next start --port ${port}`
      : `pnpm exec next dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
