import { z } from "zod";
import type { Cart, PricedCart } from "@/lib/register/cart";
import { SaleError } from "@/lib/register/sale-input";
import { buildSaleRecord } from "./sale-record";
import { syncSale, type SyncReason, type SyncResult, type SyncSale } from "./protocol";

/** Everything the processor needs from the outside world, so the rules are unit-tested alone. */
export type SyncDeps = {
  now: () => Date;
  /** Which of these sale ids are already on the server. */
  existingIds: (ids: string[]) => Promise<Set<string>>;
  /** Prices the sale from the catalogue as it stood at `at`; throws SaleError if it cannot. */
  priceAt: (sale: SyncSale, at: Date) => Promise<{ cart: Cart; priced: PricedCart }>;
  recordSale: (payload: unknown) => Promise<"created" | "duplicate" | "receipt_clash">;
  recordRejection: (payload: unknown) => Promise<void>;
};

export type SyncCtx = { orgId: string; registerId: string; userId: string };

const DAY = 86_400_000;
/** A till's clock may be wrong, but not by months, and never far in the future. */
export const MAX_AGE_MS = 90 * DAY;
export const MAX_AHEAD_MS = 10 * 60_000;
/** How far before the sale the till's last catalogue pull may be. */
export const MAX_CATALOG_AGE_MS = 30 * DAY;
/** The till's total may differ from the server's by this much and still be accepted. */
export const TOLERANCE_CENTS = 1;

/** A real UUID, or undefined: an id that only looks like one would make the database throw and block the till. */
const uuidOf = (raw: unknown): string | undefined => {
  const id = (raw as { id?: unknown } | null)?.id;
  return z.uuid().safeParse(id).success ? (id as string) : undefined;
};

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

type Rejection = { reason: SyncReason; detail: Record<string, unknown> };

/** Prices a sale at each plausible catalogue moment and returns the first that matches the till. */
async function priceMatching(sale: SyncSale, deps: SyncDeps) {
  const completed = new Date(sale.completedAt);
  const moments = [completed];
  if (sale.catalogAsOf) {
    const c = new Date(sale.catalogAsOf);
    if (c <= completed && completed.getTime() - c.getTime() <= MAX_CATALOG_AGE_MS) moments.push(c);
  }
  // A product created seconds before the sale, on a till whose clock runs slow, is only visible now.
  moments.push(deps.now());

  let firstError: Rejection | undefined;
  let firstPriced: number | undefined;
  for (const at of moments) {
    try {
      const r = await deps.priceAt(sale, at);
      const due = r.priced.basket.amountDue;
      if (Math.abs(due - sale.expectedDueCents) <= TOLERANCE_CENTS)
        return { ok: true as const, at, ...r };
      firstPriced ??= due;
    } catch (e) {
      if (!(e instanceof SaleError)) throw e; // a database failure: let the device retry
      firstError ??= { reason: reasonOf(e), detail: { message: e.message } };
    }
  }
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
      user_id: ctx.userId,
      reason: "invalid",
      detail: {},
      payload: { invalid: true, raw: storable({ raw }) },
    });
    return { id, status: "rejected", reason: "invalid" };
  }
  const sale = parsed.data;

  const reject = async (r: Rejection): Promise<SyncResult> => {
    await deps.recordRejection({
      id: sale.id,
      org_id: ctx.orgId,
      register_id: ctx.registerId,
      user_id: ctx.userId,
      reason: r.reason,
      detail: r.detail,
      // Cart inputs only: the VAT invoice (customer data) is never part of a sale on the wire.
      payload: storable({ ...sale, cashierUserId: ctx.userId }),
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

  const due = match.priced.basket.amountDue;
  if (sale.tenderedCents < due) {
    return reject({
      reason: "short_tender",
      detail: { tenderedCents: sale.tenderedCents, dueCents: due },
    });
  }

  let outcome;
  try {
    outcome = await deps.recordSale(
      buildSaleRecord({
        orgId: ctx.orgId,
        registerId: ctx.registerId,
        userId: ctx.userId,
        sale,
        cart: match.cart,
        priced: match.priced,
        pricedAsOf: match.at,
      }),
    );
  } catch (e) {
    if (!isDeterministic(e) && !(e instanceof Error && e.message.startsWith("item line must")))
      throw e;
    return reject({ reason: "invalid", detail: { message: "sale could not be recorded" } });
  }
  if (outcome === "receipt_clash") {
    return reject({ reason: "receipt_number_used", detail: { receiptSeq: sale.receiptSeq } });
  }
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
