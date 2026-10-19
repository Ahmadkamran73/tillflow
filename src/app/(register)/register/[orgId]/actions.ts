"use server";

import { presets } from "@/config/business-type-presets";
import { authenticateDevice } from "@/lib/device/auth";
import { parseFeedMeta, parseTenderMeta, mapTaxRates } from "@/lib/device/meta";
import { deviceFeedMeta, deviceSaleCatalogAsOf, deviceTenderTypes } from "@/lib/device/service";
import { sendMail } from "@/lib/email";
import { t } from "@/lib/i18n";
import { rateLimit } from "@/lib/rate-limit";
import { serviceChargeWithin, settleTenders } from "@/lib/money";
import { priceRows } from "@/lib/register/price-server";
import { buildReceipt, receiptLabels, receiptText } from "@/lib/register/receipt";
import { emailReceiptInput, SaleError } from "@/lib/register/sale-input";
import { rowsFromAsOf } from "@/lib/sync/as-of";

export type EmailReceiptResult =
  { ok: true } | { ok: false; reason: "invalid" | "prices" | "rate" | "failed" | "unpaired" };

/**
 * Receipts are sent from the platform mailbox (ALERT_FROM) but show the business name as the
 * sender, as customers expect. Gmail keeps the display name while forcing its own address.
 */
function senderFor(businessName: string) {
  const configured = process.env.ALERT_FROM ?? "";
  const address = /<([^>]+)>/.exec(configured)?.[1] ?? configured;
  return address ? { name: businessName.replace(/[\r\n"]/g, " ").trim(), address } : undefined;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Emails a receipt or VAT invoice for a paired till (identified by its device token, not a user
 * session). The cart is re-priced here from the server catalogue; if that differs from what the
 * till showed the email is refused. The customer's address is used once and never stored or logged.
 */
export async function emailReceipt(orgId: string, raw: unknown): Promise<EmailReceiptResult> {
  const device = await authenticateDevice(orgId);
  if (!device.ok) return { ok: false, reason: "unpaired" };
  const input = emailReceiptInput.safeParse(raw);
  if (!input.success) return { ok: false, reason: "invalid" };
  const data = input.data;
  // Receipts are emailed at the till, at the time of sale: refuse anything far from now.
  const age = Date.now() - new Date(data.completedAt).getTime();
  if (age > 7 * 86_400_000 || age < -86_400_000) return { ok: false, reason: "invalid" };

  const limit = await rateLimit("receipt-email", device.registerId);
  const orgLimit = await rateLimit("receipt-email-org", device.orgId);
  if (!limit.allowed || !orgLimit.allowed) return { ok: false, reason: "rate" };

  const rawMeta = await deviceFeedMeta(device.tokenHash);
  if (!rawMeta) return { ok: false, reason: "unpaired" };
  const meta = parseFeedMeta(rawMeta);
  const org = {
    name: meta.org.name,
    legalName: meta.org.legal_name,
    vatNumber: meta.org.vat_number,
  };
  const location = meta.location;

  let priced;
  try {
    const rows = await deviceSaleCatalogAsOf(
      device.tokenHash,
      [...new Set(data.lines.map((l) => l.variantId))],
      [...new Set(data.lines.flatMap((l) => l.modifierIds))],
      new Date(),
    );
    if (!rows) return { ok: false, reason: "unpaired" };
    priced = priceRows(data, rowsFromAsOf(rows), mapTaxRates(meta.tax_rates), location.timezone);
  } catch (e) {
    return { ok: false, reason: e instanceof SaleError ? "prices" : "failed" };
  }
  // A part of a split bill names a fixed share of the charge: it must fit the percentage.
  if (
    data.serviceChargeCents !== undefined &&
    !serviceChargeWithin(
      priced.priced.basket.serviceChargeBase,
      data.serviceChargeBp,
      data.serviceChargeCents,
    )
  )
    return { ok: false, reason: "prices" };
  // The payments must settle the server's total exactly as the till showed it.
  const settlement = settleTenders(
    priced.priced.basket.total,
    data.tenders.map((t) => ({ method: t.method, amount: t.amountCents, tip: t.tipCents })),
    { roundCash: data.roundCash },
  );
  if (!settlement.ok || settlement.amountDue !== data.expectedDueCents)
    return { ok: false, reason: "prices" };
  const rawTypes = await deviceTenderTypes(device.tokenHash);
  const typeMeta = rawTypes ? parseTenderMeta(rawTypes) : null;
  if (!typeMeta) return { ok: false, reason: "unpaired" };
  if (settlement.tips > 0 && !presets[typeMeta.businessType].register.tips)
    return { ok: false, reason: "prices" };
  const labelOf = new Map(typeMeta.types.map((x) => [x.id, x]));
  const tenders = [];
  for (const t of data.tenders) {
    const known = t.typeId ? labelOf.get(t.typeId) : undefined;
    if (t.typeId && known?.method !== t.method) return { ok: false, reason: "invalid" } as const;
    tenders.push({ ...t, label: known?.label ?? t.method[0]!.toUpperCase() + t.method.slice(1) });
  }

  const receipt = buildReceipt({
    sale: {
      id: "email",
      registerId: "email",
      receiptSeq: data.receiptSeq,
      completedAt: data.completedAt,
      cart: priced.cart,
      tenders,
      roundCash: data.roundCash,
      invoice: data.invoice,
    },
    priced: priced.priced,
    registerName: data.registerName,
    header: {
      name: org.name,
      legalName: org.legalName,
      vatNumber: org.vatNumber,
      address: location.address,
      eircode: location.eircode,
      receiptFooter: location.receipt_footer,
      timezone: location.timezone,
    },
    options: presets[meta.org.business_type].receipt,
    asInvoice: !!data.invoice,
  });
  const text = receiptText(receipt, 42, receiptLabels()).join("\n");
  const result = await sendMail({
    from: senderFor(org.name),
    to: data.to,
    subject: t("receipt.emailSubject", { shop: receipt.business.name }),
    text,
    html: `<pre style="font:13px/1.35 ui-monospace,Menlo,Consolas,monospace">${escapeHtml(text)}</pre>`,
  });
  return result === "sent" ? { ok: true } : { ok: false, reason: "failed" };
}
