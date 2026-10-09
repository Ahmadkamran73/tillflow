import { z } from "zod";

/** The reasons a manager can record by hand. Sales and refunds come from the till. */
export const adjustReasons = ["received", "damage", "count", "adjustment"] as const;

const whole = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^-?\d{1,7}$/)
    .transform(Number)
    .pipe(z.number().min(-max).max(max));

export const adjustInput = z
  .object({
    orgId: z.uuid(),
    variantId: z.uuid(),
    reason: z.enum(adjustReasons),
    qty: whole(1_000_000),
    note: z.string().trim().max(200),
  })
  .superRefine((v, ctx) => {
    // received/damage are units (positive); a count is what is on the shelf (not negative);
    // an adjustment is signed but never 0.
    const bad =
      (v.reason === "adjustment" && v.qty === 0) ||
      (v.reason !== "adjustment" && v.qty < 0) ||
      ((v.reason === "received" || v.reason === "damage") && v.qty === 0);
    if (bad) ctx.addIssue({ code: "custom", path: ["qty"], message: "qty" });
  });

export const thresholdInput = z.object({
  orgId: z.uuid(),
  productId: z.uuid(),
  // Empty = no alert.
  threshold: z
    .string()
    .trim()
    .regex(/^\d{0,7}$/)
    .transform((s) => (s === "" ? null : Number(s)))
    .pipe(z.number().max(1_000_000).nullable()),
});
