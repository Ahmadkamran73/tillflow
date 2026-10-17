import "server-only";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { loadBillingConfig, type BillingConfig } from "@/lib/billing/config";
import {
  invoiceFileName,
  invoiceNumber,
  irishDate,
  renderInvoicePdf,
} from "@/lib/billing/invoice-pdf";
import { addDays, dublinDate, dunningState } from "@/lib/billing/period";
import { getBillingProvider, type Period } from "@/lib/billing/provider";
import { nextPeriod } from "@/lib/billing/schedule";
import { sendMail, type MailResult } from "@/lib/email";
import { logger } from "@/lib/logger";
import { formatCents } from "@/lib/money";
import {
  billingCandidates,
  billingEnsureSubscriptions,
  billingInvoiceContext,
  billingIssueInvoice,
  billingMarkEmailed,
  billingMarkOverdue,
  billingOpenInvoices,
  billingPause,
  billingPendingEmails,
  billingReminderClaim,
  billingReminderRelease,
} from "@/lib/ops/db";
import type { JobHandler } from "../boss";

/**
 * Billing jobs (spec: docs/specs/billing.md). Both run hourly and are safe to run twice or after
 * downtime: invoices are unique per (business, period), emails and reminders are stamped on the
 * invoice, and the database decides every state change. Nothing here ever deletes data.
 */

const context = z.object({
  invoice: z.object({
    id: z.uuid(),
    org_id: z.uuid(),
    invoice_no: z.number().int(),
    period_start: z.string(),
    period_end: z.string(),
    amount_ex_vat_cents: z.number().int(),
    vat_rate_bp: z.number().int(),
    vat_cents: z.number().int(),
    total_cents: z.number().int(),
    issued_at: z.string(),
    due_on: z.string(),
    payment_reference: z.string(),
    status: z.string(),
    supplier_name: z.string(),
    supplier_address: z.string(),
    supplier_vat_number: z.string(),
    customer_name: z.string(),
    customer_address: z.string().nullable(),
    customer_vat_number: z.string().nullable(),
  }),
  org_name: z.string(),
  legal_name: z.string().nullable(),
  vat_number: z.string().nullable(),
  emails: z.array(z.string()),
});
type Context = z.infer<typeof context>;

const appUrl = () =>
  (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
const billingPage = (orgId: string) => `${appUrl()}/o/${orgId}/billing`;

function configOrStop(job: string): BillingConfig | null {
  const r = loadBillingConfig();
  if (r.ok) return r.config;
  // Names of the settings only. Billing stays off until they are right; nobody is invoiced from a guess.
  logger.error({ job, problems: r.errors }, "billing is not configured: job skipped");
  return null;
}

const read = async (invoiceId: string): Promise<Context | null> => {
  const raw = await billingInvoiceContext(invoiceId);
  return raw ? context.parse(raw) : null;
};

/** Sends to every owner; true if at least one address got it (so a bounce does not resend to the rest). */
async function mailOwners(
  d: Context,
  subject: string,
  text: string,
  attachments?: Parameters<typeof sendMail>[0]["attachments"],
): Promise<boolean> {
  if (d.emails.length === 0) {
    logger.warn({ job: "billing", invoice: d.invoice.id }, "no owner address to email");
    return false;
  }
  let sent = 0;
  for (const to of d.emails) {
    const r: MailResult = await sendMail({
      from: process.env.ALERT_FROM,
      to,
      subject,
      text,
      attachments,
    });
    if (r === "sent") sent++;
  }
  return sent > 0;
}

function payLines(d: Context, config: BillingConfig): string[] {
  return [
    `Amount: ${formatCents(d.invoice.total_cents)} (includes VAT)`,
    `Pay by bank transfer to ${config.accountName}`,
    `IBAN: ${config.iban}`,
    `BIC: ${config.bic}`,
    `Payment reference: ${d.invoice.payment_reference}  (please quote it exactly)`,
  ];
}

export function invoiceEmailText(
  d: Context,
  config: BillingConfig,
): { subject: string; text: string } {
  const no = invoiceNumber(d.invoice.invoice_no);
  return {
    subject: `[Tillflow] Invoice ${no} · ${formatCents(d.invoice.total_cents)} due ${irishDate(d.invoice.due_on)}`,
    text: [
      `Hello,`,
      ``,
      `Your Tillflow POS invoice for ${d.org_name} is attached (${no}).`,
      ``,
      ...payLines(d, config),
      `Due: ${irishDate(d.invoice.due_on)}`,
      ``,
      `You can see your invoices and our bank details any time at ${billingPage(d.invoice.org_id)}.`,
      ``,
      `If you have already paid, thank you: we match payments by hand and your account will update soon.`,
    ].join("\n"),
  };
}

export function reminderEmailText(
  d: Context,
  config: BillingConfig,
  n: 1 | 2,
): { subject: string; text: string } {
  const no = invoiceNumber(d.invoice.invoice_no);
  // The account is paused early on the day AFTER the last grace day, so "by the end of" the last one.
  const pauseOn = irishDate(addDays(d.invoice.due_on, config.graceDays));
  return {
    subject:
      n === 1
        ? `[Tillflow] Reminder: invoice ${no} is due`
        : `[Tillflow] Second reminder: invoice ${no} is overdue`,
    text: [
      `Hello,`,
      ``,
      n === 1
        ? `Invoice ${no} for ${d.org_name} was due on ${irishDate(d.invoice.due_on)} and we have not yet seen the payment.`
        : `Invoice ${no} for ${d.org_name} is now 7 days overdue.`,
      ``,
      ...payLines(d, config),
      ``,
      n === 2
        ? `If it is not paid by the end of ${pauseOn}, your account switches to read-only: you can still look at your data and download it, but you cannot make sales until the invoice is paid. Nothing is deleted.`
        : `Your account keeps working. Please pay within the next few days to avoid it being switched to read-only.`,
      ``,
      `Invoices and bank details: ${billingPage(d.invoice.org_id)}`,
      `If you have already paid, thank you: we match payments by hand.`,
    ].join("\n"),
  };
}

export function pausedEmailText(d: Context): { subject: string; text: string } {
  const no = invoiceNumber(d.invoice.invoice_no);
  return {
    subject: `[Tillflow] ${d.org_name} is now read-only until invoice ${no} is paid`,
    text: [
      `Hello,`,
      ``,
      `Invoice ${no} (${formatCents(d.invoice.total_cents)}) is still unpaid, so ${d.org_name} has been switched to read-only.`,
      `You can still view your data and download reports and your full export. You cannot make sales, refunds or changes until it is paid. Nothing has been deleted.`,
      ``,
      `Pay with payment reference ${d.invoice.payment_reference}. Details: ${billingPage(d.invoice.org_id)}`,
      `Once we see the payment your account is reopened.`,
    ].join("\n"),
  };
}

// ------------------------------------------------------------------------------ invoicing

/** Issues one invoice, trying a fresh payment reference if the random part clashes (rare). */
async function issue(config: BillingConfig, orgId: string, period: Period, today: string) {
  const provider = getBillingProvider(config);
  for (let attempt = 1; ; attempt++) {
    const d = provider.draftInvoice({ id: uuidv7(), orgId, period, today });
    try {
      return await billingIssueInvoice({
        id: d.id,
        org_id: d.orgId,
        period_start: d.period.start,
        period_end: d.period.end,
        amount_ex_vat_cents: d.amountExVatCents,
        vat_rate_bp: d.vatRateBp,
        vat_cents: d.vatCents,
        total_cents: d.totalCents,
        due_on: d.dueOn,
        payment_reference: d.paymentReference,
        supplier_name: d.supplierName,
        supplier_address: d.supplierAddress,
        supplier_vat_number: d.supplierVatNumber,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "23505" && attempt < 5) continue; // reference taken: draw another
      throw e;
    }
  }
}

/** Emails every invoice that has not gone out yet (also retries one whose email failed earlier). */
export async function sendPendingInvoiceEmails(config: BillingConfig): Promise<number> {
  let sent = 0;
  for (const id of await billingPendingEmails()) {
    const d = await read(id);
    if (!d || d.invoice.status !== "issued") continue;
    const inv = d.invoice;
    const pdf = await renderInvoicePdf(
      {
        invoiceNo: inv.invoice_no,
        issuedOn: dublinDate(new Date(inv.issued_at)),
        dueOn: inv.due_on,
        periodStart: inv.period_start,
        periodEnd: inv.period_end,
        amountExVatCents: inv.amount_ex_vat_cents,
        vatRateBp: inv.vat_rate_bp,
        vatCents: inv.vat_cents,
        totalCents: inv.total_cents,
        paymentReference: inv.payment_reference,
        supplierName: inv.supplier_name,
        supplierAddress: inv.supplier_address,
        supplierVatNumber: inv.supplier_vat_number,
        customerName: inv.customer_name,
        customerAddress: inv.customer_address,
        customerVatNumber: inv.customer_vat_number,
        paid: false,
      },
      config,
    );
    const { subject, text } = invoiceEmailText(d, config);
    const ok = await mailOwners(d, subject, text, [
      { filename: invoiceFileName(inv.invoice_no), content: pdf, contentType: "application/pdf" },
    ]);
    if (ok) {
      await billingMarkEmailed(id);
      sent++;
    }
  }
  return sent;
}

/** Hourly: create what is due, then email what has not been emailed. */
export async function invoiceJob(now = new Date()): Promise<void> {
  const config = configOrStop("billing-invoices");
  if (!config) return;
  const created = await billingEnsureSubscriptions(config.trialDays, config.priceCents);
  const today = dublinDate(now);
  let issued = 0;
  for (const c of await billingCandidates()) {
    const period = nextPeriod(
      {
        anchorDate: c.anchor_date,
        trialEndsAt: c.trial_ends_at ? new Date(c.trial_ends_at) : null,
        lastPeriodStart: c.last_period_start,
        resumedOn: c.resumed_on,
      },
      now,
    );
    if (!period) continue;
    const r = await issue(config, c.org_id, period, today);
    if (r.created) issued++;
  }
  const emailed = await sendPendingInvoiceEmails(config);
  if (created || issued || emailed) {
    logger.info({ job: "billing-invoices", created, issued, emailed }, "billing run");
  }
}

// ------------------------------------------------------------------------------ reminders and pause

async function remind(config: BillingConfig, invoiceId: string, n: 1 | 2): Promise<void> {
  if (!(await billingReminderClaim(invoiceId, n))) return; // already sent (or another worker has it)
  let ok = false;
  try {
    const d = await read(invoiceId);
    if (d && d.invoice.status === "issued") {
      const { subject, text } = reminderEmailText(d, config, n);
      ok = await mailOwners(d, subject, text);
    } else {
      ok = true; // paid in the meantime: nothing to send, keep the claim
    }
  } finally {
    if (!ok) await billingReminderRelease(invoiceId, n); // try again on the next run
  }
}

/**
 * Hourly: for every unpaid invoice, mark the account overdue from the due date, send the two
 * reminders (due date, due + 7 days) and pause (read-only) once the grace days have passed.
 * A job that was down for days still does everything owed, once.
 */
export async function dunningJob(now = new Date()): Promise<void> {
  const config = configOrStop("billing-dunning");
  if (!config) return;
  const today = dublinDate(now);
  for (const inv of await billingOpenInvoices()) {
    const state = dunningState(today, inv.due_on, config.graceDays);
    if (state === "current") continue;
    await billingMarkOverdue(inv.org_id);
    if (state === "pause") {
      if (inv.org_status === "read_only" && inv.sub_status === "paused") continue;
      if (await billingPause(inv.org_id, inv.id, today)) {
        const d = await read(inv.id);
        if (d) {
          const { subject, text } = pausedEmailText(d);
          await mailOwners(d, subject, text);
        }
        logger.info(
          { job: "billing-dunning", org: inv.org_id },
          "business paused (unpaid invoice)",
        );
      }
      continue;
    }
    await remind(config, inv.id, 1);
    if (state === "reminder_2") await remind(config, inv.id, 2);
  }
}

const noPayload = z.object({});

export const BILLING_HANDLERS: JobHandler[] = [
  { name: "billing-invoices", schema: noPayload, cron: "37 * * * *", handle: () => invoiceJob() },
  { name: "billing-dunning", schema: noPayload, cron: "47 * * * *", handle: () => dunningJob() },
];
