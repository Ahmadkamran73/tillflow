import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hydrated } from "../e2e/helpers";

// The full-account ZIP on the real staging host, with a big shop (seeded with
// scripts/large-export-check.ts --staging --seed-only). Screens only: sign in as the shop's owner
// (STAGING_E2E_ELECTRONICS_*), ask for the export, watch /api/health while it builds, download it
// from the exports page and keep the file in OUT_DIR for checking. Once per shop per day.

config({ path: ".env.local", quiet: true });
test.setTimeout(2_400_000);

const OUT_DIR = process.env.LARGE_EXPORT_OUT ?? "test-results/large-export";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await hydrated(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page
    .getByRole("button", { name: /log in|sign in/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/dashboard$/, { timeout: 30_000 });
  return /\/o\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
}

test("staging · large export: request, build on the host, download, health during", async ({
  page,
  browser,
  baseURL,
}) => {
  const email = process.env.STAGING_E2E_ELECTRONICS_EMAIL;
  const password = process.env.STAGING_E2E_ELECTRONICS_PASSWORD;
  test.skip(!email || !password, "no electronics staging account");
  const orgId = await signIn(page, email!, password!);

  await page.goto(`/o/${orgId}/settings/export`);
  await hydrated(page);
  await page.getByRole("button", { name: "Prepare my export" }).click();
  if (/\/settings\/export\/confirm/.test(page.url())) {
    await hydrated(page);
    await page.getByLabel("Password").fill(password!);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page).toHaveURL(/\/settings\/export$/);
    await hydrated(page);
    await page.getByRole("button", { name: "Prepare my export" }).click();
  }
  await expect(page.getByRole("status")).toContainText("We are preparing your export");
  const t0 = Date.now();

  // While it builds, the app must stay responsive.
  const health: number[] = [];
  let healthFailures = 0;
  let stop = false;
  const watcher = (async () => {
    while (!stop) {
      const s = Date.now();
      const r = await fetch(`${baseURL}/api/health`).catch(() => null);
      if (!r || r.status !== 200) healthFailures++;
      health.push(Date.now() - s);
      await new Promise((res) => setTimeout(res, 3000));
    }
  })();

  let href: string | null = null;
  let readySeconds = 0;
  for (let i = 0; i < 200 && !href; i++) {
    await page.waitForTimeout(10_000);
    await page.goto(`/o/${orgId}/settings/export`);
    href = await page
      .locator("main a")
      .evaluateAll(
        (as) =>
          as
            .map((a) => a.getAttribute("href"))
            .find((h) => /\/export\/[0-9a-f-]{36}\/download$/.test(h ?? "")) ?? null,
      );
    readySeconds = Math.round((Date.now() - t0) / 1000);
  }
  expect(href, "a Download link on the exports page").toBeTruthy();

  const d0 = Date.now();
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  const body = await res.body();
  const downloadSeconds = (Date.now() - d0) / 1000;
  stop = true;
  await watcher;
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, "export.zip");
  writeFileSync(file, body);

  // Another shop's owner (the general-store account) must get 404 on this link.
  const other = process.env.STAGING_E2E_EMAIL;
  let otherStatus = "not tried";
  if (other && process.env.STAGING_E2E_PASSWORD) {
    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    await signIn(p2, other, process.env.STAGING_E2E_PASSWORD);
    otherStatus = String((await p2.request.get(new URL(href!, baseURL).toString())).status());
    await ctx.close();
  }
  const anon = await fetch(new URL(href!, baseURL).toString(), { redirect: "manual" });

  const sorted = [...health].sort((a, b) => a - b);
  const report = {
    readySeconds,
    downloadSeconds,
    bytes: body.length,
    mb: Math.round((body.length / 1_048_576) * 10) / 10,
    healthChecks: health.length,
    healthFailures,
    healthMedianMs: sorted[Math.floor(sorted.length / 2)],
    healthMaxMs: sorted[sorted.length - 1],
    otherShopOwnerStatus: otherStatus,
    signedOutStatus: anon.status,
    file,
  };
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  expect(healthFailures).toBe(0);
  expect(otherStatus).toBe("404");
});
