import { z } from "zod";
import { discountNeedsOverride, settleTenders, type Settlement } from "@/lib/money";
import { lineTotal, unitWithModifiers, type Cart, type PricedCart } from "@/lib/register/cart";
import { SaleError } from "@/lib/register/sale-input";
import { stripReferences } from "@/lib/register/tender-input";
import { buildSaleRecord } from "./sale-record";
import { syncSale, type SyncReason, type SyncResult, type SyncSale } from "./protocol";

/** Everything the processor needs from the outside world, so the rules are unit-tested alone. */
export type SyncDeps = {
  now: () => Date;
  /** Which of these sale ids are already on the server. */
  existingIds: (ids: string[]) => Promise<Set<string>>;
  /** Prices the sale from the catalogue as it stood at `at`; throws SaleError if it cannot. */
  priceAt: (sale: SyncSale, at: Date) => Promise<{ cart: Cart; priced: PricedCart }>;
  recordSale: (
    payload: unknown,
  ) => Promise<"created" | "duplicate" | "receipt_clash" | "exchange_pending">;
  recordRejection: (payload: unknown) => Promise<void>;
};

/** The shop and till come from the authenticated device (or the manager's session), never from the payload. */
export type SyncCtx = {
  orgId: string;
  registerId: string;
  /** A discount above this share (basis points) of a line or the sale needs a manager's approval. */
  discountOverrideBp: number;
  /** The payment types of the till's location (archived ones too: an offline sale may use one). */
  tenderTypes: { id: string; method: string }[];
  /** Tips are only taken in cafés and restaurants. */
  tipsAllowed: boolean;
  /**
   * The shop's CURRENT rounding setting (business-type preset). Never used to price: a sale is priced
   * with its own `roundCash`. Only compared with it, to leave an audit note when they differ.
   */
  shopRoundCash: boolean;
  /**
   * TRUSTED callers only (the back office re-running a held sale: the signed-in manager). The sync
   * route for tills never sets this; a till can only present an approvalId.
   */
  approverUserId?: string;
};

const DAY = 86_400_000;
/** A till's clock may be wrong, but not by months, and never far in the future. */
export const MAX_AGE_MS = 90 * DAY;
export const MAX_AHEAD_MS = 10 * 60_000;
/** How far before the sale the till's last catalogue pull may be. */
export const MAX_CATALOG_AGE_MS = 30 * DAY;
/** The till's total may differ from the server's by this much and still be accepted. */
export const TOLERANCE_CENTS = 1;
/**
 * The till's VAT must equal the server's exactly: both use the same money library, so the same
 * gross and rate always give the same VAT, and any difference is a rate or category that moved.
 */
export const VAT_TOLERANCE_CENTS = 0;
/** A sale synced later than this is checked against today's prices (a till clock set back). */
export const LATE_SYNC_MS = 60 * 60_000;

/** Saved, but worth a manager's look. Keep in step with the sales_review_flags check in SQL. */
export type ReviewFlag = "vat_differs" | "old_prices" | "rounding_differs";

/** A real UUID, or undefined: an id that only looks like one would make the database throw and block the till. */
const uuidOfField = (raw: unknown, field: string): string | undefined => {
  const id = (raw as Record<string, unknown> | null)?.[field];
  return z.uuid().safeParse(id).success ? (id as string) : undefined;
};
const uuidOf = (raw: unknown) => uuidOfField(raw, "id");

/** The database refuses rejection payloads over 64 KB; a huge sale keeps only its identity. */
const storable = (payload: Record<string, unknown>) =>
  JSON.stringify(payload).length > 32_000
    ? { truncated: true, id: payload.id, cashierUserId: payload.cashierUserId }
    : payload;

const reasonOf = (e: SaleError): SyncReason => {
  switch (e.message) {
    case "unknown item":
      return "unknown_item";
    case "modifier not offered":
    case "duplicate modifier":
      return "modifier_not_offered";
    default:
      return "cannot_price";
  }
};

/**
 * A database error that will happen again for the same sale (constraint, bad value, permission),
 * as opposed to the database being unreachable. The first kind must become a rejection a manager
 * sees; if it were retried it would block every sale queued behind it.
 */
const isDeterministic = (e: unknown) =>
  e instanceof z.ZodError ||
  (typeof (e as { code?: unknown })?.code === "string" &&
    /^(22|23|42501)/.test((e as { code: string }).code));

const tenderLine = (t: SyncSale["tenders"][number]) => ({
  method: t.method,
  amount: t.amountCents,
  tip: t.tipCents,
});

type Rejection = { reason: SyncReason; detail: Record<string, unknown> };

/** Prices a sale at each plausible catalogue moment and returns the first that matches the till. */
async function priceMatching(sale: SyncSale, deps: SyncDeps) {
  const completed = new Date(sale.completedAt);
  const now = deps.now();
  const moments = [completed];
  if (sale.catalogAsOf) {
    const c = new Date(sale.catalogAsOf);
    if (c <= completed && completed.getTime() - c.getTime() <= MAX_CATALOG_AGE_MS) moments.push(c);
  }
  // A product created seconds before the sale, on a till whose clock runs slow, is only visible now.
  moments.push(now);

  let firstError: Rejection | undefined;
  let firstPriced: number | undefined;
  // The first moment whose total matches, kept in case no moment matches the till's VAT as well.
  let dueOnly: { at: Date; cart: Cart; priced: PricedCart; settlement: Settlement } | undefined;
  for (const at of moments) {
    try {
      const r = await deps.priceAt(sale, at);
      // The basket is priced with no cash rounding; rounding applies to the cash share only.
      const settlement = settleTenders(r.priced.basket.total, sale.tenders.map(tenderLine), {
        roundCash: sale.roundCash,
      });
      const due = settlement.amountDue;
      if (Math.abs(due - sale.expectedDueCents) <= TOLERANCE_CENTS) {
        // A VAT category can change with no price change: prefer the moment that also gives the
        // VAT the receipt printed, so the books agree with it whenever they can.
        if (
          sale.expectedVatCents === undefined ||
          Math.abs(r.priced.basket.vatTotal - sale.expectedVatCents) <= VAT_TOLERANCE_CENTS
        ) {
          return { ok: true as const, at, atNow: at === now, settlement, ...r };
        }
        dueOnly ??= { at, settlement, ...r };
        continue;
      }
      firstPriced ??= due;
    } catch (e) {
      if (!(e instanceof SaleError)) throw e; // a database failure: let the device retry
      firstError ??= { reason: reasonOf(e), detail: { message: e.message } };
    }
  }
  if (dueOnly) return { ok: true as const, atNow: dueOnly.at === now, ...dueOnly };
  if (firstPriced !== undefined) {
    return {
      ok: false as const,
      rejection: {
        reason: "price_mismatch" as const,
        detail: { tillDueCents: sale.expectedDueCents, serverDueCents: firstPriced },
      },
    };
  }
  return { ok: false as const, rejection: firstError! };
}

/**
 * Was the sale priced at an older, cheaper catalogue than it should have been? Two ways in:
 * - priced at the till's last catalogue pull (`catalogAsOf`) because its own moment did not match:
 *   compare with the catalogue at the moment of the sale (a till that stopped pulling updates);
 * - synced over an hour late and priced before now: compare with today's catalogue (a till whose
 *   clock was set back).
 * Totals before cash rounding, so a small rise is not hidden by it. A sale that cannot be priced at
 * the later moment (a product removed since) is not flagged. The sale is saved either way.
 */
async function cheaperThanItShouldBe(
  sale: SyncSale,
  match: { at: Date; atNow: boolean; priced: PricedCart },
  deps: SyncDeps,
): Promise<boolean> {
  const completed = new Date(sale.completedAt);
  const now = deps.now();
  let later: Date | undefined;
  if (match.at < completed) later = completed;
  else if (!match.atNow && now.getTime() - completed.getTime() > LATE_SYNC_MS) later = now;
  if (!later) return false;
  try {
    const then = await deps.priceAt(sale, later);
    return then.priced.basket.total > match.priced.basket.total;
  } catch (e) {
    if (e instanceof SaleError) return false;
    throw e;
  }
}

async function processOne(raw: unknown, ctx: SyncCtx, deps: SyncDeps): Promise<SyncResult> {
  const parsed = syncSale.safeParse(raw);
  if (!parsed.success) {
    const id = uuidOf(raw);
    if (!id) {
      const bad = (raw as { id?: unknown } | null)?.id;
      return {
        id: typeof bad === "string" ? bad.slice(0, 64) : "",
        status: "rejected",
        reason: "invalid",
      };
    }
    await deps.recordRejection({
      id,
      org_id: ctx.orgId,
      register_id: ctx.registerId,
      user_id: uuidOfField(raw, "cashierUserId") ?? null,
      reason: "invalid",
      detail: {},
      // A reference that failed validation may be the very card number we refuse to keep.
      payload: { invalid: true, raw: storable({ raw: stripReferences(raw) }) },
    });
    return { id, status: "rejected", reason: "invalid" };
  }
  const sale = parsed.data;

  const reject = async (r: Rejection): Promise<SyncResult> => {
    await deps.recordRejection({
      id: sale.id,
      org_id: ctx.orgId,
      register_id: ctx.registerId,
      user_id: sale.cashierUserId,
      reason: r.reason,
      detail: r.detail,
      // Cart inputs only: the VAT invoice (customer data) is never part of a sale on the wire.
      // References are never kept in a rejection (they are for the payment row only).
      payload: storable(stripReferences({ ...sale })),
    });
    return { id: sale.id, status: "rejected", reason: r.reason };
  };

  const age = deps.now().getTime() - new Date(sale.completedAt).getTime();
  if (age > MAX_AGE_MS || age < -MAX_AHEAD_MS) {
    return reject({ reason: "bad_time", detail: { ageDays: Math.round(age / DAY) } });
  }

  let match;
  try {
    match = await priceMatching(sale, deps);
  } catch (e) {
    if (!isDeterministic(e)) throw e;
    return reject({
      reason: "cannot_price",
      detail: { message: "catalogue row could not be read" },
    });
  }
  if (!match.ok) return reject(match.rejection);

  // A discount above the shop's limit needs a manager's PIN on the till (sale.approvedBy). The
  // database re-checks that the approver really is a manager or owner of this shop.
  const needsApproval = discountNeedsOverride(
    match.cart.lines.map((l, i) => ({
      unitPrice: unitWithModifiers(l),
      qty: l.qty,
      gross: lineTotal(match.priced, match.priced.itemIndex[i]!),
    })),
    ctx.discountOverrideBp,
  );
  if (needsApproval && !sale.approvalId && !ctx.approverUserId) {
    return reject({
      reason: "discount_needs_approval",
      detail: { thresholdBp: ctx.discountOverrideBp },
    });
  }

  const settlement: Settlement = match.settlement;
  const known = new Map(ctx.tenderTypes.map((t) => [t.id, t.method]));
  if (sale.tenders.some((t) => t.typeId !== null && known.get(t.typeId) !== t.method)) {
    return reject({ reason: "unknown_tender", detail: {} });
  }
  if (!settlement.ok) {
    return reject(
      settlement.error === "short"
        ? {
            reason: "short_tender",
            detail: { balanceCents: settlement.balance, dueCents: settlement.amountDue },
          }
        : { reason: "tender_mismatch", detail: { error: settlement.error } },
    );
  }
  if (settlement.tips > 0 && !ctx.tipsAllowed) {
    return reject({ reason: "tender_mismatch", detail: { error: "tips_not_allowed" } });
  }

  const reviewFlags: ReviewFlag[] = [];
  if (
    sale.expectedVatCents !== undefined &&
    Math.abs(match.priced.basket.vatTotal - sale.expectedVatCents) > VAT_TOLERANCE_CENTS
  ) {
    reviewFlags.push("vat_differs");
  }
  if (await cheaperThanItShouldBe(sale, match, deps)) reviewFlags.push("old_prices");
  // Priced with the mode it was rung up with (never the shop's current one); if the shop's setting
  // has changed since, the sale still syncs unchanged and a manager sees it under Needs attention.
  if (sale.roundCash !== ctx.shopRoundCash) reviewFlags.push("rounding_differs");

  let outcome;
  try {
    outcome = await deps.recordSale({
      shift_id: sale.shiftId ?? null,
      customer_id: sale.customerId ?? null,
      ...buildSaleRecord({
        orgId: ctx.orgId,
        registerId: ctx.registerId,
        userId: sale.cashierUserId,
        approverUserId: needsApproval ? ctx.approverUserId : undefined,
        approvalId: needsApproval && !ctx.approverUserId ? sale.approvalId : undefined,
        sale,
        cart: match.cart,
        priced: match.priced,
        settlement,
        pricedAsOf: match.at,
        reviewFlags,
      }),
    });
  } catch (e) {
    if (!isDeterministic(e) && !(e instanceof Error && e.message.startsWith("item line must")))
      throw e;
    // An approval the database does not accept (used, expired, another till's, forged) is the same
    // outcome as none: the sale is held for a manager.
    if (needsApproval && (e as { code?: string }).code === "42501") {
      return reject({
        reason: "discount_needs_approval",
        detail: { thresholdBp: ctx.discountOverrideBp, approval: "not valid" },
      });
    }
    return reject({ reason: "invalid", detail: { message: "sale could not be recorded" } });
  }
  if (outcome === "receipt_clash") {
    return reject({ reason: "receipt_number_used", detail: { receiptSeq: sale.receiptSeq } });
  }
  // The exchange refund that pays for this sale has not arrived yet: retry the batch (the till sends
  // refunds before the sale that depends on them, so this is only a race between two requests).
  if (outcome === "exchange_pending") throw new Error("exchange refund is not on the server yet");
  return { id: sale.id, status: outcome };
}

/**
 * Handles a batch in order. A sale already on the server is `duplicate` before anything else (a
 * replay must not fail because prices moved since). One bad sale never stops the rest; a database
 * failure throws, so the whole request is retried and replays are harmless.
 */
export async function processBatch(
  rawSales: unknown[],
  ctx: SyncCtx,
  deps: SyncDeps,
): Promise<SyncResult[]> {
  const ids = rawSales.flatMap((s) => uuidOf(s) ?? []);
  const existing = ids.length ? await deps.existingIds(ids) : new Set<string>();
  const results: SyncResult[] = [];
  for (const raw of rawSales) {
    const id = uuidOf(raw);
    if (id && existing.has(id)) {
      results.push({ id, status: "duplicate" });
      continue;
    }
    results.push(await processOne(raw, ctx, deps));
  }
  return results;
}
