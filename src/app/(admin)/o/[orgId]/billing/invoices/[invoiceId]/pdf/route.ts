import type { NextRequest } from "next/server";
import { z } from "zod";
import { appRedirect, authorizeApi } from "@/lib/auth";
import { loadBillingConfig } from "@/lib/billing/config";
import { invoiceFileName } from "@/lib/billing/invoice-number";
import { renderInvoicePdf } from "@/lib/billing/invoice-pdf";
import { getOwnerInvoice } from "@/lib/billing/owner";
import { dublinDate } from "@/lib/billing/period";
import { reportError } from "@/lib/errors";
import { getOrganisation } from "@/lib/org";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /o/<orgId>/billing/invoices/<invoiceId>/pdf
 * The invoice as issued: figures, number, reference and dates come from the stored row, our
 * name, VAT number and bank details from the billing settings. Owners only (RLS also returns no
 * row for another business), 30 per hour per user. A failure goes back to the billing page with a
 * message rather than saving an error as a file.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string; invoiceId: string }> },
) {
  const { orgId, invoiceId } = await params;
  const auth = await authorizeApi("owner", orgId);
  if (!auth.ok) return new Response(null, { status: auth.status });
  if (!z.uuid().safeParse(invoiceId).success) return new Response(null, { status: 404 });

  const back = (flag: "failed" | "limit") => appRedirect(`/o/${orgId}/billing?download=${flag}`);
  const limit = await rateLimit("report-export", auth.user.id);
  if (!limit.allowed) return back("limit");

  try {
    const [invoice, org] = await Promise.all([
      getOwnerInvoice(orgId, invoiceId),
      getOrganisation(orgId),
    ]);
    if (!invoice || !org) return new Response(null, { status: 404 });
    const config = loadBillingConfig();
    if (!config.ok) return back("failed");

    const pdf = await renderInvoicePdf(
      {
        invoiceNo: invoice.invoice_no,
        issuedOn: dublinDate(new Date(invoice.issued_at)),
        dueOn: invoice.due_on,
        periodStart: invoice.period_start,
        periodEnd: invoice.period_end,
        amountExVatCents: invoice.amount_ex_vat_cents,
        vatRateBp: invoice.vat_rate_bp,
        vatCents: invoice.vat_cents,
        totalCents: invoice.total_cents,
        paymentReference: invoice.payment_reference,
        supplierName: invoice.supplier_name,
        supplierAddress: invoice.supplier_address,
        supplierVatNumber: invoice.supplier_vat_number,
        customerName: invoice.customer_name,
        customerAddress: invoice.customer_address,
        customerVatNumber: invoice.customer_vat_number,
        paid: invoice.status === "paid",
      },
      config.config,
    );
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${invoiceFileName(invoice.invoice_no)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    await reportError(error, { source: "server", route: "/o/[orgId]/billing/invoices/pdf" });
    return back("failed");
  }
}
