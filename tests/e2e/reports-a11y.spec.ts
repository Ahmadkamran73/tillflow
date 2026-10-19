import { expect, test } from "@playwright/test";
import { hydrated, openDashboard, openTill, signUpAndEnrol, uniqueEmail } from "./helpers";

// What a screen reader is given: roles, names, states and focus, read from the browser's own
// accessibility tree. This is NOT a run with NVDA, JAWS or VoiceOver (see docs/specs/reports.md).

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(150_000);

test("dashboard, report filters, tables, errors and export status as assistive technology sees them", async ({
  page,
}) => {
  await signUpAndEnrol(page, uniqueEmail("a11y"), "E2E a11y");
  const orgId = await openDashboard(page);

  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Tea bags");
  await page.getByLabel("Price (including VAT)").fill("12.34");
  await page.getByLabel("Barcode").fill("5012345678900");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);
  await openTill(page, orgId);
  await page.getByRole("button", { name: /^Tea bags/ }).click();
  await page.getByRole("button", { name: "Pay €12.34" }).first().click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "€20.00", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  const { default: postgres } = await import("postgres");
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  const sql = postgres(process.env.DIRECT_URL ?? "", { max: 1, onnotice: () => {} });
  try {
    await expect
      .poll(
        async () => (await sql`select count(*)::int as n from sales where org_id = ${orgId}`)[0]!.n,
      )
      .toBe(1);
    await sql`select ops.rebuild_dirty_summaries(500, 0)`;
  } finally {
    await sql.end();
  }

  // --- Dashboard: one h1, a named "Today" section, labelled terms with their figures.
  await page.goto(`/o/${orgId}/dashboard`);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  const today = page.getByRole("region", { name: "Today" });
  await expect(today.getByRole("heading", { level: 2, name: "Today" })).toBeAttached();
  await expect(today.getByRole("term")).toHaveCount(3 + 2); // general store: 3 basics + movers + low stock
  await expect(today.getByRole("definition").first()).toContainText("€");
  // The comparison is words, never colour: it says what last week was.
  await expect(today).toContainText(/Last \w+day, whole day: €/);
  await expect(today.getByRole("link", { name: "All reports" })).toBeVisible();

  // --- Report filters: a labelled search form with real labels, 48px controls.
  await page.goto(`/o/${orgId}/reports/vat`);
  const form = page.getByRole("search", { name: "Dates" });
  await expect(form.getByLabel("From")).toBeVisible();
  await expect(form.getByLabel("To")).toBeVisible();
  for (const name of ["From", "To"]) {
    const box = await form.getByLabel(name).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(47);
  }
  await expect(form.getByRole("button", { name: "Show report" })).toBeVisible();

  // The current quick range is exposed, with a tick as text.
  const last30 = page
    .getByRole("navigation", { name: "Quick ranges" })
    .getByRole("link", { name: /Last 30 days/ });
  await expect(last30).toHaveAttribute("aria-current", "true");
  await expect(last30).toContainText("✓");

  // --- Table: a scrollable named region, column and row headers, a totals row in a footer.
  const region = page.getByRole("region", { name: "VAT by rate" });
  await expect(region).toHaveAttribute("tabindex", "0");
  const table = region.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveCount(8);
  await expect(table.getByRole("rowheader", { name: "23%" })).toBeVisible();
  await expect(table.getByRole("rowheader", { name: "Total" })).toBeVisible();
  await expect(table.locator("tfoot")).toHaveCount(1);
  await region.focus();
  await expect(region).toBeFocused();

  // --- Validation error: announced (alert), focus moves to it, both fields point at it.
  await page.goto(`/o/${orgId}/reports/vat?from=2026-02-30&to=2026-03-01`);
  const error = page.locator('p[role="alert"]').filter({ hasText: "Choose real dates" });
  await expect(error).toBeVisible();
  await expect(error).toBeFocused();
  await expect(error).toHaveAttribute("id", "range-error");
  for (const name of ["From", "To"]) {
    const field = page.getByLabel(name, { exact: true });
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAttribute("aria-describedby", "range-error");
  }

  // --- Download failure message arrives as an alert with focus (a refused download comes back here).
  await page.goto(`/o/${orgId}/reports/vat?from=2026-10-01&to=2026-10-14&export=limit`);
  const limit = page.locator('p[role="alert"]').filter({ hasText: "downloaded a lot" });
  await expect(limit).toBeFocused();

  // --- Export request status: a status region that takes focus; the repeated link says which file.
  await page.goto(`/o/${orgId}/settings/export`);
  await hydrated(page);
  await page.getByRole("button", { name: "Prepare my export" }).click();
  const status = page
    .locator('p[role="status"]')
    .filter({ hasText: "We are preparing your export" });
  await expect(status).toBeVisible();
  await expect(status).toBeFocused();
  await expect(page.getByRole("region", { name: "Your exports" })).toBeVisible();
});
