import { expect, test } from "@playwright/test";
import { config } from "dotenv";
import postgres from "postgres";
import {
  PASSWORD,
  emailedLink,
  hydrated,
  openDashboard,
  openTill,
  signUpAndEnrol,
  uniqueEmail,
} from "./helpers";

// Needs the local Supabase stack and .env.local (DIRECT_URL looks at the server's tables as an
// administrator and runs the summary rebuild the background job would run every few minutes).

config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(150_000);

test("two cash sales show on the dashboard, the VAT report and the downloads", async ({ page }) => {
  await signUpAndEnrol(page, uniqueEmail("reports"), "E2E reports");
  const orgId = await openDashboard(page, { vat: "IE6388047V" });

  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Tea bags");
  await page.getByLabel("Price (including VAT)").fill("12.34");
  await page.getByLabel("Barcode").fill("5012345678900");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);

  await openTill(page, orgId);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: /^Tea bags/ }).click();
    await page.getByRole("button", { name: "Pay €12.34" }).first().click();
    await page.getByRole("button", { name: "Cash", exact: true }).click();
    await page.getByRole("button", { name: "€20.00", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
    await page.getByRole("button", { name: "New sale" }).click();
  }
  await expect
    .poll(
      async () => (await sql`select count(*)::int as n from sales where org_id = ${orgId}`)[0]!.n,
    )
    .toBe(2);

  // Before the job has run the dashboard cannot know about the sales; after it, it does.
  await sql`select ops.rebuild_dirty_summaries(500, 0)`;

  await page.goto(`/o/${orgId}/dashboard`);
  const sales = page.locator("div", { has: page.getByText("Sales today", { exact: true }) }).last();
  await expect(sales).toContainText("€24.70"); // two sales of 12.35: cash rounded to 5c
  await expect(page.getByText("Tea bags").first()).toBeVisible();
  await expect(page.getByText("2 sold")).toBeVisible();

  await page.goto(`/o/${orgId}/reports`);
  await expect(page.getByRole("link", { name: "Sales by day" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Serial numbers sold" })).toHaveCount(0); // electronics only

  await page.goto(`/o/${orgId}/reports/vat`);
  const table = page.getByTestId("report-table");
  await expect(table.getByRole("row", { name: /^23%/ })).toContainText("€20.06");
  await expect(table.getByRole("row", { name: /^23%/ })).toContainText("€4.62");
  await expect(table.getByRole("row", { name: /^23%/ })).toContainText("€24.68");
  await expect(table.getByRole("row", { name: /^Total/ })).toContainText("€4.62");

  // A bad range is explained, not silently replaced.
  await page.goto(`/o/${orgId}/reports/vat?from=2026-02-30&to=2026-03-01`);
  await expect(page.getByText("Choose real dates")).toBeVisible();

  // Downloads are exactly what the screen shows.
  const q = "from=2000-01-01&to=2000-12-31";
  await page.goto(`/o/${orgId}/reports/vat`);
  const href = await page.getByRole("link", { name: /^CSV/ }).getAttribute("href");
  const csv = await page.request.get(href!);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(csv.headers()["content-disposition"]).toContain("attachment");
  const csvText = await csv.text();
  expect(csvText).toContain("VAT rate,Net (ex VAT),Sales VAT");
  expect(csvText).toContain("23%,20.06,4.62,24.68");
  expect(csvText).toContain("Total,20.06,4.62,24.68");

  const xlsx = await page.request.get(href!.replace("format=csv", "format=xlsx"));
  expect(xlsx.status()).toBe(200);
  expect((await xlsx.body()).subarray(0, 2).toString()).toBe("PK");
  const pdf = await page.request.get(href!.replace("format=csv", "format=pdf"));
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // Bad requests and other shops get nothing.
  expect((await page.request.get(`/o/${orgId}/reports/vat/export?format=exe&${q}`)).status()).toBe(
    400,
  );
  expect(
    (await page.request.get(`/o/${orgId}/reports/vat/export?format=csv&from=x&to=y`)).status(),
  ).toBe(400);
  expect(
    (await page.request.get(`/o/${orgId}/reports/serials/export?format=csv&${q}`)).status(),
  ).toBe(404);
  expect(
    (
      await page.request.get(
        `/o/00000000-0000-4000-8000-000000000000/reports/vat/export?format=csv&${q}`,
      )
    ).status(),
  ).toBe(404);
});

test("the owner asks for all their data, gets a ZIP once, and only one a day", async ({ page }) => {
  await signUpAndEnrol(page, uniqueEmail("account-export"), "E2E account export");
  const orgId = await openDashboard(page);

  await page.goto(`/o/${orgId}/settings/export`);
  await hydrated(page);
  await page.getByRole("button", { name: "Prepare my export" }).click();
  await expect(page.getByRole("status")).toContainText("We are preparing your export");

  const status = async () =>
    (await sql`select id, status from account_exports where org_id = ${orgId}`)[0]!;
  const { id } = await status();
  // The background worker normally builds it within seconds; if this run has none, do its steps.
  await expect
    .poll(async () => (await status()).status, { timeout: 20_000 })
    .toBe("ready")
    .catch(async () => {
      if ((await status()).status !== "queued") return; // the worker is on it: do not race it
      await sql`select ops.account_export_begin(${id})`;
      await sql`select ops.account_export_finish(${id}, 'test.zip', ${Buffer.from("PK-test")})`;
    });

  await page.reload();
  await expect(page.getByRole("cell", { name: "Ready" })).toBeVisible();
  const link = page.getByRole("link", { name: "Download ZIP" });
  const res = await page.request.get((await link.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/zip");
  expect((await res.body()).subarray(0, 2).toString()).toBe("PK");
  expect(
    (await sql`select count(*)::int as n from audit_log where org_id = ${orgId} and action = 'account.export_downloaded'`)[0]!.n,
  ).toBe(1);

  // One a day.
  await page.getByRole("button", { name: "Prepare my export" }).click();
  await expect(page.getByText("You can ask for one export a day")).toBeVisible();

  // Not for other shops or made-up ids.
  expect(
    (await page.request.get(`/o/00000000-0000-4000-8000-000000000000/settings/export/${id}/download`)).status(),
  ).toBe(404);
  expect((await page.request.get(`/o/${orgId}/settings/export/${"0".repeat(8)}-0000-4000-8000-000000000000/download`)).status()).toBe(404);
});

test("an owner without two-step verification must type the password again for the export", async ({
  page,
}) => {
  const email = uniqueEmail("account-export-pw");
  await page.goto("/signup");
  await page.getByLabel("Business name").fill("Export password shop");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  await page.goto(await emailedLink(email)); // an emailed link is not a password sign-in
  await page.getByRole("button", { name: "Create business" }).click();
  await page.getByRole("link", { name: "Skip for now" }).click();
  const orgId = await openDashboard(page);

  await page.goto(`/o/${orgId}/settings/export`);
  await hydrated(page);
  await page.getByRole("button", { name: "Prepare my export" }).click();
  await expect(page).toHaveURL(/\/settings\/export\/confirm/);
  await expect(page.getByText("Enter your password to continue")).toBeVisible();
  expect((await sql`select count(*)::int as n from account_exports where org_id = ${orgId}`)[0]!.n).toBe(0);

  await hydrated(page);
  await page.getByLabel("Password").fill("not-my-password");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Incorrect password.")).toBeVisible();

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(/\/settings\/export$/);
  await hydrated(page);
  await page.getByRole("button", { name: "Prepare my export" }).click();
  await expect(page.getByRole("status")).toContainText("We are preparing your export");
  expect((await sql`select count(*)::int as n from account_exports where org_id = ${orgId}`)[0]!.n).toBe(1);
});
