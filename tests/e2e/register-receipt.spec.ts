import { expect, test } from "@playwright/test";
import { hydrated, openDashboard, signUpAndEnrol, uniqueEmail } from "./helpers";

// Needs the local Supabase stack (`supabase start`) and its .env.local values.

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(120_000);

declare global {
  interface Window {
    __prints: number;
  }
}

test("cash sale: change, rounding line, numbered receipt, browser print, VAT invoice", async ({
  page,
}) => {
  // The browser-print fallback: count window.print() calls instead of opening a dialog.
  await page.addInitScript(() => {
    window.__prints = 0;
    window.print = () => {
      window.__prints++;
    };
  });
  await signUpAndEnrol(page, uniqueEmail("receipt"), "E2E receipts");
  const orgId = await openDashboard(page, { vat: "IE6388047V" });

  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Tea bags");
  await page.getByLabel("Price (including VAT)").fill("12.34");
  await page.getByLabel("Barcode").fill("5012345678900");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);

  await page.goto(`/register/${orgId}`);
  const prints = () => page.evaluate(() => window.__prints);
  const receipt = page.locator("#print-receipt");
  const sell = async () => {
    await page.getByRole("button", { name: /^Tea bags/ }).click();
    await page.getByRole("button", { name: "Pay €12.35" }).first().click(); // 5c rounding
    await page.getByRole("button", { name: "€20.00", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  };

  await sell();
  await expect(page.getByText("Change due: €7.65")).toBeVisible();
  await expect.poll(prints).toBe(1);
  await expect(receipt).toContainText("IE6388047V");
  await expect(receipt).toContainText("Till 1 · 000001");
  await expect(receipt).toContainText("Tea bags");
  await expect(receipt).toContainText("VAT 23%");
  await expect(receipt).toContainText("Cash rounding");
  await expect(receipt).toContainText("€0.01");

  // Only the receipt is visible when printing.
  await page.emulateMedia({ media: "print" });
  await expect(receipt).toBeVisible();
  await expect(page.getByRole("button", { name: "New sale" })).toBeHidden();
  await page.emulateMedia({ media: "screen" });

  await page.getByRole("button", { name: "Print receipt" }).click();
  await expect.poll(prints).toBe(2);

  // Sequential numbers per till; the second sale becomes a VAT invoice for a business.
  await page.getByRole("button", { name: "New sale" }).click();
  await sell();
  await expect(receipt).toContainText("Till 1 · 000002");
  await page.getByRole("button", { name: "VAT invoice" }).click();
  await page.getByLabel("Business name").fill("Acme Ltd");
  await page.getByLabel("Business address").fill("5 Quay St, Cork");
  await page.getByLabel("Customer VAT number").fill("IE1234567A");
  await page.getByRole("button", { name: "Print invoice" }).click();
  await expect(page.getByRole("alert")).toContainText("Enter a VAT number");
  await page.getByLabel("Customer VAT number").fill("IE1234567T");
  await page.getByRole("button", { name: "Print invoice" }).click();
  await expect.poll(prints).toBe(4);
  await expect(receipt).toContainText("VAT INVOICE");
  await expect(receipt).toContainText("Acme Ltd");
  await expect(receipt).toContainText("IE1234567T");
  await expect(receipt).toContainText("Till 1 · 000002");
});

test("tender: a short amount is refused", async ({ page }) => {
  await signUpAndEnrol(page, uniqueEmail("tender"), "E2E tender");
  const orgId = await openDashboard(page);
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Milk");
  await page.getByLabel("Price (including VAT)").fill("5");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);
  await page.goto(`/register/${orgId}`);
  await page.getByRole("button", { name: /^Milk/ }).click();
  await page.getByRole("button", { name: "Pay €5.00" }).first().click();
  await page.getByLabel("Other amount").fill("4");
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("alert")).toContainText("less than the amount due");
  await page.getByLabel("Other amount").fill("10");
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByText("Change due: €5.00")).toBeVisible();
});
