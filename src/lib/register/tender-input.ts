import { z } from "zod";

// How a sale's payments travel (till -> outbox -> server). Shared by the device, the sync route and
// the emailed receipt. Amounts are checked for sense here; `settleTenders` (src/lib/money) does the
// sums, and the server recalculates them.

/**
 * A card number (PAN) has 13-19 digits. Anything with 13 or more digits in total is refused, however
 * they are spaced or separated by letters (so "4111a1111a1111a1111" does not slip through). Real
 * terminal references are far shorter. Keep in step with the `payments_provider_ref` check in SQL.
 */
export const looksLikeCardNumber = (text: string): boolean =>
  (text.match(/[0-9]/g)?.length ?? 0) >= 13;

/**
 * The terminal's receipt or approval reference, typed by the cashier.
 * Letters, digits, space, dash and slash only; never anything that looks like a card number.
 */
export const tenderReference = z
  .string()
  .trim()
  .max(40)
  .regex(/^[A-Za-z0-9 /-]*$/, "letters, numbers, spaces, - and / only")
  .refine((s) => !looksLikeCardNumber(s), "that looks like a card number");

export const tenderMethod = z.enum(["cash", "card"]);
/** What a sale can be paid with: the location's tender types, or exchange credit from returned goods. */
export const saleTenderMethod = z.enum(["cash", "card", "exchange"]);

const cents = z.int().min(0).max(100_000_000);

export const tenderInput = z
  .strictObject({
    /** UUIDv7 made on the device. */
    id: z.uuid(),
    /** The location's tender type (its label is snapshotted on the payment); null for sales queued before tender types. */
    typeId: z.uuid().nullable(),
    method: saleTenderMethod,
    /** Cash: the amount handed over. Card: the amount it settles. */
    amountCents: cents,
    /** Card tips only, outside the sale total. */
    tipCents: cents.default(0),
    reference: tenderReference.optional(),
    /** Exchange credit only: the exchange refund whose returned goods pay for this sale. */
    refundId: z.uuid().optional(),
  })
  .refine((t) => (t.method === "exchange") === (t.refundId !== undefined), {
    message: "exchange credit names its refund, and nothing else does",
    path: ["refundId"],
  })
  .refine((t) => t.method !== "exchange" || t.typeId === null, {
    message: "exchange credit has no payment type",
    path: ["typeId"],
  })
  .refine((t) => t.tipCents === 0 || t.method === "card", {
    message: "tips are only taken on card",
    path: ["tipCents"],
  });
export type TenderInput = z.infer<typeof tenderInput>;

/** 1 to 10 payments, at most one of them cash. */
export const tendersInput = z
  .array(tenderInput)
  .min(1)
  .max(10)
  .refine((ts) => ts.filter((t) => t.method === "cash").length <= 1, {
    message: "only one cash payment",
  })
  .refine((ts) => ts.filter((t) => t.method === "exchange").length <= 1, {
    message: "only one exchange credit",
  });

/** Takes a reference out of any payload that may be stored or logged (a rejected sale keeps its inputs). */
export function stripReferences<T>(payload: T): T {
  if (Array.isArray(payload)) return payload.map(stripReferences) as T;
  if (payload && typeof payload === "object") {
    return Object.fromEntries(
      Object.entries(payload).flatMap(([k, v]) =>
        k === "reference" ? [] : [[k, stripReferences(v)]],
      ),
    ) as T;
  }
  return payload;
}

/** A payment as it travels: the till's `label` stays on the device (it is for receipts). */
export const toWireTender = (t: TenderInput & { label?: string }): TenderInput => ({
  id: t.id,
  typeId: t.typeId,
  method: t.method,
  amountCents: t.amountCents,
  tipCents: t.tipCents,
  ...(t.reference ? { reference: t.reference } : {}),
  ...(t.refundId ? { refundId: t.refundId } : {}),
});
