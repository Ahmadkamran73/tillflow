import "server-only";
import { z } from "zod";
import { sendMail } from "@/lib/email";
import { shiftZEmailData } from "@/lib/ops/db";
import { formatCents } from "@/lib/money";
import { zNumber } from "@/lib/shift-report";
import type { JobHandler } from "../boss";

/** Shape of ops.shift_z_email_data. The report is the server's stored snapshot. */
const emailData = z.object({
  org_name: z.string(),
  timezone: z.string(),
  register_name: z.string().nullable(),
  z_seq: z.number(),
  closed_at: z.string(),
  review_flags: z.array(z.string()),
  emails: z.array(z.string()),
  report: z.object({
    sales: z.object({
      count: z.number(),
      amount_due_cents: z.number(),
      vat_cents: z.number(),
      discount_cents: z.number(),
    }),
    tips_cents: z.number(),
    refunds: z.object({ count: z.number(), amount_cents: z.number() }),
    vat_by_rate: z.array(
      z.object({
        rate_bp: z.number(),
        net_cents: z.number(),
        vat_cents: z.number(),
        gross_cents: z.number(),
      }),
    ),
    tenders: z.array(
      z.object({
        label: z.string(),
        payments: z.number(),
        amount_cents: z.number(),
        tip_cents: z.number(),
      }),
    ),
    refund_tenders: z.array(
      z.object({ label: z.string(), refunds: z.number(), amount_cents: z.number() }),
    ),
    drawer: z.object({
      float_cents: z.number(),
      cash_sales_cents: z.number(),
      cash_in_cents: z.number(),
      cash_out_cents: z.number(),
      cash_refunds_cents: z.number(),
      expected_cents: z.number(),
    }),
    counted_cents: z.number(),
    over_short_cents: z.number(),
  }),
});
export type ZEmailData = z.infer<typeof emailData>;

const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;
const signed = (c: number) => (c > 0 ? "+" : "") + formatCents(c);

/** The Z as plain text, with only amounts and the shop's own names. No customer data is in a report. */
export function zEmailText(d: ZEmailData): { subject: string; text: string } {
  const r = d.report;
  const when = new Intl.DateTimeFormat("en-IE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: d.timezone,
  }).format(new Date(d.closed_at));
  const till = `${d.register_name ?? "Till"} · ${zNumber(d.z_seq)}`;
  const lines = [
    `${d.org_name} · Z-report ${till}`,
    `Closed ${when}`,
    "",
    `Sales: ${r.sales.count} · ${formatCents(r.sales.amount_due_cents)} (VAT ${formatCents(r.sales.vat_cents)}, discounts ${formatCents(r.sales.discount_cents)})`,
    ...r.vat_by_rate.map(
      (v) =>
        `  VAT ${pct(v.rate_bp)}: net ${formatCents(v.net_cents)}, VAT ${formatCents(v.vat_cents)}, gross ${formatCents(v.gross_cents)}`,
    ),
    "",
    "Taken by payment type:",
    ...r.tenders.map(
      (t) =>
        `  ${t.label}: ${t.payments} · ${formatCents(t.amount_cents)}${t.tip_cents ? ` (tips ${formatCents(t.tip_cents)})` : ""}`,
    ),
    `Tips: ${formatCents(r.tips_cents)}`,
    "",
    `Refunds: ${r.refunds.count} · ${formatCents(r.refunds.amount_cents)}`,
    ...r.refund_tenders.map((t) => `  ${t.label}: ${t.refunds} · ${formatCents(t.amount_cents)}`),
    "",
    "Cash drawer:",
    `  Float ${formatCents(r.drawer.float_cents)}`,
    `  Cash sales ${formatCents(r.drawer.cash_sales_cents)}`,
    `  Cash in ${formatCents(r.drawer.cash_in_cents)}, out ${formatCents(r.drawer.cash_out_cents)}`,
    `  Cash refunds ${formatCents(r.drawer.cash_refunds_cents)}`,
    `  Expected ${formatCents(r.drawer.expected_cents)}`,
    `  Counted ${formatCents(r.counted_cents)}`,
    `  Over/short ${signed(r.over_short_cents)}`,
  ];
  if (d.review_flags.length)
    lines.push(
      "",
      `Check: ${d.review_flags.join(", ")} (the till's own figures differed from the server's).`,
    );
  return {
    subject: `[Tillflow] Z-report ${till} · ${d.org_name} · over/short ${signed(r.over_short_cents)}`,
    text: lines.join("\n"),
  };
}

/** Emails the stored Z of a shift to every owner. Throws when a send fails, so pg-boss retries. */
export async function sendShiftZ(shiftId: string): Promise<void> {
  const raw = await shiftZEmailData(shiftId);
  if (!raw) return;
  const d = emailData.parse(raw);
  const { subject, text } = zEmailText(d);
  let failed = false;
  for (const to of d.emails) {
    const r = await sendMail({ from: process.env.ALERT_FROM, to, subject, text });
    if (r === "failed") failed = true;
  }
  if (failed) throw new Error("Z-report email failed");
}

export const SHIFT_HANDLERS: JobHandler[] = [
  {
    name: "shift-z-email",
    schema: z.object({ shift_id: z.uuid() }),
    handle: (data) => sendShiftZ((data as { shift_id: string }).shift_id),
  },
];
