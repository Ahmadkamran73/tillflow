import { defineConfig, devices } from "@playwright/test";

// Override when port 3000 is taken: E2E_BASE_URL=http://localhost:3100 pnpm test:e2e
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const port = new URL(baseURL).port || "3000";

// Fake billing settings for the app under test (the published example IBAN, never a real account).
// The webServer below inherits them; a value already in the environment wins.
const fakeBilling: Record<string, string> = {
  BILLING_PRICE_CENTS: "4900",
  BILLING_TRIAL_DAYS: "14",
  BILLING_GRACE_DAYS: "14",
  BILLING_INVOICE_DUE_DAYS: "14",
  BILLING_VAT_RATE: "23",
  BILLING_ACCOUNT_NAME: "Tillflow Test Ltd",
  BILLING_IBAN: "IE29AIBK93115212345678",
  BILLING_BIC: "AIBKIE2D",
  BILLING_VAT_NUMBER: "IE1234567FA",
  BILLING_ADDRESS: "1 Test Street, Dublin",
};
for (const [k, v] of Object.entries(fakeBilling)) process.env[k] ??= v;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: process.env.CI ? [["list"]] : "list",
  globalTimeout: process.env.CI ? 25 * 60_000 : undefined,
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
