import { z } from "zod";
import { discount, saleLine } from "@/lib/register/sale-input";

// The wire format of POST /api/v1/sync/sales, shared by the device (outbox) and the server.
// Only inputs travel: ids, quantities, serials, discounts and what the till showed. Prices, VAT
// and totals are recalculated on the server; `expectedDueCents` is compared, never trusted.

export const MAX_BATCH = 25;
export const MAX_BODY_BYTES = 256 * 1024;

export const syncSale = z.strictObject({
  /** UUIDv7 made on the device; the idempotency key. */
  id: z.uuid(),
  /** Who rang it up: the person whose PIN unlocked the till. The server checks they are staff of this shop. */
  cashierUserId: z.uuid(),
  /**
   * Proof (from the server, see register_approvals) that a manager or owner entered their PIN for
   * this till. The till never says WHO approved: the database derives the approver from this id.
   * Absent (or made offline, where it cannot be issued): a discount above the limit is held.
   */
  approvalId: z.uuid().optional(),
  receiptSeq: z.int().min(1).max(99_999_999),
  completedAt: z.iso.datetime(),
  /** When the till's catalogue was last pulled: a second chance to match its prices. */
  catalogAsOf: z.iso.datetime().optional(),
  mode: z.enum(["eat_in", "take_away"]).default("eat_in"),
  lines: z.array(saleLine).min(1).max(100),
  basketDiscount: discount.optional(),
  tenderedCents: z.int().min(0).max(100_000_000),
  expectedDueCents: z.int().min(0).max(100_000_000),
});
export type SyncSale = z.infer<typeof syncSale>;

/** The batch envelope. Each sale is validated on its own so one bad sale never blocks the rest. */
export const syncBatch = z.strictObject({
  registerId: z.uuid(),
  sales: z.array(z.unknown()).max(MAX_BATCH),
});

// Keep in step with syncRejectionReasons in src/db/schema/sales.ts (a unit test compares them);
// not imported from there so the device bundle never pulls in the schema.
export const SYNC_REASONS = [
  "invalid",
  "unknown_item",
  "modifier_not_offered",
  "price_mismatch",
  "short_tender",
  "bad_time",
  "receipt_number_used",
  "cannot_price",
  "discount_needs_approval",
] as const;
export type SyncReason = (typeof SYNC_REASONS)[number];

export const syncResult = z.object({
  id: z.string(),
  status: z.enum(["created", "duplicate", "rejected"]),
  reason: z.enum(SYNC_REASONS).optional(),
});
export type SyncResult = z.infer<typeof syncResult>;

export const syncResponse = z.object({ results: z.array(syncResult) });
export type SyncResponse = z.infer<typeof syncResponse>;

/** Plain-English text for each reason, for the manager's list. */
export const reasonText: Record<SyncReason, string> = {
  invalid: "The till sent a sale the server could not read.",
  unknown_item: "A product on this sale no longer exists or belongs to another shop.",
  modifier_not_offered: "An option on this sale is not offered for that product.",
  price_mismatch: "The total on the till differs from the server's total.",
  short_tender: "The cash taken was less than the amount due.",
  bad_time: "The till's clock was far from the real time.",
  receipt_number_used: "Another sale already used this receipt number on this till.",
  cannot_price:
    "The sale could not be priced (a discount that does not fit, or a missing VAT rate).",
  discount_needs_approval:
    "The discount was above the shop's limit and no manager approved it on the till.",
};
