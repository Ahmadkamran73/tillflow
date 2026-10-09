// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { seedProduct } from "./catalog-helpers";
import { inWorld, sql, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);
const WRONG = ["22023"];

/** A 7.00 sale (2 x 3.50 tea, VAT-inclusive 23%): card 4.00 + cash 3.00. */
async function makeSale(ctx: Ctx, shop: Shop, seq = 1) {
  const { pid, vid } = await seedProduct(ctx, shop.orgId, `sku-${randomUUID().slice(0, 6)}`);
  await ctx.sql`insert into stock_movements (id, org_id, variant_id, location_id, qty_delta, reason)
                values (${randomUUID()}, ${shop.orgId}, ${vid}, ${shop.locationId}, 50, 'opening')`;
  const card = (
    await ctx.sql`select id from tender_types where location_id = ${shop.locationId} and method = 'card'`
  )[0]!.id as string;
  const cash = (
    await ctx.sql`select id from tender_types where location_id = ${shop.locationId} and method = 'cash'`
  )[0]!.id as string;
  const saleId = randomUUID();
  const p = {
    sale: {
      id: saleId,
      org_id: shop.orgId,
      register_id: shop.registerId,
      user_id: shop.cashier.userId,
      receipt_seq: seq,
      mode: "eat_in",
      completed_at: new Date().toISOString(),
      priced_as_of: new Date().toISOString(),
      items_total: 700,
      vat: 131,
      non_vat: 0,
      cash_rounding: 0,
      amount_due: 700,
      client_due: 700,
    },
    lines: [
      {
        kind: "item",
        variant_id: vid,
        product_id: pid,
        name: "Tea",
        qty: 2,
        unit_price_cents: 350,
        modifiers: [],
        discount_cents: 0,
        tax_category: "STANDARD",
        tax_rate_bp: 2300,
        net_cents: 569,
        vat_cents: 131,
        gross_cents: 700,
      },
    ],
    payments: [
      { type_id: card, method: "card", amount: 400, tendered: 400, change: 0, tip: 50 },
      { type_id: cash, method: "cash", amount: 300, tendered: 300, change: 0 },
    ],
  };
  await ctx.sql`select ops.record_sale(${json(ctx, p)}) as r`;
  return { saleId, vid, pid, card, cash };
}

/** The refund payload for `qty` units of line 1 of a sale (line amounts from the cumulative rule). */
function refundPayload(
  shop: Shop,
  s: { saleId: string; card: string; cash: string },
  opts: {
    qty?: number;
    done?: number;
    legs?: { method: string; amount: number; type_id?: string; tip?: number }[];
    seq?: number;
    kind?: string;
    user?: string;
    over?: Record<string, unknown>;
    credit?: number;
    exchangeSaleId?: string;
  } = {},
) {
  const qty = opts.qty ?? 1;
  const done = opts.done ?? 0;
  const share = (total: number, k: number) => Math.round((total * k) / 2 + 1e-9);
  const gross = share(700, done + qty) - share(700, done);
  const vat = share(131, done + qty) - share(131, done);
  const legs = opts.legs ?? [{ method: "card", amount: gross, type_id: s.card }];
  const credit = opts.credit ?? 0;
  const legsSum = legs.reduce((n, l) => n + l.amount, 0);
  return {
    refund: {
      id: randomUUID(),
      org_id: shop.orgId,
      register_id: shop.registerId,
      user_id: opts.user ?? shop.cashier.userId,
      original_sale_id: s.saleId,
      kind: opts.kind ?? "refund",
      reason_code: "changed_mind",
      receipt_seq: opts.seq ?? 1,
      completed_at: new Date().toISOString(),
      items_total: gross,
      vat,
      non_vat: 0,
      credit,
      cash_rounding: 0,
      amount: legsSum,
      client_amount: legsSum,
      exchange_sale_id: opts.exchangeSaleId ?? null,
      ...opts.over,
    },
    lines: [
      {
        line_no: 1,
        qty,
        restock: true,
        gross_cents: gross,
        vat_cents: vat,
        net_cents: gross - vat,
      },
    ],
    payments: [
      ...legs.map((l) => ({
        type_id: l.type_id ?? null,
        method: l.method,
        amount: l.amount,
        tip: l.tip ?? 0,
      })),
      ...(credit > 0 ? [{ type_id: null, method: "exchange", amount: credit }] : []),
    ],
  };
}

/** Legs for the second unit once the first went back to the card: 50c card left, the rest cash. */
const secondLegs = (s: { card: string; cash: string }) => [
  { method: "card", amount: 50, type_id: s.card },
  { method: "cash", amount: 300, type_id: s.cash },
];

/** The server-signed "serving as" token the unlock route issues after it checked a PIN. */
const serving = async (ctx: Ctx, shop: Shop, user: string) =>
  (await ctx.sql`select ops.issue_serving_token(${shop.tokenHash}, ${user}) as t`)[0]!.t as string;

const refund = async (ctx: Ctx, shop: Shop, p: unknown) =>
  (await ctx.sql`select ops.record_refund(${json(ctx, p)}, ${shop.tokenHash}) as r`)[0]!
    .r as string;

describe("ops.record_refund", () => {
  it("records a partial refund at the original rate, restocks, and never touches the sale", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      const before = (await sql`select * from sales where id = ${s.saleId}`)[0]!;

      const p = refundPayload(a, s, { qty: 1 });
      expect(await refund(ctx, a, p)).toBe("created");
      const [r] = await sql`select * from refunds where id = ${p.refund.id}`;
      expect(r).toMatchObject({
        kind: "refund",
        items_total_cents: 350,
        vat_cents: 66,
        amount_cents: 350,
        cashier_user_id: a.cashier.userId,
      });
      const [line] = await sql`select * from refund_lines where refund_id = ${p.refund.id}`;
      expect(line).toMatchObject({
        qty: 1,
        tax_rate_bp: 2300,
        gross_cents: 350,
        vat_cents: 66,
        net_cents: 284,
        name: "Tea",
      });
      const [pay] = await sql`select * from refund_payments where refund_id = ${p.refund.id}`;
      expect(pay).toMatchObject({ method: "card", amount_cents: 350, label: "Card" });
      expect(
        (await sql`select on_hand from stock_levels where variant_id = ${s.vid}`)[0]!.on_hand,
      ).toBe(49);
      expect(
        (
          await sql`select reason, ref_id from stock_movements
                    where reason = 'refund' and org_id = ${a.orgId}`
        )[0],
      ).toMatchObject({ ref_id: p.refund.id });
      // The original sale is exactly as it was.
      expect((await sql`select * from sales where id = ${s.saleId}`)[0]).toEqual(before);

      // A replay answers duplicate and changes nothing.
      expect(await refund(ctx, a, p)).toBe("duplicate");
      expect(
        (await sql`select count(*)::int as n from refunds where org_id = ${a.orgId}`)[0]!.n,
      ).toBe(1);

      // The last unit takes the rounding remainder: 350 and 65, so the two add up to the line.
      const p2 = refundPayload(a, s, {
        qty: 1,
        done: 1,
        seq: 2,
        legs: [
          { method: "card", amount: 50, type_id: s.card },
          { method: "cash", amount: 300, type_id: s.cash },
        ],
      });
      expect(await refund(ctx, a, p2)).toBe("created");
      expect(
        (
          await sql`select sum(vat_cents)::int as v, sum(gross_cents)::int as g from refund_lines
                    where org_id = ${a.orgId}`
        )[0],
      ).toEqual({ v: 131, g: 700 });
      expect(
        (await sql`select on_hand from stock_levels where variant_id = ${s.vid}`)[0]!.on_hand,
      ).toBe(50);

      // Nothing left to give back.
      await ctx.denied(
        () => refund(ctx, a, refundPayload(a, s, { qty: 1, done: 2, seq: 3 })),
        WRONG,
      );
    }));

  it("does not put units back when restock is off", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const s = await makeSale(ctx, a);
      const p = refundPayload(a, s);
      p.lines[0]!.restock = false;
      expect(await refund(ctx, a, p)).toBe("created");
      expect(
        (await ctx.sql`select on_hand from stock_levels where variant_id = ${s.vid}`)[0]!.on_hand,
      ).toBe(48);
    }));

  it("refuses wrong amounts, an unknown line and more than the sale took by a method", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const s = await makeSale(ctx, a);
      // VAT that is not the original line's share
      const wrongVat = refundPayload(a, s);
      wrongVat.lines[0]!.vat_cents = 80;
      wrongVat.lines[0]!.net_cents = 270;
      await ctx.denied(() => refund(ctx, a, wrongVat), WRONG);
      // totals that do not match the lines
      await ctx.denied(
        () => refund(ctx, a, refundPayload(a, s, { over: { items_total: 351 } })),
        WRONG,
      );
      // a line that is not on the sale
      const unknown = refundPayload(a, s);
      unknown.lines[0]!.line_no = 9;
      await ctx.denied(() => refund(ctx, a, unknown), WRONG);
      // cash above what the cash paid (3.00 + 2c slack), card above what the card paid
      await ctx.denied(
        () =>
          refund(ctx, a, refundPayload(a, s, { qty: 2, legs: [{ method: "cash", amount: 700 }] })),
        WRONG,
      );
      await ctx.denied(
        () =>
          refund(ctx, a, refundPayload(a, s, { qty: 2, legs: [{ method: "card", amount: 700 }] })),
        WRONG,
      );
      // vouchers are gone: any other method is refused
      await ctx.denied(
        () => refund(ctx, a, refundPayload(a, s, { legs: [{ method: "voucher", amount: 350 }] })),
        WRONG,
      );
      // tips only on a void
      await ctx.denied(
        () =>
          refund(ctx, a, refundPayload(a, s, { legs: [{ method: "card", amount: 350, tip: 10 }] })),
        WRONG,
      );
      // two lines picking the same line
      const dup = refundPayload(a, s);
      dup.lines.push({ ...dup.lines[0]! });
      await ctx.denied(() => refund(ctx, a, dup), WRONG);
      expect(
        (await ctx.sql`select count(*)::int as n from refunds where org_id = ${a.orgId}`)[0]!.n,
      ).toBe(0);
    }));

  it("needs a manager's single-use approval for a cashier above the limit", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      await sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;

      await ctx.denied(() => refund(ctx, a, refundPayload(a, s)), ["42501"]);

      const approval = randomUUID();
      await sql`insert into register_approvals (id, org_id, register_id, approver_user_id, purpose, sale_id, max_cents)
                values (${approval}, ${a.orgId}, ${a.registerId}, ${a.manager.userId}, 'refund', ${s.saleId}, 100000)`;
      const p = refundPayload(a, s, { over: { approval_id: approval } });
      expect(await refund(ctx, a, p)).toBe("created");
      expect(
        (await sql`select approved_by, approval_state from refunds where id = ${p.refund.id}`)[0],
      ).toEqual({ approved_by: a.manager.userId, approval_state: "verified" });
      expect(
        (await sql`select consumed_for from register_approvals where id = ${approval}`)[0]!
          .consumed_for,
      ).toBe(p.refund.id);
      // spent: a second refund cannot reuse it
      await ctx.denied(
        () =>
          refund(ctx, a, refundPayload(a, s, { done: 1, seq: 2, legs: secondLegs(s), over: { approval_id: approval } })),
        ["42501"],
      );
      // a discount approval is not a refund approval
      const wrong = randomUUID();
      await sql`insert into register_approvals (id, org_id, register_id, approver_user_id, purpose)
                values (${wrong}, ${a.orgId}, ${a.registerId}, ${a.manager.userId}, 'discount')`;
      await ctx.denied(
        () =>
          refund(ctx, a, refundPayload(a, s, { done: 1, seq: 2, legs: secondLegs(s), over: { approval_id: wrong } })),
        ["42501"],
      );
      // an offline till names a manager: recorded as unverified; a cashier cannot be the approver
      const claimed = refundPayload(a, s, {
        done: 1,
        seq: 2,
        legs: secondLegs(s),
        over: { claimed_approver: a.manager.userId },
      });
      expect(await refund(ctx, a, claimed)).toBe("created");
      expect(
        (await sql`select approval_state from refunds where id = ${claimed.refund.id}`)[0]!
          .approval_state,
      ).toBe("unverified");
      const [audit] = await sql`select after from audit_log where entity_id = ${claimed.refund.id}`;
      expect(audit!.after).toMatchObject({
        approval: "unverified",
        approved_by: a.manager.userId,
      });
      const fresh = await makeSale(ctx, a, 2);
      await ctx.denied(
        () =>
          refund(
            ctx,
            a,
            refundPayload(a, fresh, { seq: 3, over: { claimed_approver: a.cashier.userId } }),
          ),
        ["42501"],
      );
    }));

  it("a manager at the till refunds above the limit without a second PIN", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const s = await makeSale(ctx, a);
      await ctx.sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;
      const p = refundPayload(a, s, { user: a.manager.userId });
      expect(await refund(ctx, a, p)).toBe("created");
      expect(
        (await ctx.sql`select after from audit_log where entity_id = ${p.refund.id}`)[0]!.after,
      ).toMatchObject({ approval: "self" });
      expect(
        (await ctx.sql`select approval_state from refunds where id = ${p.refund.id}`)[0]!
          .approval_state,
      ).toBe("self");
    }));

  it("a void reverses the whole sale on the same till and day, with the tip, and needs a manager", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      const approval = randomUUID();
      await sql`insert into register_approvals (id, org_id, register_id, approver_user_id, purpose, sale_id, max_cents)
                values (${approval}, ${a.orgId}, ${a.registerId}, ${a.manager.userId}, 'refund', ${s.saleId}, 100000)`;
      const whole = (over: Record<string, unknown> = {}) => {
        const p = refundPayload(a, s, {
          qty: 2,
          kind: "void",
          legs: [
            { method: "card", amount: 400, type_id: s.card, tip: 50 },
            { method: "cash", amount: 300, type_id: s.cash },
          ],
          over: { reason_code: "void_mistake", ...over },
        });
        return p;
      };
      // a cashier cannot void without approval
      await ctx.denied(() => refund(ctx, a, whole()), ["42501"]);
      // a partial "void" is refused
      const partial = refundPayload(a, s, {
        qty: 1,
        kind: "void",
        over: { approval_id: approval },
      });
      await ctx.denied(() => refund(ctx, a, partial), WRONG);
      // the sale date moved a day back: not the same day
      await sql`set local session_replication_role = replica`;
      await sql`update sales set completed_at = completed_at - interval '2 days' where id = ${s.saleId}`;
      await sql`set local session_replication_role = origin`;
      await ctx.denied(() => refund(ctx, a, whole({ approval_id: approval })), WRONG);
      await sql`set local session_replication_role = replica`;
      await sql`update sales set completed_at = now() where id = ${s.saleId}`;
      await sql`set local session_replication_role = origin`;

      const p = whole({ approval_id: approval });
      expect(await refund(ctx, a, p)).toBe("created");
      expect(
        (
          await sql`select kind, items_total_cents, vat_cents from refunds where id = ${p.refund.id}`
        )[0],
      ).toEqual({ kind: "void", items_total_cents: 700, vat_cents: 131 });
      expect(
        (
          await sql`select tip_cents from refund_payments where refund_id = ${p.refund.id} and method = 'card'`
        )[0]!.tip_cents,
      ).toBe(50);
      expect(
        (await sql`select action from audit_log where entity_id = ${p.refund.id}`)[0]!.action,
      ).toBe("sale.voided");
      // nothing left, so a second void is refused
      await ctx.denied(() => refund(ctx, a, whole({ approval_id: approval })), ["42501", "22023"]);
    }));

  it("needs a reason note for Other, and a card reference can never be a card number", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const s = await makeSale(ctx, a);
      await ctx.denied(
        () => refund(ctx, a, refundPayload(a, s, { over: { reason_code: "other" } })),
        ["23514"],
      );
      const p = refundPayload(a, s);
      (p.payments[0] as Record<string, unknown>).reference = "4111 1111 1111 1111";
      await ctx.denied(() => refund(ctx, a, p), ["23514"]);
    }));

  it("is shop-scoped: another shop's till cannot refund or see a sale", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const [a, b] = [world.a, world.b];
      const s = await makeSale(ctx, a);
      // Shop B's till names Shop A's sale: it is not there as far as B is concerned.
      const forged = refundPayload(b, s);
      expect(await refund(ctx, b, forged)).toBe("original_missing");
      // a token of another shop cannot be used for this shop's register
      await ctx.denied(() => refund(ctx, b, refundPayload(a, s)), ["42501"]);
      expect(
        (
          await sql`select count(*)::int as n from refunds
                    where org_id in (${a.orgId}, ${b.orgId})`
        )[0]!.n,
      ).toBe(0);

      const found =
        await sql`select ops.device_find_sale(${b.tokenHash}, ${json(ctx, { by: "id", id: s.saleId, serving: await serving(ctx, b, b.owner.userId) })}) as s`;
      expect(found[0]!.s).toEqual([]);
      const own =
        await sql`select ops.device_find_sale(${a.tokenHash}, ${json(ctx, { by: "id", id: s.saleId, serving: await serving(ctx, a, a.owner.userId) })}) as s`;
      expect(own[0]!.s).toHaveLength(1);
    }));

  it("reads: a cashier sees only their own refunds, Shop B nothing, and nobody writes", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      const mine = refundPayload(a, s);
      await refund(ctx, a, mine);
      // a refund rung by the manager
      const theirs = refundPayload(a, s, { done: 1, seq: 2, legs: secondLegs(s), user: a.manager.userId });
      await refund(ctx, a, theirs);

      const ids = async (actor: typeof a.cashier) =>
        (await as(actor, () => sql`select id from refunds`)).map((r) => r.id as string);
      expect(await ids(a.cashier)).toEqual([mine.refund.id]);
      expect((await ids(a.manager)).sort()).toEqual([mine.refund.id, theirs.refund.id].sort());
      expect(await ids(world.b.owner)).toEqual([]);
      expect(
        await as(
          a.cashier,
          () => sql`select id from refund_lines where refund_id = ${theirs.refund.id}`,
        ),
      ).toHaveLength(0);
      expect(await as(world.b.manager, () => sql`select id from refund_payments`)).toHaveLength(0);

      for (const actor of [a.owner, a.manager, a.cashier]) {
        await denied(() =>
          as(actor, () => sql`delete from refunds where id = ${mine.refund.id}`).then((r) => {
            if (r.count === 0) throw Object.assign(new Error("0 rows"), { code: "42501" });
          }),
        );
        await denied(() => as(actor, () => sql`update refunds set amount_cents = 0`));
        await denied(() =>
          as(
            actor,
            () => sql`insert into refunds (id, org_id) values (${randomUUID()}, ${a.orgId})`,
          ),
        );
      }
      // TRUNCATE is stopped by statement triggers. (Not run here: it would lock the sales tables
      // that other test files use at the same time; the same triggers are checked by name.)
      const triggers = await sql`
        select tgrelid::regclass::text as t from pg_trigger
        where tgname in ('refunds_no_truncate', 'refund_lines_no_truncate', 'refund_payments_no_truncate')`;
      expect(triggers.map((r) => r.t).sort()).toEqual([
        "refund_lines",
        "refund_payments",
        "refunds",
      ]);
      await denied(() => sql`update refund_lines set qty = 1`);
      await denied(() => sql`delete from refund_payments`);
    }));

  it("finds sales by receipt number and serial, with units already refunded", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a, 7);
      await sql`set local session_replication_role = replica`;
      await sql`update sale_lines set serial = 'IMEI-123456789' where sale_id = ${s.saleId}`;
      await sql`set local session_replication_role = origin`;
      await refund(ctx, a, refundPayload(a, s));

      const find = async (q: unknown) =>
        (
          await sql`select ops.device_find_sale(${a.tokenHash}, ${json(ctx, { serving: await serving(ctx, a, a.manager.userId), ...(q as object) })}) as s`
        )[0]!.s as {
          sale: { receipt_seq: number };
          lines: { refunded_qty: number; line_no: number }[];
          refunded: { card: number; cash: number };
        }[];
      const byReceipt = await find({ by: "receipt", register_id: a.registerId, seq: 7 });
      expect(byReceipt).toHaveLength(1);
      expect(byReceipt[0]!.lines[0]).toMatchObject({ line_no: 1, refunded_qty: 1 });
      expect(byReceipt[0]!.refunded).toMatchObject({ card: 350, cash: 0 });
      expect(await find({ by: "serial", serial: "imei-123456789" })).toHaveLength(1);
      expect(await find({ by: "serial", serial: "nope" })).toHaveLength(0);
      await ctx.denied(() => find({ by: "all" }), WRONG);
    }));

  it("reports which refunds the server already has", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const s = await makeSale(ctx, a);
      const p = refundPayload(a, s);
      await refund(ctx, a, p);
      const other = randomUUID();
      const rows = await ctx.sql`
        select ops.device_refunds_known(${a.tokenHash}, ${[p.refund.id, other]}::uuid[]) as id`;
      expect(rows.map((r) => r.id)).toEqual([p.refund.id]);
      const b = await ctx.sql`
        select ops.device_refunds_known(${ctx.world.b.tokenHash}, ${[p.refund.id]}::uuid[]) as id`;
      expect(b).toHaveLength(0);
    }));
});

describe("hardening", () => {
  it("a void returns at most the tip the sale took", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      await sql`update organisations set refund_override_cents = 100000 where id = ${a.orgId}`;
      const voidWith = (tip: number, user = a.manager.userId) =>
        refundPayload(a, s, {
          qty: 2,
          kind: "void",
          user,
          legs: [
            { method: "card", amount: 400, type_id: s.card, tip },
            { method: "cash", amount: 300, type_id: s.cash },
          ],
          over: { reason_code: "void_mistake" },
        });
      // the card sale carried a 0.50 tip: 1.00 back is money from nowhere
      await ctx.denied(() => refund(ctx, a, voidWith(100)), WRONG);
      expect(await refund(ctx, a, voidWith(50))).toBe("created");
    }));

  it("refunding a big sale a little at a time does not get round the approval limit", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      // limit 4.00: each unit alone (3.50) is under it, the two together (7.00) are not
      await sql`update organisations set refund_override_cents = 400 where id = ${a.orgId}`;
      expect(await refund(ctx, a, refundPayload(a, s))).toBe("created");
      await ctx.denied(
        () => refund(ctx, a, refundPayload(a, s, { done: 1, seq: 2, legs: secondLegs(s) })),
        ["42501"],
      );
    }));

  it("rounding belongs to the cash leg: none without one", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const s = await makeSale(ctx, a);
      const p = refundPayload(a, s, { over: { cash_rounding: 2, amount: 352, client_amount: 352 } });
      (p.payments[0] as Record<string, unknown>).amount = 352;
      await ctx.denied(() => refund(ctx, a, p), WRONG);
    }));

  it("a refund cannot pre-date its sale, and a void is for the last two days", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      const early = refundPayload(a, s, {
        over: { completed_at: new Date(Date.now() - 3_600_000).toISOString() },
      });
      await ctx.denied(() => refund(ctx, a, early), WRONG);

      // a sale from three days ago cannot be voided, even with a time on its own day
      await sql`set local session_replication_role = replica`;
      await sql`update sales set completed_at = now() - interval '3 days' where id = ${s.saleId}`;
      await sql`set local session_replication_role = origin`;
      const approval = randomUUID();
      await sql`insert into register_approvals (id, org_id, register_id, approver_user_id, purpose, sale_id, max_cents)
                values (${approval}, ${a.orgId}, ${a.registerId}, ${a.manager.userId}, 'refund', ${s.saleId}, 100000)`;
      const old = refundPayload(a, s, {
        qty: 2,
        kind: "void",
        legs: [
          { method: "card", amount: 400, type_id: s.card },
          { method: "cash", amount: 300, type_id: s.cash },
        ],
        over: {
          approval_id: approval,
          reason_code: "void_mistake",
          completed_at: new Date(Date.now() - 3 * 86_400_000 + 60_000).toISOString(),
        },
      });
      await ctx.denied(() => refund(ctx, a, old), WRONG);
    }));

  it("an approval older than a day on the server's clock is dead, whatever time the till claims", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      await sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;
      await sql`set local session_replication_role = replica`;
      await sql`update sales set completed_at = now() - interval '3 days' where id = ${s.saleId}`;
      await sql`set local session_replication_role = origin`;
      const approval = randomUUID();
      await sql`insert into register_approvals (id, org_id, register_id, approver_user_id, purpose, sale_id, max_cents, created_at)
                values (${approval}, ${a.orgId}, ${a.registerId}, ${a.manager.userId}, 'refund', ${s.saleId}, 100000, now() - interval '2 days')`;
      const p = refundPayload(a, s, {
        over: {
          approval_id: approval,
          completed_at: new Date(Date.now() - 2 * 86_400_000 + 60_000).toISOString(),
        },
      });
      await ctx.denied(() => refund(ctx, a, p), ["42501"]);
    }));

  it("three partial cash refunds of a rounded cash sale all go through (the 2c drift adds up)", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const { pid, vid } = await seedProduct(ctx, a.orgId, `sku-${randomUUID().slice(0, 6)}`);
      const cash = (
        await sql`select id from tender_types where location_id = ${a.locationId} and method = 'cash'`
      )[0]!.id as string;
      const saleId = randomUUID();
      // 3 x 10.04 = 30.12, paid in cash with 5c rounding: due 30.10
      const sale = {
        sale: {
          id: saleId,
          org_id: a.orgId,
          register_id: a.registerId,
          user_id: a.cashier.userId,
          receipt_seq: 1,
          mode: "eat_in",
          completed_at: new Date().toISOString(),
          priced_as_of: new Date().toISOString(),
          items_total: 3012,
          vat: 563,
          non_vat: 0,
          cash_rounding: -2,
          amount_due: 3010,
          client_due: 3010,
        },
        lines: [
          {
            kind: "item",
            variant_id: vid,
            product_id: pid,
            name: "Thing",
            qty: 3,
            unit_price_cents: 1004,
            modifiers: [],
            discount_cents: 0,
            tax_category: "STANDARD",
            tax_rate_bp: 2300,
            net_cents: 2449,
            vat_cents: 563,
            gross_cents: 3012,
          },
        ],
        payments: [{ type_id: cash, method: "cash", amount: 3010, tendered: 3010, change: 0 }],
      };
      await sql`select ops.record_sale(${json(ctx, sale)})`;
      const share = (total: number, k: number) => Math.round((total * k) / 3 + 1e-9);
      for (let done = 0; done < 3; done++) {
        const gross = share(3012, done + 1) - share(3012, done); // 1004 each
        const vat = share(563, done + 1) - share(563, done);
        const due = Math.round((gross + 2) / 5) * 5; // the cash share rounded to 5c: 1005
        const p = {
          refund: {
            id: randomUUID(),
            org_id: a.orgId,
            register_id: a.registerId,
            user_id: a.manager.userId,
            original_sale_id: saleId,
            kind: "refund",
            reason_code: "changed_mind",
            receipt_seq: done + 1,
            completed_at: new Date().toISOString(),
            items_total: gross,
            vat,
            non_vat: 0,
            credit: 0,
            cash_rounding: due - gross,
            amount: due,
            client_amount: due,
          },
          lines: [
            { line_no: 1, qty: 1, restock: true, gross_cents: gross, vat_cents: vat, net_cents: gross - vat },
          ],
          payments: [{ type_id: cash, method: "cash", amount: due, tip: 0 }],
        };
        expect(await refund(ctx, a, p)).toBe("created");
      }
    }));
});

describe("server-signed serving tokens", () => {
  const issue = async (ctx: Ctx, shop: Shop, user: string, hash = shop.tokenHash) =>
    (await ctx.sql`select ops.issue_serving_token(${hash}, ${user}) as t`)[0]!.t as string;

  /** A token signed with this database's own key, for payloads the app never issues (expired...). */
  const sign = async (ctx: Ctx, payload: Record<string, unknown>) => {
    const p = Buffer.from(JSON.stringify(payload)).toString("base64");
    const sig = (
      await ctx.sql`select encode(extensions.hmac(convert_to(${p}, 'utf8'),
                     (select key from ops.signing_keys where id = 1), 'sha256'), 'hex') as s`
    )[0]!.s as string;
    return `${p}.${sig}`;
  };
  const payloadFor = (a: Shop, user: string, over: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return { v: 1, u: user, o: a.orgId, r: a.registerId, p: 0, iat: now, exp: now + 3600, jti: randomUUID(), ...over };
  };

  let attemptSeq = 100;
  /** A refund above the 1.00 limit by the given cashier carrying the given token. */
  async function attempt(ctx: Ctx, a: Shop, user: string, token: string | null, over: Record<string, unknown> = {}) {
    await ctx.sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;
    const n = ++attemptSeq; // each attempt is its own sale with its own receipt numbers
    const s = await makeSale(ctx, a, n);
    const p = refundPayload(a, s, { user, seq: n, over: { serving_token: token, ...over } });
    return { s, p, result: await refund(ctx, a, p) };
  }
  const stateOf = async (ctx: Ctx, id: string) =>
    (await ctx.sql`select approval_state from refunds where id = ${id}`)[0]!.approval_state as string;
  const attentionOf = async (ctx: Ctx, orgId: string) =>
    (await ctx.sql`select id, reason from sync_rejections where org_id = ${orgId}`).map((r) => r.reason);

  it("a valid token proves a manager is serving: recorded as verified, nothing for Needs attention", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const token = await issue(ctx, a, a.manager.userId);
      const { p, result } = await attempt(ctx, a, a.manager.userId, token);
      expect(result).toBe("created");
      expect(await stateOf(ctx, p.refund.id)).toBe("verified");
      expect(await attentionOf(ctx, a.orgId)).toEqual([]);
      const [audit] = await ctx.sql`select after from audit_log where entity_id = ${p.refund.id}`;
      expect(audit!.after).toMatchObject({
        approval: "verified",
        serving_verified: true,
        serving_user_id: a.manager.userId,
        register_id: a.registerId,
      });
      expect(audit!.after).toHaveProperty("completed_at");
      expect(audit!.after).toHaveProperty("received_at");
      const [row] = await ctx.sql`select approved_by, cashier_user_id from refunds where id = ${p.refund.id}`;
      expect(row).toEqual({ approved_by: a.manager.userId, cashier_user_id: a.manager.userId });
    }));

  it("a valid token for a CASHIER still needs a manager's approval", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const token = await issue(ctx, a, a.cashier.userId);
      await ctx.sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;
      const s = await makeSale(ctx, a);
      await ctx.denied(
        () => refund(ctx, a, refundPayload(a, s, { over: { serving_token: token } })),
        ["42501"],
      );
    }));

  it("a token for someone else than the named cashier is refused", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const managersToken = await issue(ctx, a, a.manager.userId);
      await ctx.sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;
      const s = await makeSale(ctx, a);
      // the cashier's refund carrying the manager's token
      await ctx.denied(
        () => refund(ctx, a, refundPayload(a, s, { over: { serving_token: managersToken } })),
        ["42501"],
      );
    }));

  it("a tampered token proves nothing: the claim stays Not verified and goes to Needs attention", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const token = await issue(ctx, a, a.manager.userId);
      const [payload, sig] = token.split(".");
      const flipped = sig!.replace(/^./, (c) => (c === "0" ? "1" : "0"));
      const forgedPayload = Buffer.from(
        JSON.stringify({ ...payloadFor(a, a.owner.userId) }),
      ).toString("base64");
      for (const bad of [`${payload}.${flipped}`, `${forgedPayload}.${sig}`, "garbage", `${payload}`]) {
        const { p, result } = await attempt(ctx, a, a.manager.userId, bad);
        expect(result).toBe("created");
        expect(await stateOf(ctx, p.refund.id)).toBe("self");
      }
      expect((await attentionOf(ctx, a.orgId)).every((r) => r === "refund_unverified")).toBe(true);
      expect((await attentionOf(ctx, a.orgId)).length).toBe(4);
    }));

  it("an expired token proves nothing, and neither does one older than its day of grace", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const now = Math.floor(Date.now() / 1000);
      // made an hour ago, expired half an hour ago: the refund is made NOW
      const expired = await sign(ctx, payloadFor(a, a.manager.userId, { iat: now - 5400, exp: now - 1800 }));
      const one = await attempt(ctx, a, a.manager.userId, expired);
      expect(await stateOf(ctx, one.p.refund.id)).toBe("self");

      // (a refund made offline within the token's hour is proven on sync: see the next test)
      // one older than a day past expiry is dead whatever time the till claims
      const old = await sign(
        ctx,
        payloadFor(a, a.manager.userId, { iat: now - 3 * 86_400, exp: now - 3 * 86_400 + 3600 }),
      );
      const s3 = await makeSale(ctx, a, 3);
      const stale = refundPayload(a, s3, {
        seq: 3,
        user: a.manager.userId,
        over: {
          serving_token: old,
          completed_at: new Date(Date.now() - 3 * 86_400_000 + 1_800_000).toISOString(),
        },
      });
      // the refund would pre-date its sale, so move the sale back in time too
      await ctx.sql`set local session_replication_role = replica`;
      await ctx.sql`update sales set completed_at = now() - interval '3 days' where id = ${s3.saleId}`;
      await ctx.sql`set local session_replication_role = origin`;
      expect(await refund(ctx, a, stale)).toBe("created");
      expect(await stateOf(ctx, stale.refund.id)).toBe("self");
    }));

  it("a refund made offline within the token's hour is proven when it syncs, up to a day later", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const now = Math.floor(Date.now() / 1000);
      // the manager unlocked 2 hours ago (token valid for the hour after that), made the refund 1.5
      // hours ago offline, and the till syncs now
      const token = await sign(ctx, payloadFor(a, a.manager.userId, { iat: now - 7200, exp: now - 3600 }));
      await sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;
      const s = await makeSale(ctx, a, 2);
      await sql`set local session_replication_role = replica`;
      await sql`update sales set completed_at = now() - interval '3 hours' where id = ${s.saleId}`;
      await sql`set local session_replication_role = origin`;
      const p = refundPayload(a, s, {
        seq: 2,
        user: a.manager.userId,
        over: {
          serving_token: token,
          completed_at: new Date(Date.now() - 5_400_000).toISOString(),
        },
      });
      expect(await refund(ctx, a, p)).toBe("created");
      expect(await stateOf(ctx, p.refund.id)).toBe("verified");
      expect(await attentionOf(ctx, a.orgId)).toEqual([]);
    }));

  it("pairing the till again ends every token it had", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const token = await issue(ctx, a, a.manager.userId);
      await sql`update registers set paired_at = now() + interval '1 second' where id = ${a.registerId}`;
      const one = await attempt(ctx, a, a.manager.userId, token);
      expect(await stateOf(ctx, one.p.refund.id)).toBe("self");
      // a token issued after the new pairing works
      const fresh = await issue(ctx, a, a.manager.userId);
      const two = await attempt(ctx, a, a.manager.userId, fresh);
      expect(await stateOf(ctx, two.p.refund.id)).toBe("verified");
    }));

  it("nobody can read, change or remove the signing key, not even the app's own roles", () =>
    inWorld(async (ctx) => {
      const { sql, denied } = ctx;
      await denied(async () => {
        await sql.unsafe("set local role tillflow_ops");
        await sql`select key from ops.signing_keys`;
      });
      await denied(() => ctx.asService(() => sql`select key from ops.signing_keys`));
      // even the owner of the table is stopped by the trigger
      await denied(() => sql`delete from ops.signing_keys`);
      await denied(() => sql`update ops.signing_keys set key = '\\x00'::bytea`);
      await denied(() => sql`truncate ops.signing_keys`);
      expect((await sql`select count(*)::int as n from ops.signing_keys`)[0]!.n).toBe(1);
    }));

  it("a token for a different till, or a different shop, proves nothing", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const [a, b] = [world.a, world.b];
      const till2 = randomUUID();
      const hash2 = "b".repeat(64);
      await sql`insert into registers (id, org_id, location_id, name, device_token_hash)
                values (${till2}, ${a.orgId}, ${a.locationId}, 'Till 2', ${hash2})`;
      const forTill2 = await issue(ctx, a, a.manager.userId, hash2);
      const one = await attempt(ctx, a, a.manager.userId, forTill2);
      expect(await stateOf(ctx, one.p.refund.id)).toBe("self");
      // shop B's own token, with shop A's manager named: not a member there, proves nothing here
      await ctx.denied(() => issue(ctx, b, a.manager.userId), ["42501"]);
      const forB = await issue(ctx, b, b.manager.userId);
      const two = await attempt(ctx, a, a.manager.userId, forB);
      expect(await stateOf(ctx, two.p.refund.id)).toBe("self");
    }));

  it("a cashier naming a manager (as cashier or as approver) without a valid token is never verified", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      // 1. the cashier's till says a manager is serving
      const asManager = await attempt(ctx, a, a.manager.userId, null);
      expect(await stateOf(ctx, asManager.p.refund.id)).toBe("self");
      // not proven: no serving identity is recorded as proof
      const [unproven] = await ctx.sql`select after from audit_log where entity_id = ${asManager.p.refund.id}`;
      expect(unproven!.after).toMatchObject({ approval: "self", serving_verified: false, serving_user_id: null });
      // 2. the cashier's till names a manager as approver
      const named = await attempt(ctx, a, a.cashier.userId, null, { claimed_approver: a.manager.userId });
      expect(await stateOf(ctx, named.p.refund.id)).toBe("unverified");
      // 3. both are in Needs attention for a manager to check
      expect(await attentionOf(ctx, a.orgId)).toEqual(["refund_unverified", "refund_unverified"]);
      // 4. a plain cashier with neither is refused outright
      await ctx.denied(() => attempt(ctx, a, a.cashier.userId, null), ["42501"]);
    }));

  it("an approval row, not a token, is what a cashier needs: verified, bound to the sale", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      await ctx.sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;
      const s = await makeSale(ctx, a);
      const approval = (
        await ctx.sql`select ops.issue_approval(${a.tokenHash}, ${a.manager.userId}, 'refund', ${s.saleId}::uuid, 100000::integer) as id`
      )[0]!.id as string;
      const token = await issue(ctx, a, a.cashier.userId);
      const p = refundPayload(a, s, { over: { approval_id: approval, serving_token: token } });
      expect(await refund(ctx, a, p)).toBe("created");
      expect(await stateOf(ctx, p.refund.id)).toBe("verified");
      expect(await attentionOf(ctx, a.orgId)).toEqual([]);
    }));

  it("only the server issues tokens, and only for staff on a paired till", () =>
    inWorld(async (ctx) => {
      const { world, as, denied } = ctx;
      const a = world.a;
      await denied(() => issue(ctx, a, randomUUID()), ["42501"]);
      await denied(() => issue(ctx, a, a.cashier.userId, "0".repeat(64)), ["42501"]);
      // clients cannot call it, and cannot read the signing key
      for (const actor of [a.owner, a.manager, a.cashier]) {
        await denied(() =>
          as(actor, () => ctx.sql`select ops.issue_serving_token(${a.tokenHash}, ${actor.userId})`),
        );
        await denied(() => as(actor, () => ctx.sql`select key from ops.signing_keys`));
      }
      await denied(() => as(null, () => ctx.sql`select key from ops.signing_keys`));
    }));

  it("the lookup takes who is serving from the token: tampered, expired or missing means cashier-level", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const till2 = randomUUID();
      await sql`insert into registers (id, org_id, location_id, name, device_token_hash)
                values (${till2}, ${a.orgId}, ${a.locationId}, 'Till 2', 'y')`;
      const other = await makeSale(ctx, { ...a, registerId: till2 }, 1);
      const find = async (serving: string | null) =>
        (
          await sql`select ops.device_find_sale(${a.tokenHash}, ${json(ctx, { by: "id", id: other.saleId, serving })}) as s`
        )[0]!.s as unknown[];
      // a manager's valid token finds the other till's sale
      expect(await find(await issue(ctx, a, a.manager.userId))).toHaveLength(1);
      // no token, garbage, a tampered signature, and an expired token do not
      const good = await issue(ctx, a, a.manager.userId);
      const [payload, sig] = good.split(".");
      const now = Math.floor(Date.now() / 1000);
      const expired = await sign(ctx, payloadFor(a, a.manager.userId, { iat: now - 7200, exp: now - 3600 }));
      for (const bad of [null, "garbage", `${payload}.${sig!.replace(/^./, (c) => (c === "0" ? "1" : "0"))}`, expired]) {
        expect(await find(bad)).toHaveLength(0);
      }
      // a lookup is stricter than a refund: an expired token gets no day of grace
    }));
});

describe("bound approvals, unverified refunds, lookup scope", () => {
  const issue = async (ctx: Ctx, a: Shop, sale: string | null, max: number | null) =>
    (
      await ctx.sql`select ops.issue_approval(${a.tokenHash}, ${a.manager.userId}, 'refund',
                      ${sale}::uuid, ${max}::integer) as id`
    )[0]!.id as string;

  it("a refund approval is for ONE sale and up to a value", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      await sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;
      const first = await makeSale(ctx, a, 1);
      const other = await makeSale(ctx, a, 2);

      // approved for the other sale: useless here
      const forOther = await issue(ctx, a, other.saleId, 100000);
      await ctx.denied(
        () => refund(ctx, a, refundPayload(a, first, { over: { approval_id: forOther } })),
        ["42501"],
      );
      // approved for 1.00: not for a 3.50 refund
      const small = await issue(ctx, a, first.saleId, 100);
      await ctx.denied(
        () => refund(ctx, a, refundPayload(a, first, { over: { approval_id: small } })),
        ["42501"],
      );
      // an approval bound to this sale and enough value works, once
      const good = await issue(ctx, a, first.saleId, 350);
      const p = refundPayload(a, first, { over: { approval_id: good } });
      expect(await refund(ctx, a, p)).toBe("created");
      expect(
        (await sql`select approval_state from refunds where id = ${p.refund.id}`)[0]!.approval_state,
      ).toBe("verified");
      // an approval with no sale (the old kind) is not accepted for a refund at all
      const unbound = randomUUID();
      await sql`insert into register_approvals (id, org_id, register_id, approver_user_id, purpose)
                values (${unbound}, ${a.orgId}, ${a.registerId}, ${a.manager.userId}, 'refund')`;
      await ctx.denied(
        () =>
          refund(
            ctx,
            a,
            refundPayload(a, first, { done: 1, seq: 2, legs: secondLegs(first), over: { approval_id: unbound } }),
          ),
        ["42501"],
      );
    }));

  it("a refund approval must name its sale and a value; other purposes must not", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const call = (purpose: string, sale: string | null, max: number | null) =>
        ctx.sql`select ops.issue_approval(${a.tokenHash}, ${a.manager.userId}, ${purpose},
                  ${sale}::uuid, ${max}::integer)`;
      await ctx.denied(() => call("refund", null, null), WRONG);
      await ctx.denied(() => call("refund", randomUUID(), null), WRONG);
      await ctx.denied(() => call("refund", randomUUID(), -1), WRONG);
      await ctx.denied(() => call("discount", randomUUID(), 100), WRONG);
      await call("refund", randomUUID(), 100);
      await call("discount", null, null);
    }));

  it("a refund that needed a manager but was not proven goes to Needs attention (still recorded)", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      await sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;
      const s = await makeSale(ctx, a);

      // offline: the till names the manager
      const claimed = refundPayload(a, s, { over: { claimed_approver: a.manager.userId } });
      expect(await refund(ctx, a, claimed)).toBe("created");
      // a manager serving at the till
      const self = refundPayload(a, s, {
        done: 1,
        seq: 2,
        legs: secondLegs(s),
        user: a.manager.userId,
      });
      expect(await refund(ctx, a, self)).toBe("created");

      const rows = await sql`select id, reason, status, detail from sync_rejections
                             where org_id = ${a.orgId} order by created_at`;
      expect(rows.map((r) => [r.id, r.reason, r.status])).toEqual([
        [claimed.refund.id, "refund_unverified", "open"],
        [self.refund.id, "refund_unverified", "open"],
      ]);
      expect(rows[0]!.detail).toMatchObject({ kind: "refund", recorded: true, state: "unverified" });
      expect(rows[1]!.detail).toMatchObject({ state: "self" });
      // a manager closes it with a note (audited); the refund itself is untouched
      await ctx.as(a.manager, () =>
        sql`select public.resolve_sync_rejection(${claimed.refund.id}, 'Checked with the cashier', ${randomUUID()})`,
      );
      expect(
        (await sql`select status from sync_rejections where id = ${claimed.refund.id}`)[0]!.status,
      ).toBe("resolved");
      expect(
        (await sql`select approval_state from refunds where id = ${claimed.refund.id}`)[0]!
          .approval_state,
      ).toBe("unverified");
    }));

  it("a verified refund, or one under the limit, adds nothing to Needs attention", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      expect(await refund(ctx, a, refundPayload(a, s))).toBe("created"); // under the 20.00 default
      const good = await issue(ctx, a, s.saleId, 100000);
      await sql`update organisations set refund_override_cents = 100 where id = ${a.orgId}`;
      expect(
        await refund(
          ctx,
          a,
          refundPayload(a, s, { done: 1, seq: 2, legs: secondLegs(s), over: { approval_id: good } }),
        ),
      ).toBe("created");
      expect(
        (await sql`select count(*)::int as n from sync_rejections where org_id = ${a.orgId}`)[0]!.n,
      ).toBe(0);
    }));

  it("the lookup: a cashier finds this till's sales and their own, a manager any; no cashier ids come out", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const mine = await makeSale(ctx, a, 1); // rung by a.cashier on this till
      // a second till of the same shop, and a sale there by someone else
      const till2 = randomUUID();
      await sql`insert into registers (id, org_id, location_id, name, device_token_hash)
                values (${till2}, ${a.orgId}, ${a.locationId}, 'Till 2', 'x')`;
      const second = await makeSale(ctx, { ...a, registerId: till2 }, 1);
      await sql`set local session_replication_role = replica`;
      await sql`update sales set cashier_user_id = ${a.manager.userId} where id = ${second.saleId}`;
      await sql`set local session_replication_role = origin`;

      const find = async (id: string, viewer: string) =>
        (
          await sql`select ops.device_find_sale(${a.tokenHash}, ${json(ctx, {
            by: "id",
            id,
            serving: await serving(ctx, a, viewer),
          })}) as s`
        )[0]!.s as { sale: Record<string, unknown> }[];

      expect(await find(mine.saleId, a.cashier.userId)).toHaveLength(1);
      // Till 2's sale was rung by the manager: this till's cashier does not see it...
      expect(await find(second.saleId, a.cashier.userId)).toHaveLength(0);
      // ...but a manager or owner does
      expect(await find(second.saleId, a.manager.userId)).toHaveLength(1);
      expect(await find(second.saleId, a.owner.userId)).toHaveLength(1);
      // and a cashier does see their own sale from the other till
      await sql`set local session_replication_role = replica`;
      await sql`update sales set cashier_user_id = ${a.cashier.userId} where id = ${second.saleId}`;
      await sql`set local session_replication_role = origin`;
      const own = await find(second.saleId, a.cashier.userId);
      expect(own).toHaveLength(1);
      // no cashier id leaves the database
      expect(JSON.stringify(own)).not.toContain(a.cashier.userId);
      expect(own[0]!.sale).not.toHaveProperty("cashier_user_id");
      // a token cannot be issued for someone who is not staff of this shop
      await ctx.denied(() => find(mine.saleId, world.b.owner.userId), ["42501"]);
      await ctx.denied(() => find(mine.saleId, randomUUID()), ["42501"]);
    }));
});

describe("exchanges", () => {
  async function exchangeRefund(
    ctx: Ctx,
    a: Shop,
    s: Awaited<ReturnType<typeof makeSale>>,
    exSale: string,
  ) {
    // 1 unit (3.50) comes back as credit, nothing is paid out
    const p = refundPayload(a, s, {
      kind: "exchange",
      legs: [],
      credit: 350,
      exchangeSaleId: exSale,
    });
    p.refund.amount = 0;
    p.refund.client_amount = 0;
    return p;
  }

  function exchangeSalePayload(
    a: Shop,
    s: { vid: string; pid: string; cash: string },
    id: string,
    refundId: string,
    over = {},
  ) {
    // a new 5.00 sale (VAT 93) paid with 3.50 credit + 1.50 cash
    return {
      sale: {
        id,
        org_id: a.orgId,
        register_id: a.registerId,
        user_id: a.cashier.userId,
        receipt_seq: 50,
        mode: "eat_in",
        completed_at: new Date().toISOString(),
        priced_as_of: new Date().toISOString(),
        items_total: 500,
        vat: 93,
        non_vat: 0,
        cash_rounding: 0,
        amount_due: 500,
        client_due: 500,
      },
      lines: [
        {
          kind: "item",
          variant_id: s.vid,
          product_id: s.pid,
          name: "Tea",
          qty: 1,
          unit_price_cents: 500,
          modifiers: [],
          discount_cents: 0,
          tax_category: "STANDARD",
          tax_rate_bp: 2300,
          net_cents: 407,
          vat_cents: 93,
          gross_cents: 500,
        },
      ],
      payments: [
        { method: "exchange", amount: 350, tendered: 350, change: 0, refund_id: refundId, ...over },
        { type_id: s.cash, method: "cash", amount: 150, tendered: 150, change: 0 },
      ],
    };
  }

  it("an exchange sale is paid with the credit of its refund, once", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      const exSale = randomUUID();
      const ex = await exchangeRefund(ctx, a, s, exSale);
      const salePayload = exchangeSalePayload(a, s, exSale, ex.refund.id);
      const record = async (p: unknown) =>
        (await sql`select ops.record_sale(${json(ctx, p)}) as r`)[0]!.r as string;

      // The refund has not arrived: the sale waits (retryable), it is not rejected.
      expect(await record(salePayload)).toBe("exchange_pending");
      expect(await refund(ctx, a, ex)).toBe("created");
      expect(
        (
          await sql`select kind, credit_cents, amount_cents, exchange_sale_id from refunds where id = ${ex.refund.id}`
        )[0],
      ).toEqual({ kind: "exchange", credit_cents: 350, amount_cents: 0, exchange_sale_id: exSale });
      expect(
        (
          await sql`select method, amount_cents from refund_payments where refund_id = ${ex.refund.id}`
        )[0],
      ).toEqual({ method: "exchange", amount_cents: 350 });

      // the credit must match the refund's exactly
      const wrong = exchangeSalePayload(a, s, exSale, ex.refund.id);
      wrong.payments[0]!.amount = 360;
      wrong.payments[0]!.tendered = 360;
      wrong.payments[1]!.amount = 140;
      wrong.payments[1]!.tendered = 140;
      await ctx.denied(() => record(wrong), WRONG);
      // another sale id cannot use it either
      const other = exchangeSalePayload(a, s, randomUUID(), ex.refund.id);
      await ctx.denied(() => record(other), WRONG);

      expect(await record(salePayload)).toBe("created");
      expect(
        (
          await sql`select method, exchange_refund_id from payments where sale_id = ${exSale} and method = 'exchange'`
        )[0],
      ).toEqual({ method: "exchange", exchange_refund_id: ex.refund.id });
      expect(await record(salePayload)).toBe("duplicate");
    }));

  it("exchange credit that paid for a sale is not money: it cannot be paid out in any way", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      const exSale = randomUUID();
      const ex = await exchangeRefund(ctx, a, s, exSale);
      await refund(ctx, a, ex);
      const record = async (p: unknown) =>
        (await sql`select ops.record_sale(${json(ctx, p)}) as r`)[0]!.r as string;
      expect(await record(exchangeSalePayload(a, s, exSale, ex.refund.id))).toBe("created");
      // refund the exchange sale (one 5.00 line, 3.50 of it paid by credit, 1.50 in cash)
      const refundOfSale = (legs: { method: string; amount: number; type_id?: string }[]) => {
        const p = refundPayload(a, { ...s, saleId: exSale }, { legs, seq: 7, user: a.manager.userId });
        p.refund.items_total = 500;
        p.refund.vat = 93;
        p.refund.amount = legs.reduce((n, l) => n + l.amount, 0);
        p.refund.client_amount = p.refund.amount;
        p.lines = [{ line_no: 1, qty: 1, restock: true, gross_cents: 500, vat_cents: 93, net_cents: 407 }];
        return p;
      };
      // all of it in cash or on a card: the credit part is not money
      await ctx.denied(
        () => refund(ctx, a, refundOfSale([{ method: "cash", amount: 500, type_id: s.cash }])),
        WRONG,
      );
      await ctx.denied(
        () => refund(ctx, a, refundOfSale([{ method: "card", amount: 500, type_id: s.card }])),
        WRONG,
      );
      // and the 1.50 of real cash alone does not cover the refund either
      await ctx.denied(
        () => refund(ctx, a, refundOfSale([{ method: "cash", amount: 150, type_id: s.cash }])),
        WRONG,
      );
    }));

  it("an exchange needs credit and a sale, and a plain refund must carry neither", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const s = await makeSale(ctx, a);
      const noCredit = refundPayload(a, s, { kind: "exchange", exchangeSaleId: randomUUID() });
      await ctx.denied(() => refund(ctx, a, noCredit), WRONG);
      const stray = refundPayload(a, s, { exchangeSaleId: randomUUID() });
      await ctx.denied(() => refund(ctx, a, stray), WRONG);
    }));
});

describe("refund settings and totals", () => {
  it("only an owner sets the approval limit, and it is audited", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = world.a;
      await as(
        a.owner,
        () => sql`select public.set_refund_override(${a.orgId}, 5000, ${randomUUID()})`,
      );
      expect(
        (await sql`select refund_override_cents from organisations where id = ${a.orgId}`)[0]!
          .refund_override_cents,
      ).toBe(5000);
      expect(
        (
          await sql`select after from audit_log
                    where action = 'organisation.refund_override_changed' and org_id = ${a.orgId}`
        )[0]!.after,
      ).toEqual({ cents: 5000 });
      for (const actor of [a.manager, a.cashier, world.b.owner]) {
        await denied(() =>
          as(actor, () => sql`select public.set_refund_override(${a.orgId}, 1, ${randomUUID()})`),
        );
      }
      await denied(
        () =>
          as(
            a.owner,
            () => sql`select public.set_refund_override(${a.orgId}, -1, ${randomUUID()})`,
          ),
        ["22023"],
      );
      // a client cannot write the column directly
      await denied(() =>
        as(
          a.owner,
          () => sql`update organisations set refund_override_cents = 0 where id = ${a.orgId}`,
        ),
      );
    }));

  it("refund totals per payment type are for managers only", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = world.a;
      const s = await makeSale(ctx, a);
      await refund(ctx, a, refundPayload(a, s));
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const to = new Date(Date.now() + 3_600_000).toISOString();
      const rows = await as(
        a.manager,
        () => sql`select * from public.refund_totals(${a.orgId}, ${from}, ${to})`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ method: "card", refunds: "1", amount_cents: "350" });
      await denied(() =>
        as(a.cashier, () => sql`select * from public.refund_totals(${a.orgId}, ${from}, ${to})`),
      );
      await denied(() =>
        as(
          world.b.owner,
          () => sql`select * from public.refund_totals(${a.orgId}, ${from}, ${to})`,
        ),
      );
    }));
});
