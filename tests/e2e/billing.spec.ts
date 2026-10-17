import { expect, test, request as pwRequest } from "@playwright/test";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { makeReference } from "../../src/lib/billing/reference";
import {
  hydrated,
  openDashboard,
  openTill,
  signUpAndEnrol,
  uniqueEmail,
  unlockTill,
} from "./helpers";

// Needs the local Supabase stack and .env.local (DIRECT_URL acts as the billing job would: it
// creates the subscription and issues the invoice). playwright.config.ts gives the app fake bank
// details (the published example IBAN), so no real account number is ever used in tests.

config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(240_000);

const today = () => new Date().toISOString().slice(0, 10);

async function issueInvoice(orgId: string) {
  await sql`insert into subscriptions (id, org_id, status, price_cents)
            values (${randomUUID()}, ${orgId}, 'trial', 4900) on conflict (org_id) do nothing`;
  const reference = makeReference("1126");
  const figures = {
    id: randomUUID(),
    org_id: orgId,
    period_start: "2026-11-01",
    period_end: "2026-12-01",
    amount_ex_vat_cents: 4900,
    vat_rate_bp: 2300,
    vat_cents: 1127,
    total_cents: 6027,
    due_on: "2099-01-01",
    payment_reference: reference,
    supplier_name: "Tillflow Test Ltd",
    supplier_address: "1 Test Street, Dublin",
    supplier_vat_number: "IE1234567FA",
  };
  const [row] = await sql`select ops.billing_issue_invoice(${sql.json(figures)}) as r`;
  return { reference, id: figures.id, no: (row!.r as { invoice_no: number }).invoice_no };
}

test("an owner sees the invoice and the payment reference, copies it and downloads the PDF", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signUpAndEnrol(page, uniqueEmail("billing-owner"), "E2E billing");
  const orgId = await openDashboard(page);
  const inv = await issueInvoice(orgId);

  await page.goto(`/o/${orgId}/billing`);
  await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible();
  await expect(page.getByText("Free trial", { exact: true })).toBeVisible();
  await expect(page.getByText(inv.reference)).toBeVisible();
  await expect(page.getByText("IE29 AIBK 9311 5212 3456 78")).toBeVisible();
  await expect(page.getByText("Outstanding invoice")).toContainText("€60.27");

  await page.getByRole("button", { name: "Copy Payment reference" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied" }).first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(inv.reference);

  const link = page.getByRole("link", { name: /Download PDF/ });
  const href = await link.getAttribute("href");
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.headers()["content-disposition"]).toContain(
    `INV-${String(inv.no).padStart(6, "0")}.pdf`,
  );

  // Signed out, or another invoice id, gets nothing.
  const anon = await pwRequest.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
  });
  expect((await anon.get(href!, { maxRedirects: 0 })).status()).toBe(307); // the proxy sends signed-out visitors to the login page
  await anon.dispose();
  expect(
    (await page.request.get(`/o/${orgId}/billing/invoices/${randomUUID()}/pdf`)).status(),
  ).toBe(404);
  expect((await page.request.get(`/o/${orgId}/billing/invoices/not-an-id/pdf`)).status()).toBe(404);
});

test("a paused business is read-only on the till, still exports, and a super-admin reopens it by marking the invoice paid", async ({
  page,
}) => {
  const email = uniqueEmail("billing-admin");
  await signUpAndEnrol(page, email, "E2E paused");
  const orgId = await openDashboard(page);

  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Tea bags");
  await page.getByLabel("Price (including VAT)").fill("12.34");
  await page.getByLabel("Barcode").fill("5012345678900");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);

  const inv = await issueInvoice(orgId);

  // The till is paired while the business is open (a paused business cannot pair a new one).
  await openTill(page, orgId);

  // Not a super-admin yet: the admin panel is a 404 for them.
  const notFound = await page.goto("/admin/billing");
  expect(notFound?.status()).toBe(404);

  // The job pauses the business (the database function it calls).
  await sql`select ops.billing_pause(${orgId}, ${inv.id}, '2099-06-01'::date)`;

  // Back office: banner on every page, with the way to pay.
  await page.goto(`/o/${orgId}/dashboard`);
  await expect(
    page.getByText("This account is read-only because an invoice is unpaid."),
  ).toBeVisible();
  await page.goto(`/o/${orgId}/billing`);
  await expect(page.getByText("Read-only until paid")).toBeVisible();

  // Exports still work: data is never locked in.
  const csv = await page.request.get(
    `/o/${orgId}/reports/vat/export?format=csv&from=${today()}&to=${today()}`,
  );
  expect(csv.status()).toBe(200);

  // The till shows the notice and will not take a sale.
  await page.goto(`/register/${orgId}`);
  await unlockTill(page);
  await expect(
    page.getByText("This business is read-only because an invoice is unpaid."),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Tea bags/ }).click();
  const pay = page.getByRole("button", { name: "Read-only: unpaid invoice" }).first();
  await expect(pay).toHaveAttribute("aria-disabled", "true");

  // Make the owner a super-admin (a one-off statement per environment in real life).
  const [user] = await sql`select id from auth.users where email = ${email}`;
  await sql`insert into platform_admins (user_id) values (${user!.id})`;

  await page.goto("/admin/billing?filter=overdue");
  await expect(page.getByRole("heading", { name: "Billing admin" })).toBeVisible();
  // The invoice is due in 2099, so it is in Outstanding.
  await page.getByRole("link", { name: "Outstanding" }).click();
  const row = page.getByRole("row").filter({ hasText: inv.reference });
  await expect(row).toBeVisible();
  await row.locator("summary", { hasText: "Mark as paid" }).click();
  // A bank reference is required.
  await row.getByLabel("Date received").fill(today());
  await row.getByRole("button", { name: "Confirm payment received" }).click();
  await expect(page).toHaveURL(/filter=outstanding$/); // the browser refused the empty required field
  await row.getByLabel("Bank reference").fill("SEPA E2E 424242");
  await row.getByRole("button", { name: "Confirm payment received" }).click();
  await expect(page.getByText("Marked as paid. The account is open.")).toBeVisible();

  const [org] = await sql`select status from organisations where id = ${orgId}`;
  expect(org!.status).toBe("active");
  const audit =
    await sql`select action from audit_log where org_id = ${orgId} and action = 'billing.marked_paid'`;
  expect(audit).toHaveLength(1);

  // The paid list shows it, and the owner's page no longer shows the banner.
  await page.getByRole("link", { name: "Paid", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: inv.reference })).toContainText(
    "SEPA E2E 424242",
  );
  await page.goto(`/o/${orgId}/dashboard`);
  await expect(
    page.getByText("This account is read-only because an invoice is unpaid."),
  ).toHaveCount(0);
});
