// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseBillingConfig } from "@/lib/billing/config";
import { renderInvoicePdf, type InvoiceView } from "@/lib/billing/invoice-pdf";

const config = (() => {
  const r = parseBillingConfig({
    BILLING_PRICE_CENTS: "4900",
    BILLING_TRIAL_DAYS: "14",
    BILLING_GRACE_DAYS: "14",
    BILLING_INVOICE_DUE_DAYS: "14",
    BILLING_VAT_RATE: "23",
    BILLING_ACCOUNT_NAME: "Tillflow Ltd",
    BILLING_IBAN: "IE29AIBK93115212345678",
    BILLING_BIC: "AIBKIE2D",
    BILLING_VAT_NUMBER: "IE1234567FA",
    BILLING_ADDRESS: "1 Main Street, Dublin",
  });
  if (!r.ok) throw new Error("config");
  return r.config;
})();

const invoice: InvoiceView = {
  invoiceNo: 123,
  issuedOn: "2026-11-01",
  dueOn: "2026-11-15",
  periodStart: "2026-11-01",
  periodEnd: "2026-12-01",
  amountExVatCents: 4900,
  vatRateBp: 2300,
  vatCents: 1127,
  totalCents: 6027,
  paymentReference: "TF-7K3Q-1126-K",
  supplierName: "Tillflow Ltd",
  supplierAddress: "1 Main Street, Dublin",
  supplierVatNumber: "IE1234567FA",
  customerName: "Corner Shop Ltd",
  customerAddress: "5 High Street, Cork",
  customerVatNumber: "IE9876543A",
  paid: false,
};

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Reads the PDF back with pdfjs (the same helper the whole-day tests use). */
async function textOf(inv: InvoiceView): Promise<string> {
  const pdf = await renderInvoicePdf(inv, config);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  dir = mkdtempSync(join(tmpdir(), "tf-invoice-"));
  const file = join(dir, "invoice.pdf");
  writeFileSync(file, pdf);
  return execFileSync(
    process.execPath,
    [join("tests", "e2e", "day", "pdf-text.mjs"), file, "flow"],
    {
      encoding: "utf8",
    },
  );
}

describe("invoice PDF", () => {
  it("carries our VAT number, the sequential number, the VAT rate and amount, the bank details and the payment reference", async () => {
    const text = (await textOf(invoice)).replace(/\s+/g, " ");
    for (const must of [
      "Tillflow Ltd",
      "1 Main Street, Dublin",
      "VAT number",
      "IE1234567FA",
      "INV-000123",
      "01/11/2026",
      "15/11/2026",
      "VAT 23%",
      "€49.00",
      "€11.27",
      "€60.27",
      "IE29 AIBK 9311 5212 3456 78",
      "AIBKIE2D",
      "TF-7K3Q-1126-K",
      "Corner Shop Ltd",
      "5 High Street, Cork",
      "IE9876543A",
      "01/11/2026 to 30/11/2026", // the period, last day inclusive
    ]) {
      expect(text, must).toContain(must);
    }
    expect(text).not.toContain("Paid. Thank you.");
  });

  it("says so on a paid invoice, and does not show a customer VAT number it does not have", async () => {
    const text = (await textOf({ ...invoice, paid: true, customerVatNumber: null })).replace(
      /\s+/g,
      " ",
    );
    expect(text).toContain("Paid. Thank you.");
    expect(text).not.toContain("IE9876543A");
  });

  it("prints the supplier and customer stored on the invoice, whatever the settings say now", async () => {
    const text = (
      await textOf({ ...invoice, supplierName: "Old Name Ltd", supplierVatNumber: "IE0000000XX", customerAddress: null })
    ).replace(/s+/g, " ");
    expect(text).toContain("Old Name Ltd");
    expect(text).toContain("IE0000000XX");
    expect(text).not.toContain("5 High Street, Cork");
  });

  it("prints the stored figures, not a recalculation (a 13.5% invoice stays 13.5%)", async () => {
    const text = (
      await textOf({ ...invoice, vatRateBp: 1350, vatCents: 662, totalCents: 5562 })
    ).replace(/\s+/g, " ");
    expect(text).toContain("VAT 13.5%");
    expect(text).toContain("€6.62");
    expect(text).toContain("€55.62");
  });
});
