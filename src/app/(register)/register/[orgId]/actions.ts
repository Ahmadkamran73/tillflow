"use server";

import { requireRole, createSupabaseServerClient } from "@/lib/auth";
import { presets } from "@/config/business-type-presets";
import { sendMail } from "@/lib/email";
import { t } from "@/lib/i18n";
import { getLocation } from "@/lib/catalog";
import { getOrganisation } from "@/lib/org";
import { rateLimit } from "@/lib/rate-limit";
import { changeDue } from "@/lib/money";
import { priceSaleOnServer } from "@/lib/register/price-server";
import { buildReceipt, receiptLabels, receiptText } from "@/lib/register/receipt";
import { emailReceiptInput, SaleError } from "@/lib/register/sale-input";

export type EmailReceiptResult =
  { ok: true } | { ok: false; reason: "invalid" | "prices" | "rate" | "failed" };

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Emails a receipt or VAT invoice. The sale is not on the server yet (sync is step 1.6), so the
 * cart is re-priced here from the server catalogue; if that differs from what the till showed
 * the email is refused. The customer's address is used once and never stored or logged.
 */
export async function emailReceipt(orgId: string, raw: unknown): Promise<EmailReceiptResult> {
  const { user } = await requireRole(["owner", "manager", "cashier"], orgId);
  const input = emailReceiptInput.safeParse(raw);
  if (!input.success) return { ok: false, reason: "invalid" };
  const data = input.data;
  // Receipts are emailed at the till, at the time of sale: refuse anything far from now.
  const age = Date.now() - new Date(data.completedAt).getTime();
  if (age > 7 * 86_400_000 || age < -86_400_000) return { ok: false, reason: "invalid" };

  const limit = await rateLimit("receipt-email", user.id);
  const orgLimit = await rateLimit("receipt-email-org", orgId);
  if (!limit.allowed || !orgLimit.allowed) return { ok: false, reason: "rate" };

  const [org, location] = await Promise.all([getOrganisation(orgId), getLocation(orgId)]);
  if (!org || !location) return { ok: false, reason: "failed" };
  const supabase = await createSupabaseServerClient();
  const { data: loc } = await supabase
    .from("locations")
    .select("address, eircode, receipt_footer")
    .eq("id", location.id)
    .eq("org_id", orgId)
    .maybeSingle();

  let priced;
  try {
    priced = await priceSaleOnServer(orgId, data, location.timezone);
  } catch (e) {
    return { ok: false, reason: e instanceof SaleError ? "prices" : "failed" };
  }
  const due = priced.priced.basket.amountDue;
  if (due !== data.expectedDueCents || data.tenderedCents < due)
    return { ok: false, reason: "prices" };

  const receipt = buildReceipt({
    sale: {
      id: "email",
      registerId: "email",
      receiptSeq: data.receiptSeq,
      completedAt: data.completedAt,
      cart: priced.cart,
      tenderedCents: data.tenderedCents,
      invoice: data.invoice,
    },
    priced: priced.priced,
    registerName: data.registerName,
    header: {
      name: org.name,
      legalName: org.legalName,
      vatNumber: org.vatNumber,
      address: loc?.address ?? null,
      eircode: loc?.eircode ?? null,
      receiptFooter: loc?.receipt_footer ?? null,
      timezone: location.timezone,
    },
    options: presets[org.businessType].receipt,
    asInvoice: !!data.invoice,
  });
  changeDue(receipt.tenderedCents, receipt.dueCents); // throws only if the checks above were skipped
  const text = receiptText(receipt, 42, receiptLabels()).join("\n");
  const result = await sendMail({
    from: process.env.RECEIPT_FROM ?? process.env.ALERT_FROM,
    to: data.to,
    subject: t("receipt.emailSubject", { shop: receipt.business.name }),
    text,
    html: `<pre style="font:13px/1.35 ui-monospace,Menlo,Consolas,monospace">${escapeHtml(text)}</pre>`,
  });
  return result === "sent" ? { ok: true } : { ok: false, reason: "failed" };
}
