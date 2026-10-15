import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

// Runs the staging trading-day checks (tests/e2e-staging) against the real staging app, with a
// person's view only: no database access. Never point this at production.
//   pnpm exec playwright test -c playwright.staging.config.ts
config({ path: ".env.local", quiet: true });
const baseURL = process.env.STAGING_URL ?? "https://staging.tillflow.ie";
const host = new URL(baseURL).hostname;
if (!/^staging\./.test(host) && host !== "localhost" && host !== "127.0.0.1") {
  throw new Error(`Refusing to run the staging checks against ${host}`);
}

export default defineConfig({
  testDir: "./tests/e2e-staging",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  expect: { timeout: 15_000 },
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } },
    },
  ],
});
