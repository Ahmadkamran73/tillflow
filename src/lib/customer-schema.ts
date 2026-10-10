import { z } from "zod";
import { customerVatNumber } from "@/lib/register/invoice";

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v));

/** Empty = no VAT number (a private customer); otherwise the same check as a VAT invoice. */
const optionalVat = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.union([z.null(), customerVatNumber]));

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .transform((v) => (v === "" ? null : v))
  .pipe(z.union([z.null(), z.email()]));

/** The editable fields. Marketing consent is separate: its timestamp is the server's. */
export const customerFields = z.object({
  name: z.string().trim().min(1).max(120),
  email: optionalEmail,
  phone: optional(30),
  vatNumber: optionalVat,
  address: optional(300),
  notes: optional(500),
});
export type CustomerFields = z.infer<typeof customerFields>;

/** The jsonb the database functions read (snake_case, as app.clean_customer expects). */
export const toDbCustomer = (c: CustomerFields) => ({
  name: c.name,
  email: c.email,
  phone: c.phone,
  vat_number: c.vatNumber,
  address: c.address,
  notes: c.notes,
});

/** Till: create a customer (id made on the device) with the explicit consent tick. */
export const tillCustomerInput = customerFields
  .pick({ name: true, email: true, phone: true, vatNumber: true })
  .extend({ id: z.uuid(), consent: z.boolean().default(false) });

export const customerSearch = z.string().trim().min(2).max(60);
