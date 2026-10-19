import { z } from "zod";
import {
  localDate,
  refundTotals,
  settleRefund,
  type RefundLeg,
  type RefundSettlement,
} from "@/lib/money";
import { stripReferences } from "@/lib/register/tender-input";
import type { SyncReason } from "./protocol";
import { availableOf, type SaleDetail } from "./refund-detail";
import { priceRefundLines, type PricedRefundLine } from "./refund-price";
import { syncRefund, type RefundResult, type SyncRefund } from "./refund-protocol";

/** Everything the refund processor needs from outside, so the rules are unit-tested alone. */
export type RefundDeps = {
  now: () => Date;
  /** Which of these refund ids are already on the server. */
  existingIds: (ids: string[]) => Promise<Set<string>>;
  /** The original sale as the server stored it (this shop only), or null when it is not there (yet). */
  findSale: (id: string) => Promise<SaleDetail | null>;
  recordRefund: (
    payload: unknown,
  ) => Promise<"created" | "duplicate" | "receipt_clash" | "original_missing">;
  recordRejection: (payload: unknown) => Promise<void>;
};

/** The shop and till come from the authenticated device, never from the payload. */
export type RefundCtx = {
  orgId: string;
  registerId: string;
  /** The shop's timezone: a void must be on the day of the sale. */
  timezone: string;
  /** The payment types of the till's location (archived ones too). */
  tenderTypes: { id: string; method: string; label?: string }[];
};

const DAY = 86_400_000;
const MAX_AGE_MS = 90 * DAY;
const MAX_AHEAD_MS = 10 * 60_000;
/** A refund whose original sale has not reached the server after this long is a problem, not a wait. */
export const ORIGINAL_WAIT_MS = 7 * DAY;
/** The till's amount may differ from the server's by this much and still be accepted. */
const TOLERANCE_CENTS = 1;

const uuidOf = (raw: unknown): string | undefined => {
  const id = (raw as Record<string, unknown> | null)?.id;
  return z.uuid().safeParse(id).success ? (id as string) : undefined;
};

const storable = (payload: Record<string, unknown>) =>
  JSON.stringify(payload).length > 32_000
    ? { truncated: true, id: payload.id, cashierUserId: payload.cashierUserId }
    : payload;

/** Same rule as sale sync: a database error that will repeat must become a rejection. */
const isDeterministic = (e: unknown) =>
  e instanceof z.ZodError ||
  (typeof (e as { code?: unknown })?.code === "string" &&
    /^(22|23|42501)/.test((e as { code: string }).code));

type Rejection = { reason: SyncReason; detail: Record<string, unknown> };

/** Maps a database refusal to the reason a manager reads; the checks above catch most first. */
function reasonOfDbError(e: unknown): Rejection {
  const code = (e as { code?: string }).code;
  const message = String((e as { message?: unknown }).message ?? "");
  if (code === "42501") return { reason: "refund_needs_approval", detail: {} };
  if (message.includes("not a voidable")) return { reason: "void_not_allowed", detail: {} };
  if (message.includes("exceeds") || message.includes("lines are not")) {
    return { reason: "refund_exceeds", detail: {} };
  }
  if (message.includes("unknown payment type")) return { reason: "unknown_tender", detail: {} };
  return { reason: "refund_mismatch", detail: { message: "refund could not be recorded" } };
}

const legOf = (l: SyncRefund["legs"][number]): RefundLeg => ({
  method: l.method,
  amount: l.amountCents,
  tip: l.tipCents,
});

/**
 * What the server works out for a refund from the ORIGINAL sale's stored lines. Pure: the same
 * numbers as `ops.record_refund` recomputes in SQL. Returns the line amounts (each at its original
 * rate), the totals and the settlement of the cashier's legs.
 */
export function priceRefund(
  refund: SyncRefund,
  detail: SaleDetail,
):
  | {
      ok: true;
      lines: PricedRefundLine[];
      totals: ReturnType<typeof refundTotals>;
      settlement: RefundSettlement;
    }
  | { ok: false; rejection: Rejection } {
  const priced = priceRefundLines(detail, refund.lines);
  if (!priced.ok) {
    return {
      ok: false,
      rejection: {
        reason: "refund_exceeds",
        detail:
          priced.error === "too_many"
            ? { line: priced.lineNo, left: priced.left }
            : { line: "unknown" },
      },
    };
  }
  const { lines, totals } = priced;
  const settlement = settleRefund(totals.total, refund.legs.map(legOf), availableOf(detail), {
    roundCash: refund.roundCash,
    credit: Math.min(refund.creditCents, totals.total),
    cashSlack: 2 * (1 + detail.refunded.cash_refunds),
  });
  return { ok: true, lines, totals, settlement };
}

async function processOne(raw: unknown, ctx: RefundCtx, deps: RefundDeps): Promise<RefundResult> {
  const parsed = syncRefund.safeParse(raw);
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
      user_id: null,
      reason: "invalid",
      detail: { kind: "refund" },
      // Neither a reference nor the signed token or approval proof is kept.
      payload: {
        invalid: true,
        kind: "refund",
        raw: storable({
          raw: stripReferences({
            ...(raw as Record<string, unknown>),
            servingToken: undefined,
            approvalId: undefined,
          }),
        }),
      },
    });
    return { id, status: "rejected", reason: "invalid" };
  }
  const refund = parsed.data;

  const reject = async (r: Rejection): Promise<RefundResult> => {
    await deps.recordRejection({
      id: refund.id,
      org_id: ctx.orgId,
      register_id: ctx.registerId,
      user_id: refund.cashierUserId,
      reason: r.reason,
      detail: { ...r.detail, kind: "refund" },
      // Inputs only; the reference is for the payment row, never kept in a rejection.
      // Neither a reference nor the signed token is kept in a rejection.
      payload: storable(stripReferences({ ...refund, servingToken: undefined, kind_of: "refund" })),
    });
    return { id: refund.id, status: "rejected", reason: r.reason };
  };

  const age = deps.now().getTime() - new Date(refund.completedAt).getTime();
  if (age > MAX_AGE_MS || age < -MAX_AHEAD_MS) {
    return reject({ reason: "bad_time", detail: { ageDays: Math.round(age / DAY) } });
  }

  const detail = await deps.findSale(refund.originalSaleId);
  if (!detail) {
    // Probably still in a till's outbox: wait. After a week it is a real problem for a manager.
    if (age > ORIGINAL_WAIT_MS) return reject({ reason: "original_not_found", detail: {} });
    return { id: refund.id, status: "retry" };
  }

  const known = new Map(ctx.tenderTypes.map((t) => [t.id, t.method]));
  if (refund.legs.some((l) => l.typeId !== null && known.get(l.typeId) !== l.method)) {
    return reject({ reason: "unknown_tender", detail: {} });
  }
  // Tips go back only on a void.
  const tipTaken = detail.payments.reduce((n, p) => n + p.tip, 0);
  if (refund.legs.reduce((n, l) => n + l.tipCents, 0) > tipTaken) {
    return reject({ reason: "refund_mismatch", detail: { error: "tip_over_taken" } });
  }
  if (refund.kind !== "void" && refund.legs.some((l) => l.tipCents > 0)) {
    return reject({ reason: "refund_mismatch", detail: { error: "tip_only_on_void" } });
  }
  if (refund.kind === "void") {
    const sameDay =
      localDate(new Date(detail.sale.completed_at), ctx.timezone) ===
      localDate(new Date(refund.completedAt), ctx.timezone);
    const whole =
      refund.lines.length === detail.lines.length &&
      detail.lines.every((l) => {
        const req = refund.lines.find((r) => r.lineNo === l.line_no);
        return req && req.qty === l.qty && l.refunded_qty === 0;
      });
    if (detail.sale.register_id !== ctx.registerId || !sameDay || !whole) {
      return reject({ reason: "void_not_allowed", detail: {} });
    }
  }

  const priced = priceRefund(refund, detail);
  if (!priced.ok) return reject(priced.rejection);
  const { settlement, totals, lines } = priced;
  if (settlement.error === "over_method")
    return reject({ reason: "refund_exceeds", detail: { error: "method" } });
  if (!settlement.ok) {
    return reject({
      reason: "refund_mismatch",
      detail: { error: settlement.error, balance: settlement.balance },
    });
  }
  if (refund.kind === "exchange" && refund.creditCents > totals.total) {
    return reject({ reason: "refund_mismatch", detail: { error: "credit_over_total" } });
  }
  const amount = settlement.payout + settlement.rounding;
  if (Math.abs(amount - refund.expectedAmountCents) > TOLERANCE_CENTS) {
    return reject({
      reason: "refund_mismatch",
      detail: { tillAmountCents: refund.expectedAmountCents, serverAmountCents: amount },
    });
  }

  let outcome;
  try {
    outcome = await deps.recordRefund({
      shift_id: refund.shiftId ?? null,
      refund: {
        id: refund.id,
        org_id: ctx.orgId,
        register_id: ctx.registerId,
        user_id: refund.cashierUserId,
        original_sale_id: refund.originalSaleId,
        kind: refund.kind,
        reason_code: refund.reasonCode,
        reason_note: refund.reasonNote ?? null,
        receipt_seq: refund.receiptSeq,
        completed_at: refund.completedAt,
        items_total: totals.itemsTotal,
        vat: totals.vatTotal,
        non_vat: totals.nonVatTotal,
        credit: refund.creditCents,
        cash_rounding: settlement.rounding,
        amount,
        client_amount: refund.expectedAmountCents,
        exchange_sale_id: refund.exchangeSaleId ?? null,
        approval_id: refund.approvalId ?? null,
        claimed_approver: refund.approvalId ? null : (refund.claimedApprover ?? null),
        serving_token: refund.servingToken ?? null,
      },
      lines: lines.map((l) => ({
        line_no: l.lineNo,
        qty: l.qty,
        restock: l.restock,
        gross_cents: l.gross,
        vat_cents: l.kind === "item" ? l.vat : null,
        net_cents: l.kind === "item" ? l.net : null,
      })),
      payments: [
        ...refund.legs.map((l) => ({
          type_id: l.typeId,
          method: l.method,
          amount: l.amountCents,
          tip: l.tipCents,
          reference: l.reference ?? null,
        })),
        ...(refund.creditCents > 0
          ? [
              {
                type_id: null,
                method: "exchange",
                amount: refund.creditCents,
                tip: 0,
                reference: null,
              },
            ]
          : []),
      ],
    });
  } catch (e) {
    if (!isDeterministic(e)) throw e; // the database is unreachable: the device retries
    return reject(reasonOfDbError(e));
  }
  if (outcome === "receipt_clash") {
    return reject({ reason: "receipt_number_used", detail: { receiptSeq: refund.receiptSeq } });
  }
  if (outcome === "original_missing") return { id: refund.id, status: "retry" };
  return { id: refund.id, status: outcome };
}

/**
 * Handles a batch in order. A refund already on the server is `duplicate` before anything else (a
 * replay must not fail because the quantities now look used up). One bad refund never stops the
 * rest; a database failure throws, so the request is retried and replays are harmless.
 */
export async function processRefunds(
  rawRefunds: unknown[],
  ctx: RefundCtx,
  deps: RefundDeps,
): Promise<RefundResult[]> {
  const ids = rawRefunds.flatMap((r) => uuidOf(r) ?? []);
  const existing = ids.length ? await deps.existingIds(ids) : new Set<string>();
  const results: RefundResult[] = [];
  for (const raw of rawRefunds) {
    const id = uuidOf(raw);
    if (id && existing.has(id)) {
      results.push({ id, status: "duplicate" });
      continue;
    }
    results.push(await processOne(raw, ctx, deps));
  }
  return results;
}
