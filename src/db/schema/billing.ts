import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organisations } from "./tenancy";

const orgCol = () =>
  uuid("org_id")
    .notNull()
    .references(() => organisations.id);

export const subscriptionStatuses = ["trial", "active", "overdue", "paused"] as const;
export const invoiceStatuses = ["issued", "paid", "void"] as const;

/**
 * One row per business: where it is in the billing cycle. The organisation's own `status` stays
 * the access gate (`read_only` = paused); this row says why. Written only by `ops.billing_*` and
 * `public.admin_*` functions; owners can read their own.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    status: text("status").notNull().default("trial"),
    /** The price in force when the subscription was created or last re-priced, in cents ex VAT. */
    priceCents: integer("price_cents").notNull(),
    /** First day of the first paid period (the day after the trial ends, shop-local). */
    anchorDate: date("anchor_date"),
    /** The period the latest PAID invoice covers; null until the first payment. */
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    /** After a super-admin unpauses, the account is not paused again before this date (shop-local). */
    holdUntil: date("hold_until"),
    /**
     * The day a paused business was reopened (payment or unpause), shop-local. Months that passed
     * entirely while it was paused are not invoiced: the next invoice period starts on this day.
     */
    resumedOn: date("resumed_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("subscriptions_org_id_key").on(t.orgId),
    check("subscriptions_status", sql`${t.status} in ('trial', 'active', 'overdue', 'paused')`),
    check("subscriptions_price", sql`${t.priceCents} >= 0`),
  ],
);

/**
 * Our invoices to shops. Never edited once issued except to record payment or void it (a trigger
 * blocks every other change and every delete). `invoice_no` comes from `billing_counters` under a
 * row lock, so numbers have no gaps; (org_id, period_start) is unique so a job that runs twice
 * can never bill a period twice. Amounts are integer cents; VAT is worked out by `src/lib/money`
 * and only stored here.
 */
export const billingInvoices = pgTable(
  "billing_invoices",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    invoiceNo: integer("invoice_no").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    amountExVatCents: integer("amount_ex_vat_cents").notNull(),
    vatRateBp: integer("vat_rate_bp").notNull(),
    vatCents: integer("vat_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    dueOn: date("due_on").notNull(),
    paymentReference: text("payment_reference").notNull(),
    /** Who issued it and to whom, as they were on the day: a reprint years later must match the original. */
    supplierName: text("supplier_name").notNull(),
    supplierAddress: text("supplier_address").notNull(),
    supplierVatNumber: text("supplier_vat_number").notNull(),
    customerName: text("customer_name").notNull(),
    customerAddress: text("customer_address"),
    customerVatNumber: text("customer_vat_number"),
    status: text("status").notNull().default("issued"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidOn: date("paid_on"),
    bankReference: text("bank_reference"),
    markedPaidBy: uuid("marked_paid_by"),
    /** Set when the invoice email went out (null = still to send, so a failed send is retried). */
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    reminder1SentAt: timestamp("reminder_1_sent_at", { withTimezone: true }),
    reminder2SentAt: timestamp("reminder_2_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("billing_invoices_org_id_id_key").on(t.orgId, t.id),
    unique("billing_invoices_invoice_no_key").on(t.invoiceNo),
    unique("billing_invoices_payment_reference_key").on(t.paymentReference),
    unique("billing_invoices_org_period_key").on(t.orgId, t.periodStart),
    index("billing_invoices_status_due_idx").on(t.status, t.dueOn),
    index("billing_invoices_org_issued_idx").on(t.orgId, t.issuedAt),
    check("billing_invoices_status", sql`${t.status} in ('issued', 'paid', 'void')`),
    check("billing_invoices_no_positive", sql`${t.invoiceNo} > 0`),
    check(
      "billing_invoices_amounts",
      sql`${t.amountExVatCents} >= 0 and ${t.vatCents} >= 0 and ${t.totalCents} = ${t.amountExVatCents} + ${t.vatCents}`,
    ),
    check("billing_invoices_rate", sql`${t.vatRateBp} between 0 and 10000`),
    check("billing_invoices_period", sql`${t.periodEnd} > ${t.periodStart}`),
    check(
      "billing_invoices_paid_fields",
      sql`(${t.status} = 'paid') = (${t.paidAt} is not null and ${t.paidOn} is not null and ${t.bankReference} is not null and ${t.markedPaidBy} is not null)`,
    ),
  ],
);

/** A single row: the last invoice number handed out. Locked FOR UPDATE to number gap-free. */
export const billingCounters = pgTable(
  "billing_counters",
  {
    name: text("name").primaryKey(),
    lastNo: integer("last_no").notNull().default(0),
  },
  (t) => [check("billing_counters_name", sql`${t.name} = 'invoice'`)],
);

/**
 * People who run Tillflow itself (super-admin). Deliberately has no org_id: this is platform
 * data, like `tax_rates`. No client can read or write it; rows are added by hand in SQL per
 * environment. `app.is_platform_admin()` is the only reader and also requires two-step (aal2).
 */
export const platformAdmins = pgTable("platform_admins", {
  userId: uuid("user_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
