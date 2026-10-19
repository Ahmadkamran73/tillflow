import { z } from "zod";
import { irishVatNumber } from "@/lib/onboarding";

/** Customer VAT number for a B2B invoice: Irish (checked) or any EU-shaped number with a country prefix. */
export const customerVatNumber = z
  .string()
  .transform((v) => v.replace(/[\s.-]/g, "").toUpperCase())
  .pipe(
    z.string().superRefine((v, ctx) => {
      if (v.startsWith("IE")) {
        if (!irishVatNumber.safeParse(v).success) ctx.addIssue({ code: "custom", message: "vat" });
      } else if (!/^[A-Z]{2}[0-9A-Z+*]{2,12}$/.test(v)) {
        ctx.addIssue({ code: "custom", message: "vat" });
      }
    }),
  );

export const invoiceInput = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1).max(300),
  vatNumber: customerVatNumber,
});
export type InvoiceInput = z.infer<typeof invoiceInput>;
