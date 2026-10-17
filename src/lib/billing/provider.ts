import { addVat } from "@/lib/money";
import type { BillingConfig } from "./config";
import { formatIban } from "./config";
import { addDays } from "./period";
import { makeReference, monthYear } from "./reference";

/**
 * The seam for automated billing in v2. Everything outside `src/lib/billing` talks to this
 * interface and to `getBillingProvider()`, never to bank-transfer details directly. v1 has exactly
 * one implementation (`bankTransferProvider`); no payment provider is installed or imported.
 *
 * What a provider owns: how an invoice's figures and payment reference are made, and how the
 * customer is told to pay. What it does NOT own: invoice numbers and storage (the database, with
 * its gap-free counter), reminders and pausing (the jobs), and access (`organisations.status`).
 * A v2 card/direct-debit provider would add methods here (create a mandate, receive a webhook)
 * and call the same database functions to mark an invoice paid.
 */
export type Period = { start: string; end: string };

export type InvoiceDraft = {
  id: string;
  orgId: string;
  period: Period;
  amountExVatCents: number;
  vatRateBp: number;
  vatCents: number;
  totalCents: number;
  dueOn: string;
  paymentReference: string;
  /** Who is invoicing: stored on the invoice so a reprint always shows the same details. */
  supplierName: string;
  supplierAddress: string;
  supplierVatNumber: string;
};

export type PaymentInstructions = {
  method: "bank_transfer";
  accountName: string;
  iban: string;
  bic: string;
  reference: string;
  amountCents: number;
  dueOn: string;
};

export interface BillingProvider {
  readonly name: string;
  /** The figures and payment reference of the next invoice (nothing is stored yet). */
  draftInvoice(input: { id: string; orgId: string; period: Period; today: string }): InvoiceDraft;
  /** How the customer pays this invoice. */
  paymentInstructions(invoice: {
    paymentReference: string;
    totalCents: number;
    dueOn: string;
  }): PaymentInstructions;
}

/** v1: one fixed price, VAT added on top, paid by SEPA transfer quoting the payment reference. */
export function bankTransferProvider(config: BillingConfig): BillingProvider {
  return {
    name: "bank_transfer",
    draftInvoice({ id, orgId, period, today }) {
      const { net, vat, gross } = addVat(config.priceCents, config.vatRateBp);
      const [year, month] = period.start.split("-").map(Number) as [number, number];
      return {
        id,
        orgId,
        period,
        amountExVatCents: net,
        vatRateBp: config.vatRateBp,
        vatCents: vat,
        totalCents: gross,
        dueOn: addDays(today, config.invoiceDueDays),
        paymentReference: makeReference(monthYear(month, year)),
        supplierName: config.supplierName,
        supplierAddress: config.address,
        supplierVatNumber: config.vatNumber,
      };
    },
    paymentInstructions(invoice) {
      return {
        method: "bank_transfer",
        accountName: config.accountName,
        iban: formatIban(config.iban),
        bic: config.bic,
        reference: invoice.paymentReference,
        amountCents: invoice.totalCents,
        dueOn: invoice.dueOn,
      };
    },
  };
}

/** The provider in force. v2 chooses between providers here (a setting), nowhere else. */
export function getBillingProvider(config: BillingConfig): BillingProvider {
  return bankTransferProvider(config);
}
