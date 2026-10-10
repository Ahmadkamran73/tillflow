import { describe, expect, it } from "vitest";
import {
  priceRefund,
  processRefunds,
  ORIGINAL_WAIT_MS,
  type RefundDeps,
} from "@/lib/sync/refund-process";
import { saleDetail, type SaleDetail } from "@/lib/sync/refund-detail";
import { refundBatch, syncRefund, type SyncRefund } from "@/lib/sync/refund-protocol";

// What JSON.parse gives: the shape of the payload is checked by the assertions themselves.
type Loose = ReturnType<typeof JSON.parse>;

const NOW = new Date("2026-10-06T12:00:00.000Z");
const ORG = "00000000-0000-4000-8000-0000000000f1";
const REG = "00000000-0000-4000-8000-0000000000e1";
const OTHER_REG = "00000000-0000-4000-8000-0000000000e2";
const SALE = "00000000-0000-7000-8000-000000000001";
const CASHIER = "00000000-0000-4000-8000-0000000000d1";
const CASH_TYPE = "00000000-0000-4000-8000-0000000000c1";
const CARD_TYPE = "00000000-0000-4000-8000-0000000000c2";
const LINE = "00000000-0000-4000-8000-0000000000b1";

const ctx = {
  orgId: ORG,
  registerId: REG,
  timezone: "Europe/Dublin",
  tenderTypes: [
    { id: CASH_TYPE, method: "cash" },
    { id: CARD_TYPE, method: "card" },
  ],
};

/** 2 x tea at 7.00 in all (VAT 1.31 at 23%), paid card 4.00 + cash 3.00. */
function detail(
  over: Partial<SaleDetail["sale"]> = {},
  lineOver: Partial<SaleDetail["lines"][number]> = {},
): SaleDetail {
  return {
    sale: {
      id: SALE,
      register_id: REG,
      register_name: "Till 1",
      receipt_seq: 1,
      completed_at: NOW.toISOString(),
      mode: "eat_in",
      items_total: 700,
      vat: 131,
      non_vat: 0,
      cash_rounding: 0,
      amount_due: 700,
      ...over,
    },
    lines: [
      {
        id: LINE,
        line_no: 1,
        kind: "item",
        variant_id: null,
        name: "Tea",
        qty: 2,
        unit_price: 350,
        serial: null,
        discount: 0,
        tax_category: "STANDARD",
        tax_rate_bp: 2300,
        net: 569,
        vat: 131,
        gross: 700,
        refunded_qty: 0,
        ...lineOver,
      },
    ],
    payments: [
      { method: "card", type_id: CARD_TYPE, label: "Card", amount: 400, tip: 50 },
      { method: "cash", type_id: CASH_TYPE, label: "Cash", amount: 300, tip: 0 },
    ],
    refunded: { cash: 0, card: 0, value: 0, cash_refunds: 0 },
  };
}

let n = 0;
const refund = (over: Partial<SyncRefund> = {}): SyncRefund => ({
  id: `00000000-0000-7000-9000-${String(++n).padStart(12, "0")}`,
  originalSaleId: SALE,
  kind: "refund",
  reasonCode: "changed_mind",
  receiptSeq: n,
  completedAt: NOW.toISOString(),
  cashierUserId: CASHIER,
  lines: [{ lineNo: 1, qty: 1, restock: true }],
  legs: [
    {
      id: `00000000-0000-7000-a000-${String(n).padStart(12, "0")}`,
      typeId: CARD_TYPE,
      method: "card",
      amountCents: 350,
      tipCents: 0,
    },
  ],
  creditCents: 0,
  roundCash: true,
  expectedAmountCents: 350,
  ...over,
});

function deps(sale: SaleDetail | null = detail(), over: Partial<RefundDeps> = {}) {
  const recorded: Record<string, Loose>[] = [];
  const rejections: Record<string, Loose>[] = [];
  const d: RefundDeps = {
    now: () => NOW,
    existingIds: async () => new Set(),
    findSale: async () => sale,
    recordRefund: async (p) => {
      recorded.push(p as Record<string, Loose>);
      return "created";
    },
    recordRejection: async (p) => {
      rejections.push(p as Record<string, Loose>);
    },
    ...over,
  };
  return { d, recorded, rejections };
}

const run = async (r: unknown, over?: Parameters<typeof deps>[1], sale?: SaleDetail | null) => {
  const x = deps(sale === undefined ? detail() : sale, over);
  const [result] = await processRefunds([r], ctx, x.d);
  return { result: result!, ...x };
};

describe("processRefunds", () => {
  it("records a partial refund with the original line's rate and recomputed amounts", async () => {
    const { result, recorded } = await run(refund());
    expect(result.status).toBe("created");
    const p = recorded[0]!;
    expect(p.refund).toMatchObject({
      org_id: ORG,
      register_id: REG,
      items_total: 350,
      vat: 66,
      amount: 350,
      kind: "refund",
      credit: 0,
    });
    expect(p.lines).toEqual([
      { line_no: 1, qty: 1, restock: true, gross_cents: 350, vat_cents: 66, net_cents: 284 },
    ]);
    expect(p.payments).toEqual([
      { type_id: CARD_TYPE, method: "card", amount: 350, tip: 0, reference: null },
    ]);
  });

  it("ignores any amount the till sends: the server works them out from the stored line", async () => {
    // The till's expected amount is within 1c; the totals sent to the database are the server's.
    const { result, recorded } = await run(refund({ expectedAmountCents: 351 }));
    expect(result.status).toBe("created");
    expect(recorded[0]!.refund.amount).toBe(350);
    expect(recorded[0]!.refund.client_amount).toBe(351);
  });

  it("rejects an amount that differs from the server's by more than 1c", async () => {
    const { result, rejections } = await run(refund({ expectedAmountCents: 400 }));
    expect(result).toMatchObject({ status: "rejected", reason: "refund_mismatch" });
    expect(rejections[0]).toMatchObject({
      reason: "refund_mismatch",
      detail: { kind: "refund", tillAmountCents: 400, serverAmountCents: 350 },
    });
  });

  it("reverses VAT at the ORIGINAL rate even though today's rate differs (13.5% line, refunded after 1 July 2026)", async () => {
    const june = detail({}, { tax_rate_bp: 1350, gross: 1135, vat: 135, net: 1000, qty: 1 });
    june.payments = [{ method: "card", type_id: CARD_TYPE, label: "Card", amount: 1135, tip: 0 }];
    const r = refund({
      completedAt: "2026-08-02T10:00:00.000Z",
      lines: [{ lineNo: 1, qty: 1, restock: true }],
      legs: [
        {
          id: "00000000-0000-7000-a000-0000000000aa",
          typeId: CARD_TYPE,
          method: "card",
          amountCents: 1135,
          tipCents: 0,
        },
      ],
      expectedAmountCents: 1135,
    });
    const x = deps(june, { now: () => new Date("2026-08-02T10:01:00.000Z") });
    const [result] = await processRefunds([r], ctx, x.d);
    expect(result!.status).toBe("created");
    expect(x.recorded[0]!.refund.vat).toBe(135);
    expect(x.recorded[0]!.lines[0]).toMatchObject({ vat_cents: 135, net_cents: 1000 });
    // a 9% split of the same gross would have been 94
    expect(x.recorded[0]!.refund.vat).not.toBe(94);
  });

  it("answers duplicate for a refund already on the server, without re-checking quantities", async () => {
    const r = refund();
    const x = deps(detail({}, { refunded_qty: 2 }), { existingIds: async (ids) => new Set(ids) });
    const [result] = await processRefunds([r], ctx, x.d);
    expect(result).toEqual({ id: r.id, status: "duplicate" });
    expect(x.recorded).toHaveLength(0);
  });

  it("waits (retry) when the original sale is not on the server yet, then gives up after a week", async () => {
    const waiting = await run(refund(), undefined, null);
    expect(waiting.result.status).toBe("retry");
    expect(waiting.rejections).toHaveLength(0);

    const old = new Date(NOW.getTime() - ORIGINAL_WAIT_MS - 60_000).toISOString();
    const lost = await run(refund({ completedAt: old }), undefined, null);
    expect(lost.result).toMatchObject({ status: "rejected", reason: "original_not_found" });
  });

  it("rejects more units than are left, an unknown line, and a method above what it took", async () => {
    const used = await run(
      refund({ lines: [{ lineNo: 1, qty: 2, restock: true }], legs: [], expectedAmountCents: 700 }),
      undefined,
      detail({}, { refunded_qty: 1 }),
    );
    expect(used.result).toMatchObject({ status: "rejected", reason: "refund_exceeds" });
    expect(used.rejections[0]!.detail).toMatchObject({ line: 1, left: 1 });

    const unknown = await run(refund({ lines: [{ lineNo: 9, qty: 1, restock: true }] }));
    expect(unknown.result).toMatchObject({ status: "rejected", reason: "refund_exceeds" });

    // cash back for a sale paid 4.00 by card and only 3.00 in cash: 7.00 refunded as cash
    const cash = await run(
      refund({
        lines: [{ lineNo: 1, qty: 2, restock: true }],
        legs: [
          {
            id: "00000000-0000-7000-a000-0000000000bb",
            typeId: CASH_TYPE,
            method: "cash",
            amountCents: 700,
            tipCents: 0,
          },
        ],
        expectedAmountCents: 700,
      }),
    );
    expect(cash.result).toMatchObject({ status: "rejected", reason: "refund_exceeds" });
  });

  it("counts refunds already made when it works out what each method can still give back", async () => {
    const after = detail();
    after.refunded = { cash: 0, card: 350, value: 350, cash_refunds: 0 };
    after.lines[0]!.refunded_qty = 1;
    // the second unit: 50c is left on the card, the rest must be cash
    const wrong = await run(
      refund({
        legs: [
          {
            id: "00000000-0000-7000-a000-0000000000cc",
            typeId: CARD_TYPE,
            method: "card",
            amountCents: 350,
            tipCents: 0,
          },
        ],
      }),
      undefined,
      after,
    );
    expect(wrong.result).toMatchObject({ status: "rejected", reason: "refund_exceeds" });
    const ok = await run(
      refund({
        legs: [
          {
            id: "00000000-0000-7000-a000-0000000000cd",
            typeId: CARD_TYPE,
            method: "card",
            amountCents: 50,
            tipCents: 0,
          },
          {
            id: "00000000-0000-7000-a000-0000000000ce",
            typeId: CASH_TYPE,
            method: "cash",
            amountCents: 300,
            tipCents: 0,
          },
        ],
      }),
      undefined,
      after,
    );
    expect(ok.result.status).toBe("created");
  });

  it("does not round a card leg and rounds only the cash share to 5c", async () => {
    // 3.33 of cash share on a sale paid in cash: refund rounds to 3.35
    const cashSale = detail();
    cashSale.payments = [
      { method: "cash", type_id: CASH_TYPE, label: "Cash", amount: 700, tip: 0 },
    ];
    cashSale.lines[0] = {
      ...cashSale.lines[0]!,
      qty: 3,
      gross: 1000,
      vat: 187,
      net: 813,
      unit_price: 333,
    };
    const r = refund({
      lines: [{ lineNo: 1, qty: 1, restock: true }],
      legs: [
        {
          id: "00000000-0000-7000-a000-0000000000dd",
          typeId: CASH_TYPE,
          method: "cash",
          amountCents: 335,
          tipCents: 0,
        },
      ],
      expectedAmountCents: 335,
    });
    const x = await run(r, undefined, cashSale);
    expect(x.result.status).toBe("created");
    expect(x.recorded[0]!.refund).toMatchObject({
      items_total: 333,
      cash_rounding: 2,
      amount: 335,
    });
    // the same refund with the rounding off asks for exactly 3.33
    const exact = await run(
      {
        ...r,
        roundCash: false,
        legs: [{ ...r.legs[0]!, amountCents: 333 }],
        expectedAmountCents: 333,
      },
      undefined,
      cashSale,
    );
    expect(exact.recorded[0]!.refund).toMatchObject({ cash_rounding: 0, amount: 333 });
  });

  it("only a void can return a tip, and a void must be the whole sale, same till, same day", async () => {
    const tip = await run(
      refund({
        legs: [
          {
            id: "00000000-0000-7000-a000-0000000000ee",
            typeId: CARD_TYPE,
            method: "card",
            amountCents: 350,
            tipCents: 20,
          },
        ],
      }),
    );
    expect(tip.result).toMatchObject({ status: "rejected", reason: "refund_mismatch" });

    const voidAll = (extra: Partial<SyncRefund> = {}) =>
      refund({
        kind: "void",
        reasonCode: "void_mistake",
        lines: [{ lineNo: 1, qty: 2, restock: true }],
        legs: [
          {
            id: "00000000-0000-7000-a000-0000000000f1",
            typeId: CARD_TYPE,
            method: "card",
            amountCents: 400,
            tipCents: 50,
          },
          {
            id: "00000000-0000-7000-a000-0000000000f2",
            typeId: CASH_TYPE,
            method: "cash",
            amountCents: 300,
            tipCents: 0,
          },
        ],
        expectedAmountCents: 700,
        ...extra,
      });
    const ok = await run(voidAll());
    expect(ok.result.status).toBe("created");
    expect(ok.recorded[0]!.refund.kind).toBe("void");
    expect(ok.recorded[0]!.payments[0]).toMatchObject({ tip: 50 });

    expect(
      (await run(voidAll(), undefined, detail({ register_id: OTHER_REG }))).result,
    ).toMatchObject({ reason: "void_not_allowed" });
    expect(
      (await run(voidAll(), undefined, detail({ completed_at: "2026-10-04T12:00:00.000Z" })))
        .result,
    ).toMatchObject({ reason: "void_not_allowed" });
    expect(
      (
        await run(
          voidAll({
            lines: [{ lineNo: 1, qty: 1, restock: true }],
            legs: [
              {
                id: "00000000-0000-7000-a000-0000000000f3",
                typeId: CARD_TYPE,
                method: "card",
                amountCents: 350,
                tipCents: 0,
              },
            ],
            expectedAmountCents: 350,
          }),
        )
      ).result,
    ).toMatchObject({ reason: "void_not_allowed" });
    expect((await run(voidAll(), undefined, detail({}, { refunded_qty: 1 }))).result).toMatchObject(
      { reason: "void_not_allowed" },
    );
  });

  it("refuses a tip bigger than the tip the sale took, and never pays exchange credit out", async () => {
    const tipVoid = refund({
      kind: "void",
      reasonCode: "void_mistake",
      lines: [{ lineNo: 1, qty: 2, restock: true }],
      legs: [
        {
          id: "00000000-0000-7000-a000-0000000000a1",
          typeId: CARD_TYPE,
          method: "card",
          amountCents: 400,
          tipCents: 100,
        },
        {
          id: "00000000-0000-7000-a000-0000000000a2",
          typeId: CASH_TYPE,
          method: "cash",
          amountCents: 300,
          tipCents: 0,
        },
      ],
      expectedAmountCents: 700,
    });
    expect((await run(tipVoid)).result).toMatchObject({
      status: "rejected",
      reason: "refund_mismatch",
    });
    const taken = detail();
    taken.payments[0] = { ...taken.payments[0]!, tip: 100 }; // the sale took a 1.00 tip
    expect((await run(tipVoid, undefined, taken)).result.status).toBe("created");

    // a sale paid by exchange credit: the credit is not money, so it cannot be paid out at all
    const credit = detail();
    credit.payments = [
      { method: "exchange", type_id: null, label: "Exchange credit", amount: 700, tip: 0 },
    ];
    const asCash = refund({
      lines: [{ lineNo: 1, qty: 2, restock: true }],
      legs: [
        {
          id: "00000000-0000-7000-a000-0000000000a3",
          typeId: CASH_TYPE,
          method: "cash",
          amountCents: 700,
          tipCents: 0,
        },
      ],
      expectedAmountCents: 700,
    });
    expect((await run(asCash, undefined, credit)).result).toMatchObject({
      reason: "refund_exceeds",
    });
    const asCard = refund({
      lines: [{ lineNo: 1, qty: 2, restock: true }],
      legs: [
        {
          id: "00000000-0000-7000-a000-0000000000a4",
          typeId: CARD_TYPE,
          method: "card",
          amountCents: 700,
          tipCents: 0,
        },
      ],
      expectedAmountCents: 700,
    });
    expect((await run(asCard, undefined, credit)).result).toMatchObject({
      reason: "refund_exceeds",
    });
    // it can only be exchanged again, the whole value as new credit
    const again = refund({
      kind: "exchange",
      exchangeSaleId: "00000000-0000-7000-8000-0000000000ee",
      creditCents: 700,
      lines: [{ lineNo: 1, qty: 2, restock: true }],
      legs: [],
      expectedAmountCents: 0,
    });
    expect((await run(again, undefined, credit)).result.status).toBe("created");
  });

  it("rejects a payment type that is not this till's shop, and a bad or old clock", async () => {
    const bad = await run(
      refund({
        legs: [
          {
            id: "00000000-0000-7000-a000-0000000000f4",
            typeId: "00000000-0000-4000-8000-0000000000c9",
            method: "card",
            amountCents: 350,
            tipCents: 0,
          },
        ],
      }),
    );
    expect(bad.result).toMatchObject({ status: "rejected", reason: "unknown_tender" });
    const old = await run(refund({ completedAt: "2026-01-01T00:00:00.000Z" }));
    expect(old.result).toMatchObject({ reason: "bad_time" });
    const future = await run(
      refund({ completedAt: new Date(NOW.getTime() + 3_600_000).toISOString() }),
    );
    expect(future.result).toMatchObject({ reason: "bad_time" });
  });

  it("passes the signed serving token to the database, and never stores it in a rejection", async () => {
    const withToken = await run(refund({ servingToken: "payload.sig" }));
    expect(withToken.recorded[0]!.refund).toMatchObject({ serving_token: "payload.sig" });
    expect((await run(refund())).recorded[0]!.refund).toMatchObject({ serving_token: null });
    // a refund the server refuses keeps neither the token nor a reference
    const refused = await run(refund({ servingToken: "payload.sig", expectedAmountCents: 999 }));
    expect(refused.result.status).toBe("rejected");
    expect(JSON.stringify(refused.rejections)).not.toContain("payload.sig");
  });

  it("keeps neither the token nor an approval proof from a refund it cannot even read", async () => {
    const x = deps();
    const unreadable = {
      ...refund(),
      lines: "nope",
      servingToken: "payload.sig",
      approvalId: "a1",
    };
    const [r] = await processRefunds([unreadable], ctx, x.d);
    expect(r).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(JSON.stringify(x.rejections)).not.toContain("payload.sig");
    expect(JSON.stringify(x.rejections)).not.toContain('"a1"');
  });

  it("passes the approval proof to the database, and maps its refusal to refund_needs_approval", async () => {
    const approvalId = "00000000-0000-4000-8000-0000000000aa";
    const withApproval = await run(refund({ approvalId, claimedApprover: CASHIER }));
    expect(withApproval.recorded[0]!.refund).toMatchObject({
      approval_id: approvalId,
      claimed_approver: null,
    });
    const offline = await run(refund({ claimedApprover: "00000000-0000-4000-8000-0000000000d2" }));
    expect(offline.recorded[0]!.refund).toMatchObject({
      approval_id: null,
      claimed_approver: "00000000-0000-4000-8000-0000000000d2",
    });

    const refused = await run(refund(), {
      recordRefund: async () => {
        throw Object.assign(new Error("manager approval needed"), { code: "42501" });
      },
    });
    expect(refused.result).toMatchObject({ status: "rejected", reason: "refund_needs_approval" });
  });

  it("rethrows a database outage so the till retries, and maps clashes", async () => {
    const x = deps(detail(), {
      recordRefund: async () => {
        throw Object.assign(new Error("connection lost"), { code: "08006" });
      },
    });
    await expect(processRefunds([refund()], ctx, x.d)).rejects.toThrow("connection lost");

    expect(
      (await run(refund(), { recordRefund: async () => "receipt_clash" })).result,
    ).toMatchObject({ reason: "receipt_number_used" });
    expect(
      (await run(refund(), { recordRefund: async () => "original_missing" })).result.status,
    ).toBe("retry");
    expect((await run(refund(), { recordRefund: async () => "duplicate" })).result.status).toBe(
      "duplicate",
    );
  });

  it("maps deterministic database refusals to the reason a manager reads", async () => {
    const refuse = (message: string, code = "22023") =>
      run(refund(), {
        recordRefund: async () => {
          throw Object.assign(new Error(message), { code });
        },
      });
    expect((await refuse("not a voidable sale")).result).toMatchObject({
      reason: "void_not_allowed",
    });
    expect((await refuse("refund exceeds what was paid by that method")).result).toMatchObject({
      reason: "refund_exceeds",
    });
    expect((await refuse("lines are not on this sale")).result).toMatchObject({
      reason: "refund_exceeds",
    });
    expect((await refuse("unknown payment type")).result).toMatchObject({
      reason: "unknown_tender",
    });
    expect((await refuse("refund does not add up")).result).toMatchObject({
      reason: "refund_mismatch",
    });
    expect((await refuse("check violated", "23514")).result).toMatchObject({
      reason: "refund_mismatch",
    });
  });

  it("rejects what cannot be read, keeps no card number in a stored rejection, and never blocks the rest", async () => {
    const x = deps();
    const bad = {
      ...refund(),
      legs: [
        {
          id: "00000000-0000-7000-a000-0000000000f5",
          typeId: CARD_TYPE,
          method: "card",
          amountCents: 350,
          tipCents: 0,
          reference: "4111 1111 1111 1111",
        },
      ],
    };
    const results = await processRefunds([bad, "garbage", refund()], ctx, x.d);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "created"]);
    expect(results[0]).toMatchObject({ reason: "invalid" });
    expect(results[1]).toMatchObject({ id: "", reason: "invalid" });
    expect(JSON.stringify(x.rejections)).not.toContain("4111");
  });

  it("an exchange takes the credit as an exchange leg and pays out only the difference", async () => {
    const ex = refund({
      kind: "exchange",
      exchangeSaleId: "00000000-0000-7000-8000-0000000000ff",
      creditCents: 200,
      lines: [{ lineNo: 1, qty: 1, restock: true }],
      legs: [
        {
          id: "00000000-0000-7000-a000-0000000000f6",
          typeId: CARD_TYPE,
          method: "card",
          amountCents: 150,
          tipCents: 0,
        },
      ],
      expectedAmountCents: 150,
    });
    const x = await run(ex);
    expect(x.result.status).toBe("created");
    expect(x.recorded[0]!.refund).toMatchObject({
      kind: "exchange",
      credit: 200,
      amount: 150,
      exchange_sale_id: "00000000-0000-7000-8000-0000000000ff",
    });
    expect(x.recorded[0]!.payments).toContainEqual({
      type_id: null,
      method: "exchange",
      amount: 200,
      tip: 0,
      reference: null,
    });
  });
});

describe("priceRefund", () => {
  it("prices a deposit line with its item and never adds VAT to it", () => {
    const d = detail();
    d.lines.push({
      id: "00000000-0000-4000-8000-0000000000b2",
      line_no: 2,
      kind: "deposit",
      variant_id: null,
      name: "Tea",
      qty: 2,
      unit_price: 15,
      serial: null,
      discount: 0,
      tax_category: null,
      tax_rate_bp: null,
      net: null,
      vat: null,
      gross: 30,
      refunded_qty: 0,
    });
    const r = refund({
      lines: [
        { lineNo: 1, qty: 1, restock: true },
        { lineNo: 2, qty: 1, restock: false },
      ],
      legs: [],
      expectedAmountCents: 365,
    });
    const priced = priceRefund(r, d);
    expect(priced.ok).toBe(true);
    if (priced.ok) {
      expect(priced.totals).toMatchObject({
        itemsTotal: 350,
        vatTotal: 66,
        nonVatTotal: 15,
        total: 365,
      });
      expect(priced.lines[1]).toMatchObject({ kind: "deposit", vat: 0, rateBp: null, gross: 15 });
    }
  });
});

describe("protocol", () => {
  it("is strict: an exchange needs a sale and credit, Other needs a note, one cash leg", () => {
    const base = refund();
    expect(syncRefund.safeParse(base).success).toBe(true);
    expect(syncRefund.safeParse({ ...base, kind: "exchange" }).success).toBe(false);
    expect(syncRefund.safeParse({ ...base, creditCents: 100 }).success).toBe(false);
    expect(syncRefund.safeParse({ ...base, reasonCode: "other" }).success).toBe(false);
    expect(
      syncRefund.safeParse({ ...base, reasonCode: "other", reasonNote: "Customer was unhappy" })
        .success,
    ).toBe(true);
    const cash = (id: string) => ({
      id,
      typeId: null,
      method: "cash" as const,
      amountCents: 100,
      tipCents: 0,
    });
    expect(
      syncRefund.safeParse({
        ...base,
        legs: [
          cash("00000000-0000-7000-a000-000000000001"),
          cash("00000000-0000-7000-a000-000000000002"),
        ],
      }).success,
    ).toBe(false);
    expect(syncRefund.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(syncRefund.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(
      syncRefund.safeParse({ ...base, legs: [{ ...base.legs[0]!, reference: "4111111111111111" }] })
        .success,
    ).toBe(false);
    expect(refundBatch.safeParse({ registerId: REG, refunds: [] }).success).toBe(true);
  });

  it("parses the server's description of a sale", () => {
    expect(saleDetail.safeParse(detail()).success).toBe(true);
    expect(saleDetail.safeParse({ ...detail(), refunded: { cash: "1" } }).success).toBe(false);
  });
});
