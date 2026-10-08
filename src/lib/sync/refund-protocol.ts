import { z } from "zod";
import { tenderReference } from "@/lib/register/tender-input";
import { SYNC_REASONS } from "./protocol";

// The wire format of POST /api/v1/sync/refunds, shared by the device (outbox) and the server.
// Only inputs travel: which sale lines and how many units, the reason, and how the cashier chose to
// pay the money back. VAT, totals and rounding are recalculated on the server from the ORIGINAL
// sale's stored lines; `expectedAmountCents` is compared, never trusted.

export const refundKinds = ["refund", "void", "exchange"] as const;
export const refundReasonCodes = [
  "changed_mind",
  "faulty",
  "wrong_item",
  "damaged",
  "void_mistake",
  "other",
] as const;
export type RefundKind = (typeof refundKinds)[number];
export type RefundReasonCode = (typeof refundReasonCodes)[number];

const cents = z.int().min(0).max(100_000_000);

export const refundLegInput = z
  .strictObject({
    id: z.uuid(),
    /** The location's tender type to record the payment-back against; null when unknown. */
    typeId: z.uuid().nullable(),
    method: z.enum(["cash", "card", "voucher"]),
    /** What leaves the shop by this method (cash: the rounded cash share). */
    amountCents: z.int().min(1).max(100_000_000),
    /** A card tip handed back; voids only. */
    tipCents: cents.default(0),
    /** The terminal's refund reference or the new voucher's number; never a card number. */
    reference: tenderReference.optional(),
  })
  .refine((l) => l.tipCents === 0 || l.method === "card", {
    message: "tips only go back on card",
    path: ["tipCents"],
  });
export type RefundLegInput = z.infer<typeof refundLegInput>;

export const syncRefund = z
  .strictObject({
    /** UUIDv7 made on the device; the idempotency key. */
    id: z.uuid(),
    originalSaleId: z.uuid(),
    kind: z.enum(refundKinds),
    reasonCode: z.enum(refundReasonCodes),
    reasonNote: z.string().trim().max(200).optional(),
    /** Per-till refund number (its own series, printed `R000003`). */
    receiptSeq: z.int().min(1).max(99_999_999),
    completedAt: z.iso.datetime(),
    /** Whoever's PIN unlocked the till. The server checks they are staff of this shop. */
    cashierUserId: z.uuid(),
    /** Server-issued proof of a manager PIN (see register_approvals, purpose 'refund'). */
    approvalId: z.uuid().optional(),
    /** Offline only: the manager whose cached PIN hash the till checked. Recorded as unverified. */
    claimedApprover: z.uuid().optional(),
    /** The server's signed "serving as" token; the database verifies it and takes the cashier from it. */
    servingToken: z.string().max(500).optional(),
    lines: z
      .array(
        z.strictObject({
          /** The line's position on the original sale (its line_no): a till cannot know server row ids. */
          lineNo: z.int().min(1).max(200),
          qty: z.int().min(1).max(999),
          /** Put the units back into stock. */
          restock: z.boolean(),
        }),
      )
      .min(1)
      .max(100),
    /** How the money goes back: 0-10 legs, at most one cash (none when exchange credit covers it all). */
    legs: z.array(refundLegInput).max(10),
    /** Exchange only: the sale the returned goods were exchanged into, and the credit it used. */
    exchangeSaleId: z.uuid().optional(),
    creditCents: cents.default(0),
    /** Whether the cash leg was rounded to 5c (the shop's setting when it was rung up). */
    roundCash: z.boolean().default(true),
    expectedAmountCents: cents,
  })
  .refine((r) => r.legs.filter((l) => l.method === "cash").length <= 1, {
    message: "only one cash leg",
    path: ["legs"],
  })
  .refine(
    (r) =>
      r.kind === "exchange"
        ? r.exchangeSaleId !== undefined && r.creditCents > 0
        : r.exchangeSaleId === undefined && r.creditCents === 0,
    {
      message: "exchange needs a sale and credit, and nothing else does",
      path: ["kind"],
    },
  )
  .refine((r) => r.reasonCode !== "other" || (r.reasonNote ?? "").length > 0, {
    message: "say why",
    path: ["reasonNote"],
  });
export type SyncRefund = z.infer<typeof syncRefund>;

export const refundBatch = z.strictObject({
  registerId: z.uuid(),
  refunds: z.array(z.unknown()).max(25),
});

export const refundResult = z.object({
  id: z.string(),
  // `retry`: the original sale (or an exchange sale) has not reached the server yet; keep it queued.
  status: z.enum(["created", "duplicate", "rejected", "retry"]),
  reason: z.enum(SYNC_REASONS).optional(),
});
export type RefundResult = z.infer<typeof refundResult>;
export const refundResponse = z.object({ results: z.array(refundResult) });
