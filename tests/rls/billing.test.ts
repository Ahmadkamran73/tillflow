// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { makeReference, referenceCheckChar } from "@/lib/billing/reference";
import { inWorld, sql, type Actor, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const NOT_ALLOWED = ["42501"];
const BAD_VALUE = ["22023"];
const PAUSED = ["TF004"];

/** A two-step (aal2) session, which a super-admin needs. */
const AAL2 = { aal: "aal2" as const };
const AAL1 = { aal: "aal1" as const };

type Figures = Partial<{
  id: string;
  org_id: string;
  period_start: string;
  period_end: string;
  amount_ex_vat_cents: number;
  vat_rate_bp: number;
  vat_cents: number;
  total_cents: number;
  due_on: string;
  payment_reference: string;
  supplier_name: string;
  supplier_address: string;
  supplier_vat_number: string;
}>;

const figures = (orgId: string, over: Figures = {}) => ({
  id: randomUUID(),
  org_id: orgId,
  period_start: "2026-11-01",
  period_end: "2026-12-01",
  amount_ex_vat_cents: 4900,
  vat_rate_bp: 2300,
  vat_cents: 1127,
  total_cents: 6027,
  due_on: "2026-11-15",
  payment_reference: makeReference("1126"),
  supplier_name: "Tillflow Ltd",
  supplier_address: "1 Main Street, Dublin",
  supplier_vat_number: "IE1234567FA",
  ...over,
});

async function subscription(ctx: Ctx, shop: Shop) {
  await ctx.sql`insert into subscriptions (id, org_id, status, price_cents)
                values (${randomUUID()}, ${shop.orgId}, 'trial', 4900)`;
}

async function issue(ctx: Ctx, shop: Shop, over: Figures = {}) {
  const f = figures(shop.orgId, over);
  const [row] = await ctx.sql`select ops.billing_issue_invoice(${ctx.sql.json(f)}) as r`;
  return {
    f,
    r: row!.r as { created: boolean; id: string; invoice_no: number; payment_reference: string },
  };
}

async function makeAdmin(ctx: Ctx): Promise<Actor> {
  const admin: Actor = { userId: randomUUID(), role: "owner" };
  await ctx.sql`insert into platform_admins (user_id) values (${admin.userId})`;
  return admin;
}

async function codeOf(fn: () => PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe("payment reference check (SQL twin of reference.ts)", () => {
  it("gives the same check character and validity as the TypeScript code", () =>
    inWorld(async (ctx) => {
      for (const payload of ["7K3Q0925", "ABCD1026", "22220101", "ZZZZ1299", "H2M80126"]) {
        const [row] = await ctx.sql`select app.billing_reference_check(${payload}) as c`;
        expect(row!.c).toBe(referenceCheckChar(payload));
      }
      for (let i = 0; i < 200; i++) {
        const ref = makeReference("0926");
        const [ok] = await ctx.sql`select app.billing_reference_valid(${ref}) as v`;
        expect(ok!.v).toBe(true);
        const bad = ref.slice(0, -1) + (ref.endsWith("A") ? "B" : "A");
        const [no] = await ctx.sql`select app.billing_reference_valid(${bad}) as v`;
        expect(no!.v).toBe(false);
      }
      const [junk] = await ctx.sql`select app.billing_reference_valid('hello') as v`;
      expect(junk!.v).toBe(false);
    }));
});

describe("who can read billing data", () => {
  it("an owner reads only their own subscription and invoices", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await subscription(ctx, a);
      await subscription(ctx, b);
      await issue(ctx, a);
      await issue(ctx, b, { period_start: "2026-11-01" });

      const mine = await ctx.as(a.owner, () => ctx.sql`select org_id from billing_invoices`);
      expect(mine.map((r) => r.org_id)).toEqual([a.orgId]);
      const subs = await ctx.as(a.owner, () => ctx.sql`select org_id from subscriptions`);
      expect(subs.map((r) => r.org_id)).toEqual([a.orgId]);
    }));

  it("managers, cashiers and anon read nothing or are refused", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      await issue(ctx, a);
      for (const who of [a.manager, a.cashier]) {
        expect(await ctx.as(who, () => ctx.sql`select 1 from billing_invoices`)).toHaveLength(0);
        expect(await ctx.as(who, () => ctx.sql`select 1 from subscriptions`)).toHaveLength(0);
      }
      await ctx.denied(
        () => ctx.as(null, () => ctx.sql`select 1 from billing_invoices`),
        NOT_ALLOWED,
      );
    }));

  it("an owner who has two-step set up but is on aal1 sees nothing", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      await issue(ctx, a);
      await ctx.sql`insert into auth.users (id, aud, role) values (${a.owner.userId}, 'authenticated', 'authenticated') on conflict do nothing`;
      await ctx.sql`insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at, secret)
                    values (${randomUUID()}, ${a.owner.userId}, 'totp', 'verified', now(), now(), 'x')`;
      expect(
        await ctx.as(a.owner, () => ctx.sql`select 1 from billing_invoices`, AAL1),
      ).toHaveLength(0);
      expect(
        await ctx.as(a.owner, () => ctx.sql`select 1 from billing_invoices`, AAL2),
      ).toHaveLength(1);
    }));

  it("nobody can write the tables or read the counter and admin list", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      await ctx.denied(
        () =>
          ctx.as(
            a.owner,
            () => ctx.sql`update billing_invoices set total_cents = 1 where id = ${r.id}`,
          ),
        NOT_ALLOWED,
      );
      await ctx.denied(
        () => ctx.as(a.owner, () => ctx.sql`delete from billing_invoices where id = ${r.id}`),
        NOT_ALLOWED,
      );
      await ctx.denied(
        () =>
          ctx.as(
            a.owner,
            () => ctx.sql`update subscriptions set status = 'active' where org_id = ${a.orgId}`,
          ),
        NOT_ALLOWED,
      );
      await ctx.denied(
        () => ctx.as(a.owner, () => ctx.sql`select * from billing_counters`),
        NOT_ALLOWED,
      );
      await ctx.denied(
        () => ctx.as(a.owner, () => ctx.sql`select * from platform_admins`),
        NOT_ALLOWED,
      );
      await ctx.denied(
        () =>
          ctx.as(
            a.owner,
            () => ctx.sql`insert into platform_admins (user_id) values (${a.owner.userId})`,
          ),
        NOT_ALLOWED,
      );
      // The ops functions are closed to signed-in users.
      await ctx.denied(
        () => ctx.as(a.owner, () => ctx.sql`select ops.billing_candidates()`),
        NOT_ALLOWED,
      );
    }));
});

describe("invoices are immutable", () => {
  it("even the database owner cannot change figures, numbers, references or delete", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      for (const change of [
        ctx.sql`update billing_invoices set total_cents = 1, amount_ex_vat_cents = 1, vat_cents = 0 where id = ${r.id}`,
        ctx.sql`update billing_invoices set invoice_no = 999999 where id = ${r.id}`,
        ctx.sql`update billing_invoices set payment_reference = 'TF-AAAA-0126-A' where id = ${r.id}`,
        ctx.sql`update billing_invoices set due_on = due_on + 30 where id = ${r.id}`,
        ctx.sql`delete from billing_invoices where id = ${r.id}`,
        ctx.sql`truncate billing_invoices`,
      ]) {
        await ctx.denied(() => change, NOT_ALLOWED);
      }
    }));

  it("paid details cannot be set without the payment, and a paid invoice is frozen", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      await ctx.denied(
        () => ctx.sql`update billing_invoices set bank_reference = 'x' where id = ${r.id}`,
        NOT_ALLOWED.concat("23514"),
      );
      const admin = await makeAdmin(ctx);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_mark_paid(${r.id}, 'SEPA 123456', current_date)`,
        AAL2,
      );
      await ctx.denied(
        () => ctx.sql`update billing_invoices set reminder_1_sent_at = now() where id = ${r.id}`,
        NOT_ALLOWED,
      );
      await ctx.denied(
        () => ctx.sql`update billing_invoices set status = 'issued' where id = ${r.id}`,
        NOT_ALLOWED.concat("23514"),
      );
    }));
});

describe("issuing invoices", () => {
  it("numbers invoices one after another and is idempotent per period", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await subscription(ctx, a);
      await subscription(ctx, b);
      const one = await issue(ctx, a);
      const two = await issue(ctx, b);
      expect(one.r.created).toBe(true);
      expect(two.r.invoice_no).toBe(one.r.invoice_no + 1);
      // The same business and period again (a job that ran twice): the first invoice, no new number.
      const again = await issue(ctx, a);
      expect(again.r).toMatchObject({ created: false, id: one.r.id, invoice_no: one.r.invoice_no });
      const three = await issue(ctx, a, { period_start: "2026-12-01", period_end: "2027-01-01" });
      expect(three.r.invoice_no).toBe(two.r.invoice_no + 1);
      const [sub] =
        await ctx.sql`select anchor_date::text as anchor, price_cents from subscriptions where org_id = ${a.orgId}`;
      expect(sub).toMatchObject({ anchor: "2026-11-01", price_cents: 4900 });
      const audit =
        await ctx.sql`select after from audit_log where org_id = ${a.orgId} and action = 'billing.invoice_issued'`;
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toMatch(/IBAN|@/);
    }));

  it("refuses figures that do not add up, bad references and unknown businesses", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const call = (over: Figures) => () =>
        ctx.sql`select ops.billing_issue_invoice(${ctx.sql.json(figures(a.orgId, over))})`;
      await ctx.denied(call({ total_cents: 6028 }), BAD_VALUE.concat("23514"));
      await ctx.denied(call({ vat_cents: 1200, total_cents: 6100 }), BAD_VALUE);
      await ctx.denied(call({ vat_rate_bp: 20000 }), BAD_VALUE.concat("23514"));
      await ctx.denied(call({ payment_reference: "TF-AAAA-1126-A" }), BAD_VALUE);
      await ctx.denied(call({ payment_reference: "nonsense" }), BAD_VALUE);
      await ctx.denied(call({ period_end: "2026-11-01" }), ["23514"]);
      await ctx.denied(call({ org_id: randomUUID() }), BAD_VALUE);
      const none = await ctx.sql`select 1 from billing_invoices where org_id = ${a.orgId}`;
      expect(none).toHaveLength(0);
    }));

  it("a reference clash fails the whole call, so the number is not used up", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await subscription(ctx, a);
      await subscription(ctx, b);
      const first = await issue(ctx, a);
      await ctx.denied(
        () =>
          ctx.sql`select ops.billing_issue_invoice(${ctx.sql.json(
            figures(b.orgId, { payment_reference: first.f.payment_reference }),
          )})`,
        ["23505"],
      );
      const next = await issue(ctx, b);
      expect(next.r.invoice_no).toBe(first.r.invoice_no + 1);
    }));
});

describe("candidates, subscriptions and dunning", () => {
  it("creates a trial subscription once per business", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      const [first] = await ctx.sql`select ops.billing_ensure_subscriptions(14, 4900) as n`;
      expect(first!.n).toBeGreaterThanOrEqual(2);
      const [second] = await ctx.sql`select ops.billing_ensure_subscriptions(14, 4900) as n`;
      expect(second!.n).toBe(0);
      const [row] = await ctx.sql`
        select s.status, s.price_cents, o.trial_ends_at > now() as future
          from subscriptions s join organisations o on o.id = s.org_id where s.org_id = ${a.orgId}`;
      expect(row).toMatchObject({ status: "trial", price_cents: 4900, future: true });
    }));

  it("lists a business for invoicing only while nothing is unpaid, and not once paused or closed", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await subscription(ctx, a);
      await subscription(ctx, b);
      const ids = async () =>
        ((await ctx.sql`select ops.billing_candidates() as c`)[0]!.c as { org_id: string }[]).map(
          (c) => c.org_id,
        );
      expect(await ids()).toEqual(expect.arrayContaining([a.orgId, b.orgId]));
      await issue(ctx, a);
      expect(await ids()).not.toContain(a.orgId);
      await ctx.sql`update organisations set status = 'closed' where id = ${b.orgId}`;
      expect(await ids()).not.toContain(b.orgId);
    }));

  it("a reminder is claimed exactly once and can be handed back", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      const claim = async (n: number) =>
        (await ctx.sql`select ops.billing_reminder_claim(${r.id}, ${n}) as ok`)[0]!.ok;
      expect(await claim(1)).toBe(true);
      expect(await claim(1)).toBe(false);
      expect(await claim(2)).toBe(true);
      await ctx.sql`select ops.billing_reminder_release(${r.id}, 1)`;
      expect(await claim(1)).toBe(true);
      await ctx.denied(() => ctx.sql`select ops.billing_reminder_claim(${r.id}, 3)`, BAD_VALUE);
    }));

  it("pauses an unpaid business once, never deletes anything, and honours the hold", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      const pause = async (today: string) =>
        (await ctx.sql`select ops.billing_pause(${a.orgId}, ${r.id}, ${today}::date) as ok`)[0]!.ok;
      expect(await pause("2026-12-01")).toBe(true);
      expect(await pause("2026-12-01")).toBe(false); // already paused
      const [org] = await ctx.sql`select status from organisations where id = ${a.orgId}`;
      expect(org!.status).toBe("read_only");
      const [sub] =
        await ctx.sql`select status, paused_at is not null as p from subscriptions where org_id = ${a.orgId}`;
      expect(sub).toMatchObject({ status: "paused", p: true });
      const audit =
        await ctx.sql`select 1 from audit_log where org_id = ${a.orgId} and action = 'billing.paused'`;
      expect(audit).toHaveLength(1);
      const kept = await ctx.sql`select 1 from billing_invoices where id = ${r.id}`;
      expect(kept).toHaveLength(1);
    }));

  it("does not pause an invoice that has been paid", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      const admin = await makeAdmin(ctx);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_mark_paid(${r.id}, 'SEPA 777', current_date)`,
        AAL2,
      );
      const [row] =
        await ctx.sql`select ops.billing_pause(${a.orgId}, ${r.id}, '2027-01-01'::date) as ok`;
      expect(row!.ok).toBe(false);
    }));
});

describe("super-admin actions", () => {
  it("a normal owner, a manager, an aal1 admin and anon cannot call any admin function", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      const admin = await makeAdmin(ctx);
      const calls: [string, () => Promise<unknown>][] = [
        ["list", async () => ctx.sql`select public.admin_list_invoices('outstanding')`],
        [
          "mark",
          async () => ctx.sql`select public.admin_mark_paid(${r.id}, 'SEPA 123456', current_date)`,
        ],
        [
          "unpause",
          async () => ctx.sql`select public.admin_unpause(${a.orgId}, 'paid by phone', 7)`,
        ],
        [
          "match",
          async () => ctx.sql`select public.admin_match_references(array['TF-AAAA-1126-A'])`,
        ],
      ];
      for (const [, call] of calls) {
        await ctx.denied(() => ctx.as(a.owner, call, AAL2), NOT_ALLOWED);
        await ctx.denied(() => ctx.as(a.manager, call, AAL2), NOT_ALLOWED);
        await ctx.denied(() => ctx.as(admin, call, AAL1), NOT_ALLOWED);
        await ctx.denied(() => ctx.as(null, call), NOT_ALLOWED);
      }
      const [row] = await ctx.sql`select status from billing_invoices where id = ${r.id}`;
      expect(row!.status).toBe("issued");
    }));

  it("lists invoices by status", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await subscription(ctx, a);
      await subscription(ctx, b);
      const future = await issue(ctx, a, { due_on: "2099-01-01" });
      const late = await issue(ctx, b, { due_on: "2020-01-01" });
      const admin = await makeAdmin(ctx);
      const list = async (f: string) =>
        (
          (
            await ctx.as(admin, () => ctx.sql`select public.admin_list_invoices(${f}) as l`, AAL2)
          )[0]!.l as { id: string }[]
        ).map((x) => x.id);
      expect(await list("outstanding")).toContain(future.r.id);
      expect(await list("outstanding")).not.toContain(late.r.id);
      expect(await list("overdue")).toContain(late.r.id);
      expect(await list("overdue")).not.toContain(future.r.id);
      expect(await list("paid")).not.toContain(late.r.id);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_mark_paid(${late.r.id}, 'SEPA 555 666', current_date)`,
        AAL2,
      );
      expect(await list("paid")).toContain(late.r.id);
      expect(await list("overdue")).not.toContain(late.r.id);
      await ctx.denied(
        () => ctx.as(admin, () => ctx.sql`select public.admin_list_invoices('all')`, AAL2),
        BAD_VALUE,
      );
    }));

  it("marking paid needs a bank reference and a sensible date, works once, activates and unpauses, and is audited", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      await ctx.sql`select ops.billing_pause(${a.orgId}, ${r.id}, '2027-01-01'::date)`;
      const admin = await makeAdmin(ctx);
      const mark =
        (ref: string, on = "current_date") =>
        () =>
          ctx.as(
            admin,
            () => ctx.sql.unsafe(`select public.admin_mark_paid('${r.id}', $1, ${on})`, [ref]),
            AAL2,
          );
      await ctx.denied(mark(""), BAD_VALUE);
      await ctx.denied(mark("ab"), BAD_VALUE);
      await ctx.denied(mark("SEPA 1234", "current_date + 2"), BAD_VALUE);
      await ctx.denied(mark("SEPA 1234", "date '2000-01-01'"), BAD_VALUE);
      await mark("SEPA 123456")();
      const [inv] =
        await ctx.sql`select status, bank_reference, marked_paid_by, paid_on is not null as p from billing_invoices where id = ${r.id}`;
      expect(inv).toMatchObject({
        status: "paid",
        bank_reference: "SEPA 123456",
        marked_paid_by: admin.userId,
        p: true,
      });
      const [org] = await ctx.sql`select status from organisations where id = ${a.orgId}`;
      expect(org!.status).toBe("active");
      const [sub] =
        await ctx.sql`select status, period_start::text as s, paused_at from subscriptions where org_id = ${a.orgId}`;
      expect(sub).toMatchObject({ status: "active", s: "2026-11-01", paused_at: null });
      await ctx.denied(mark("SEPA 123456"), BAD_VALUE); // already paid
      const audit =
        await ctx.sql`select actor_user_id, after from audit_log where org_id = ${a.orgId} and action = 'billing.marked_paid'`;
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor_user_id).toBe(admin.userId);
      expect(JSON.stringify(audit[0]!.after)).not.toContain("SEPA");
    }));

  it("unpause needs a note, reopens the business, and the job does not re-pause it at once", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      await ctx.sql`select ops.billing_pause(${a.orgId}, ${r.id}, '2027-01-01'::date)`;
      const admin = await makeAdmin(ctx);
      const unpause =
        (note: string, days = 7) =>
        () =>
          ctx.as(
            admin,
            () => ctx.sql`select public.admin_unpause(${a.orgId}, ${note}, ${days})`,
            AAL2,
          );
      await ctx.denied(unpause(""), BAD_VALUE);
      await ctx.denied(unpause("ok"), BAD_VALUE);
      await ctx.denied(unpause("paid by phone", -1), BAD_VALUE);
      await unpause("customer paid by phone, will arrive Monday")();
      const [org] = await ctx.sql`select status from organisations where id = ${a.orgId}`;
      expect(org!.status).toBe("active");
      const [hold] =
        await ctx.sql`select ops.billing_pause(${a.orgId}, ${r.id}, current_date) as ok`;
      expect(hold!.ok).toBe(false); // held for 7 days
      const [later] =
        await ctx.sql`select ops.billing_pause(${a.orgId}, ${r.id}, current_date + 8) as ok`;
      expect(later!.ok).toBe(true);
      // Once the hold has run out the job pauses it again, and an unpause then works a second time.
      await unpause("paid at last, hold lifted", 0)();
      await ctx.sql`update organisations set status = 'active' where id = ${a.orgId}`;
      await ctx.denied(unpause("it is not paused any more"), BAD_VALUE);
      const audit =
        await ctx.sql`select after from audit_log where org_id = ${a.orgId} and action = 'billing.unpaused'`;
      expect(audit).toHaveLength(2);
    }));

  it("matches references to invoices and changes nothing", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r, f } = await issue(ctx, a);
      const admin = await makeAdmin(ctx);
      const [row] = await ctx.as(
        admin,
        () =>
          ctx.sql`select public.admin_match_references(${[f.payment_reference, "TF-AAAA-0126-A"]}) as m`,
        AAL2,
      );
      const m = row!.m as { reference: string; invoice_id: string; status: string }[];
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({
        reference: f.payment_reference,
        invoice_id: r.id,
        status: "issued",
      });
      const [inv] = await ctx.sql`select status from billing_invoices where id = ${r.id}`;
      expect(inv!.status).toBe("issued");
    }));
});

describe("read-only mode", () => {
  const pause = (ctx: Ctx, shop: Shop) =>
    ctx.sql`update organisations set status = 'read_only' where id = ${shop.orgId}`;

  it("refuses sales, refunds and shift opens and cash moves from a paused business, but not a Z close", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await pause(ctx, a);
      const when = new Date().toISOString();
      const sale = { sale: { org_id: a.orgId, completed_at: when } };
      const refund = { refund: { org_id: a.orgId, completed_at: when } };
      await ctx.denied(
        () => ctx.sql`select ops.record_sale(${ctx.sql.json(sale)}, ${a.tokenHash})`,
        PAUSED,
      );
      await ctx.denied(
        () => ctx.sql`select ops.record_refund(${ctx.sql.json(refund)}, ${a.tokenHash})`,
        PAUSED,
      );
      for (const kind of ["open", "cash"]) {
        const e = { kind, org_id: a.orgId, at: when };
        await ctx.denied(
          () => ctx.sql`select ops.record_shift_event(${a.tokenHash}, ${ctx.sql.json(e)})`,
          PAUSED,
        );
      }
      // A close gets past the pause check (it is then refused for its own reasons, not as paused).
      const close = { kind: "close", org_id: a.orgId, at: when };
      expect(
        await codeOf(() =>
          ctx.sql`savepoint s1`.then(
            () => ctx.sql`select ops.record_shift_event(${a.tokenHash}, ${ctx.sql.json(close)})`,
          ),
        ),
      ).not.toBe("TF004");
    }));

  it("tells the till whether its business is read-only, by device token only", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const state = async (hash: string) =>
        (await ctx.sql`select ops.device_billing_state(${hash}) as s`)[0]!.s as {
          read_only: boolean;
        } | null;
      expect(await state(a.tokenHash)).toEqual({ read_only: false });
      await pause(ctx, a);
      expect(await state(a.tokenHash)).toEqual({ read_only: true });
      expect(await state(b.tokenHash)).toEqual({ read_only: false }); // another shop is unaffected
      expect(await state("not-a-token")).toBeNull();
      await ctx.denied(
        () => ctx.as(a.owner, () => ctx.sql`select ops.device_billing_state(${a.tokenHash})`),
        NOT_ALLOWED,
      );
    }));

  it("still accepts a sale made before the pause when it syncs late, and refuses one made after", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      await ctx.sql`select ops.billing_pause(${a.orgId}, ${r.id}, '2027-01-01'::date)`;
      const before = new Date(Date.now() - 3_600_000).toISOString();
      const after = new Date(Date.now() + 60_000).toISOString();
      const mk = (at: string) => ({ sale: { org_id: a.orgId, completed_at: at } });
      await ctx.sql`savepoint early`;
      const early = await codeOf(
        () => ctx.sql`select ops.record_sale(${ctx.sql.json(mk(before))}, ${a.tokenHash})`,
      );
      expect(early).not.toBe("TF004"); // it reached the real function, which refuses the empty sale
      await ctx.sql`rollback to savepoint early`;
      await ctx.denied(
        () => ctx.sql`select ops.record_sale(${ctx.sql.json(mk(after))}, ${a.tokenHash})`,
        PAUSED,
      );
    }));

  it("refuses back-office writes to the catalogue and stock, but reads and exports still work", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      const cat = (n: string) => () =>
        ctx.as(
          a.manager,
          () =>
            ctx.sql`insert into categories (id, org_id, name) values (${randomUUID()}, ${a.orgId}, ${n})`,
        );
      await cat("Before pause")();
      await pause(ctx, a);
      await ctx.denied(cat("During pause"), NOT_ALLOWED);
      await ctx.denied(
        () =>
          ctx
            .as(
              a.manager,
              () => ctx.sql`update categories set name = 'Renamed' where org_id = ${a.orgId}`,
            )
            .then((rows) => {
              if (rows.count === 0) throw Object.assign(new Error("no rows"), { code: "42501" });
            }),
        NOT_ALLOWED,
      );
      const rows = await ctx.as(
        a.owner,
        () => ctx.sql`select name from categories where org_id = ${a.orgId}`,
      );
      expect(rows.map((r) => r.name)).toContain("Before pause");
      // The whole-account export stays available to the owner (data is never locked in).
      const fresh = {
        aal: "aal2" as const,
        amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
      };
      await ctx.as(
        a.owner,
        () => ctx.sql`select public.request_account_export(${a.orgId}, ${randomUUID()})`,
        fresh,
      );
    }));

  it("refuses customer saves and import confirmation, and a closed business too", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await pause(ctx, a);
      const save = () =>
        ctx.as(
          a.owner,
          () =>
            ctx.sql`select public.save_customer(${a.orgId}, ${randomUUID()}, ${ctx.sql.json({ name: "Ann" })})`,
        );
      await ctx.denied(save, PAUSED);
      await ctx.denied(
        () =>
          ctx.as(
            a.owner,
            () =>
              ctx.sql`select public.confirm_import(${a.orgId}, ${randomUUID()}, 'create', 'sku', ${ctx.sql.json({})})`,
          ),
        PAUSED,
      );
      // The inner functions are not callable around the check.
      await ctx.denied(
        () =>
          ctx.as(
            a.owner,
            () =>
              ctx.sql`select public.save_customer_billing(${a.orgId}, ${randomUUID()}, ${ctx.sql.json({ name: "Ann" })})`,
          ),
        NOT_ALLOWED,
      );
      await ctx.sql`update organisations set status = 'closed' where id = ${a.orgId}`;
      await ctx.denied(save, PAUSED);
      // Unpaused again: the check no longer stands in the way.
      await ctx.sql`update organisations set status = 'active' where id = ${a.orgId}`;
      expect(await codeOf(() => ctx.sql`savepoint x`.then(save))).not.toBe("TF004");
    }));
});

describe("invoice numbering under concurrency", () => {
  it("20 parallel invoices for 20 businesses get 20 consecutive numbers, none twice", async () => {
    const orgs = Array.from({ length: 20 }, () => randomUUID());
    for (const id of orgs) {
      await sql`insert into organisations (id, name, business_type) values (${id}, 'Concurrency test', 'general')`;
      await sql`insert into subscriptions (id, org_id, status, price_cents) values (${randomUUID()}, ${id}, 'trial', 4900)`;
    }
    const results = await Promise.all(
      orgs.map(async (id) => {
        const f = figures(id);
        const [row] = await sql`select ops.billing_issue_invoice(${sql.json(f)}) as r`;
        return (row!.r as { invoice_no: number }).invoice_no;
      }),
    );
    const sorted = [...results].sort((x, y) => x - y);
    expect(new Set(results).size).toBe(20);
    expect(sorted[19]! - sorted[0]!).toBe(19); // no gap between the first and the last
  });

  it("the same business and period issued 20 times at once gives exactly one invoice", async () => {
    const org = randomUUID();
    await sql`insert into organisations (id, name, business_type) values (${org}, 'Same period test', 'general')`;
    await sql`insert into subscriptions (id, org_id, status, price_cents) values (${randomUUID()}, ${org}, 'trial', 4900)`;
    const before = (await sql`select last_no from billing_counters where name = 'invoice'`)[0]!
      .last_no as number;
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const [row] = await sql`select ops.billing_issue_invoice(${sql.json(figures(org))}) as r`;
        return row!.r as { created: boolean; invoice_no: number };
      }),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.invoice_no)).size).toBe(1);
    const rows = await sql`select 1 from billing_invoices where org_id = ${org}`;
    expect(rows).toHaveLength(1);
    expect(results[0]!.invoice_no).toBeGreaterThan(before);
  });

  it("a failed call leaves no hole in the numbers", async () => {
    const org = randomUUID();
    await sql`insert into organisations (id, name, business_type) values (${org}, 'Hole test', 'general')`;
    await sql`insert into subscriptions (id, org_id, status, price_cents) values (${randomUUID()}, ${org}, 'trial', 4900)`;
    const ok = async (over: Figures = {}) =>
      (await sql`select ops.billing_issue_invoice(${sql.json(figures(org, over))}) as r`)[0]!.r as {
        invoice_no: number;
      };
    const first = await ok();
    await expect(
      ok({ period_start: "2026-12-01", period_end: "2027-01-01", total_cents: 1 }),
    ).rejects.toThrow();
    const second = await ok({ period_start: "2027-01-01", period_end: "2027-02-01" });
    expect(second.invoice_no).toBeGreaterThan(first.invoice_no);
    const nos = (
      await sql`select invoice_no from billing_invoices where invoice_no between ${first.invoice_no} and ${second.invoice_no} order by 1`
    ).map((r) => r.invoice_no as number);
    // Everything between the two numbers belongs to some invoice: nothing was skipped.
    expect(nos).toHaveLength(second.invoice_no - first.invoice_no + 1);
  });
});

describe("what an invoice keeps, and what owners may read of it", () => {
  it("keeps supplier and customer as they were; later changes to the business do not touch it", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      await ctx.sql`update organisations set legal_name = 'Shop A Ltd', vat_number = 'IE6388047V' where id = ${a.orgId}`;
      await ctx.sql`update locations set address = '5 High Street, Cork' where id = ${a.locationId}`;
      const { r } = await issue(ctx, a);
      await ctx.sql`update organisations set legal_name = 'Renamed Ltd' where id = ${a.orgId}`;
      const [inv] =
        await ctx.sql`select supplier_name, supplier_vat_number, customer_name, customer_address, customer_vat_number
                                    from billing_invoices where id = ${r.id}`;
      expect(inv).toMatchObject({
        supplier_name: "Tillflow Ltd",
        supplier_vat_number: "IE1234567FA",
        customer_name: "Shop A Ltd",
        customer_address: "5 High Street, Cork",
        customer_vat_number: "IE6388047V",
      });
      await ctx.denied(
        () =>
          ctx.sql`update billing_invoices set customer_name = 'Someone else' where id = ${r.id}`,
        NOT_ALLOWED,
      );
      await ctx.denied(
        () =>
          ctx.sql`update billing_invoices set supplier_vat_number = 'IE0000000XX' where id = ${r.id}`,
        NOT_ALLOWED,
      );
    }));

  it("refuses an invoice without supplier details", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      await ctx.denied(
        () =>
          ctx.sql`select ops.billing_issue_invoice(${ctx.sql.json(figures(a.orgId, { supplier_vat_number: " " }))})`,
        BAD_VALUE,
      );
    }));

  it("owners can read the invoice but not the bank statement text, the admin who marked it, or email stamps", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      const admin = await makeAdmin(ctx);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_mark_paid(${r.id}, 'PAYER NAME IE29 1234', current_date)`,
        AAL2,
      );
      const rows = await ctx.as(
        a.owner,
        () =>
          ctx.sql`select payment_reference, status, customer_name, paid_on from billing_invoices`,
      );
      expect(rows).toHaveLength(1);
      for (const col of ["bank_reference", "marked_paid_by", "emailed_at", "reminder_1_sent_at"]) {
        await ctx.denied(
          () => ctx.as(a.owner, () => ctx.sql.unsafe(`select ${col} from billing_invoices`)),
          NOT_ALLOWED,
        );
      }
      await ctx.denied(
        () => ctx.as(a.owner, () => ctx.sql`select * from billing_invoices`),
        NOT_ALLOWED,
      );
    }));
});

describe("VAT on an invoice is exactly half-up", () => {
  it("accepts the half-up value and refuses anything else, including the round-down at a tie", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const at = (vat: number, start: string) => () =>
        ctx.sql`select ops.billing_issue_invoice(${ctx.sql.json(
          figures(a.orgId, {
            amount_ex_vat_cents: 2,
            vat_rate_bp: 2500,
            vat_cents: vat,
            total_cents: 2 + vat,
            period_start: start,
            period_end: "2027-12-01",
          }),
        )})`;
      await ctx.denied(at(0, "2027-01-01"), BAD_VALUE); // 0.5c must round UP
      await ctx.denied(at(2, "2027-02-01"), BAD_VALUE);
      await at(1, "2027-03-01")();
    }));
});

describe("read-only mode, harder cases", () => {
  it("a sale back-dated to before the pause is not accepted once the pause is older than 3 days", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      await ctx.sql`select ops.billing_pause(${a.orgId}, ${r.id}, '2027-01-01'::date)`;
      await ctx.sql`update subscriptions set paused_at = now() - interval '4 days' where org_id = ${a.orgId}`;
      const sale = {
        sale: {
          org_id: a.orgId,
          completed_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        },
      };
      await ctx.denied(
        () => ctx.sql`select ops.record_sale(${ctx.sql.json(sale)}, ${a.tokenHash})`,
        PAUSED,
      );
    }));

  it("deleting catalogue rows is refused too (the row stays)", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = randomUUID();
      await ctx.sql`insert into categories (id, org_id, name) values (${id}, ${a.orgId}, 'Keep me')`;
      await ctx.sql`update organisations set status = 'read_only' where id = ${a.orgId}`;
      await ctx.as(a.owner, () => ctx.sql`delete from categories where id = ${id}`);
      const [row] = await ctx.sql`select count(*)::int as n from categories where id = ${id}`;
      expect(row!.n).toBe(1);
    }));

  it("the inner functions behind the wrappers are closed to the jobs role", () =>
    inWorld(async (ctx) => {
      const [row] = await ctx.sql`
        select has_function_privilege('tillflow_ops', 'ops.record_sale_billing(jsonb, text)', 'execute') as sale,
               has_function_privilege('tillflow_ops', 'ops.record_refund_billing(jsonb, text)', 'execute') as refund,
               has_function_privilege('tillflow_ops', 'ops.record_shift_event_billing(text, jsonb)', 'execute') as shift,
               has_function_privilege('tillflow_ops', 'ops.record_sale(jsonb, text)', 'execute') as outer`;
      expect(row).toEqual({ sale: false, refund: false, shift: false, outer: true });
    }));
});

describe("the pause gate follows the device token, not the payload", () => {
  it("a paused business's till cannot dodge the gate by naming another business in the payload", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await ctx.sql`update organisations set status = 'read_only' where id = ${a.orgId}`;
      const now = new Date().toISOString();
      const sale = { sale: { org_id: b.orgId, completed_at: now } };
      const refund = { refund: { org_id: b.orgId, completed_at: now } };
      const shift = { kind: "open", org_id: b.orgId, at: now };
      await ctx.denied(
        () => ctx.sql`select ops.record_sale(${ctx.sql.json(sale)}, ${a.tokenHash})`,
        PAUSED,
      );
      await ctx.denied(
        () => ctx.sql`select ops.record_refund(${ctx.sql.json(refund)}, ${a.tokenHash})`,
        PAUSED,
      );
      await ctx.denied(
        () => ctx.sql`select ops.record_shift_event(${a.tokenHash}, ${ctx.sql.json(shift)})`,
        PAUSED,
      );
    }));
});

describe("paused months are not billed (owner decision 2026-10-17)", () => {
  it("paying while paused records the reopening day; paying while open does not", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await subscription(ctx, a);
      await subscription(ctx, b);
      const ia = await issue(ctx, a);
      const ib = await issue(ctx, b);
      await ctx.sql`select ops.billing_pause(${a.orgId}, ${ia.r.id}, '2027-01-01'::date)`;
      const admin = await makeAdmin(ctx);
      const pay = (id: string) =>
        ctx.as(
          admin,
          () => ctx.sql`select public.admin_mark_paid(${id}, 'SEPA 999001', current_date)`,
          AAL2,
        );
      await pay(ia.r.id);
      await pay(ib.r.id);
      const [sa] =
        await ctx.sql`select resumed_on is not null as set from subscriptions where org_id = ${a.orgId}`;
      const [sb] =
        await ctx.sql`select resumed_on is not null as set from subscriptions where org_id = ${b.orgId}`;
      expect(sa!.set).toBe(true);
      expect(sb!.set).toBe(false);
    }));

  it("an unpause also records the day, and the first invoice after it re-anchors the cycle and clears it", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const first = await issue(ctx, a);
      await ctx.sql`select ops.billing_pause(${a.orgId}, ${first.r.id}, '2027-01-01'::date)`;
      const admin = await makeAdmin(ctx);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_unpause(${a.orgId}, 'agreed with owner', 0)`,
        AAL2,
      );
      const [s1] =
        await ctx.sql`select resumed_on::text as r, anchor_date::text as a from subscriptions where org_id = ${a.orgId}`;
      expect(s1!.r).not.toBeNull();
      // the unpaid invoice still blocks a new one; once it is paid the job is told the reopening day
      const [none] = await ctx.sql`select ops.billing_candidates() as c`;
      expect(none!.c as unknown[]).toHaveLength(0);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_mark_paid(${first.r.id}, 'SEPA 777', current_date)`,
        AAL2,
      );
      const [c] = await ctx.sql`select ops.billing_candidates() as c`;
      expect((c!.c as { resumed_on: string | null }[])[0]!.resumed_on).toBe(s1!.r);
    }));

  it("an invoice that starts on the reopening day becomes the new anchor", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      await issue(ctx, a);
      await ctx.sql`update billing_invoices set status = 'paid', paid_at = now(), paid_on = current_date,
                      bank_reference = 'SEPA 1', marked_paid_by = ${randomUUID()} where org_id = ${a.orgId}`;
      await ctx.sql`update subscriptions set resumed_on = '2027-03-10' where org_id = ${a.orgId}`;
      const [c] = await ctx.sql`select ops.billing_candidates() as c`;
      expect((c!.c as { resumed_on: string }[])[0]!.resumed_on).toBe("2027-03-10");
      await issue(ctx, a, {
        period_start: "2027-03-10",
        period_end: "2027-04-10",
        payment_reference: makeReference("0327"),
      });
      const [s] =
        await ctx.sql`select resumed_on, anchor_date::text as a from subscriptions where org_id = ${a.orgId}`;
      expect(s).toMatchObject({ resumed_on: null, a: "2027-03-10" });
    }));
});

describe("read-only mode also covers settings, floor plan, pairing and staff", () => {
  const pause = (ctx: Ctx, shop: Shop) =>
    ctx.sql`update organisations set status = 'read_only' where id = ${shop.orgId}`;

  it("refuses limits, service charge, floor plan, tender types, new pairing codes and new till staff", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await pause(ctx, a);
      const as = (fn: () => PromiseLike<unknown>) => () =>
        ctx.as(a.owner, async () => {
          await fn();
        });
      await ctx.denied(
        as(() => ctx.sql`select public.save_floor_plan(${a.orgId}, '[]'::jsonb)`),
        PAUSED,
      );
      await ctx.denied(
        as(() => ctx.sql`select public.set_service_charge(${a.orgId}, 500, ${randomUUID()})`),
        PAUSED,
      );
      await ctx.denied(
        as(() => ctx.sql`select public.set_discount_override(${a.orgId}, 500, ${randomUUID()})`),
        PAUSED,
      );
      await ctx.denied(
        as(() => ctx.sql`select public.set_refund_override(${a.orgId}, 500, ${randomUUID()})`),
        PAUSED,
      );
      await ctx.denied(
        as(
          () =>
            ctx.sql`select public.create_pairing_code(${a.registerId}, ${"f".repeat(64)}, ${randomUUID()})`,
        ),
        PAUSED,
      );
      await ctx.denied(
        as(
          () =>
            ctx.sql`select public.add_till_staff(${a.orgId}, ${randomUUID()}, 'Sam', ${"x"}, ${randomUUID()})`,
        ),
        PAUSED,
      );
      await ctx.denied(
        as(
          () =>
            ctx.sql`insert into tender_types (id, org_id, location_id, method, label, sort)
                    values (${randomUUID()}, ${a.orgId}, ${a.locationId}, 'card', 'Other card', 9)`,
        ),
        ["42501"],
      );
    }));

  it("refuses tab events and customer creation from a paused business's till", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await pause(ctx, a);
      await ctx.denied(
        () => ctx.sql`select ops.record_tab_event(${a.tokenHash}, '{}'::jsonb)`,
        PAUSED,
      );
      await ctx.denied(
        () => ctx.sql`select ops.device_customer_create(${a.tokenHash}, '{}'::jsonb)`,
        PAUSED,
      );
      // an unknown token is not "paused": the inner function's own answer comes through
      expect(
        await codeOf(() => ctx.sql`select ops.record_tab_event(${"0".repeat(64)}, '{}'::jsonb)`),
      ).not.toBe("TF004");
    }));

  it("while paused, revoking a till and PIN changes are for owners; a manager is refused", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await pause(ctx, a);
      const [m] =
        await ctx.sql`select id from memberships where org_id = ${a.orgId} and user_id = ${a.cashier.userId}`;
      const revoke = (who: Actor) => () =>
        ctx.as(who, () => ctx.sql`select public.revoke_register(${a.registerId}, ${randomUUID()})`);
      await ctx.denied(revoke(a.manager), PAUSED);
      await ctx.denied(
        () =>
          ctx.as(
            a.manager,
            () => ctx.sql`select public.reset_member_pin(${m!.id}, ${randomUUID()})`,
          ),
        PAUSED,
      );
      // an owner gets past the pause check (any later refusal is for another reason)
      expect(await codeOf(revoke(a.owner))).not.toBe("TF004");
    }));

  it("the inner functions behind these wrappers are closed to clients and the jobs role", () =>
    inWorld(async (ctx) => {
      const names = [
        "public.save_floor_plan_billing(uuid, jsonb)",
        "public.set_service_charge_billing(uuid, integer, uuid)",
        "public.set_discount_override_billing(uuid, integer, uuid)",
        "public.set_refund_override_billing(uuid, integer, uuid)",
        "public.add_till_staff_billing(uuid, uuid, text, text, uuid)",
        "public.create_pairing_code_billing(uuid, text, uuid)",
        "public.revoke_register_billing(uuid, uuid)",
        "public.set_member_pin_billing(uuid, text, uuid)",
        "public.remove_till_staff_billing(uuid, uuid)",
        "public.reset_member_pin_billing(uuid, uuid)",
        "ops.record_tab_event_billing(text, jsonb)",
        "ops.device_customer_create_billing(text, jsonb)",
      ];
      for (const fn of names) {
        for (const role of ["anon", "authenticated", "tillflow_ops"]) {
          const [row] =
            await ctx.sql`select has_function_privilege(${role}, ${fn}, 'execute') as ok`;
          expect(row!.ok, `${role} ${fn}`).toBe(false);
        }
      }
    }));
});

describe("no way around the paused check", () => {
  it("the older inner functions are closed to every role but their owner", () =>
    inWorld(async (ctx) => {
      const fns = [
        "ops.record_sale_core(jsonb, text)",
        "ops.record_refund_core(jsonb, text)",
        "ops.record_sale_shifted(jsonb, text)",
        "ops.record_sale_customer(jsonb, text)",
        "public.save_customer_billing(uuid, uuid, jsonb)",
        "public.confirm_import_billing(uuid, uuid, text, text, jsonb)",
        "public.save_floor_plan_billing(uuid, jsonb)",
      ];
      for (const fn of fns)
        for (const role of ["anon", "authenticated", "service_role", "tillflow_ops"]) {
          const [row] =
            await ctx.sql`select has_function_privilege(${role}, ${fn}, 'execute') as ok`;
          expect(row!.ok, `${role} ${fn}`).toBe(false);
        }
    }));

  it("a payment that lands first is not undone by a pause that was waiting", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const { r } = await issue(ctx, a);
      await ctx.sql`update billing_invoices set status = 'paid', paid_at = now(), paid_on = current_date,
                      bank_reference = 'SEPA 5', marked_paid_by = ${randomUUID()} where id = ${r.id}`;
      const [p] =
        await ctx.sql`select ops.billing_pause(${a.orgId}, ${r.id}, '2099-01-01'::date) as paused`;
      expect(p!.paused).toBe(false);
    }));
});

describe("a stranger cannot learn that a business is paused", () => {
  it("another shop's owner gets a plain refusal, the business's own owner gets the paused answer", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await ctx.sql`update organisations set status = 'read_only' where id = ${a.orgId}`;
      const call = (who: Actor) => () =>
        ctx.as(who, async () => {
          await ctx.sql`select public.set_service_charge(${a.orgId}, 500, ${randomUUID()})`;
        });
      await ctx.denied(call(b.owner), NOT_ALLOWED);
      await ctx.denied(call(a.owner), PAUSED);
    }));
});

describe("admin edge cases", () => {
  it("a missing filter is refused, and unpausing an unknown business is refused", () =>
    inWorld(async (ctx) => {
      const admin = await makeAdmin(ctx);
      await ctx.denied(
        () => ctx.as(admin, () => ctx.sql`select public.admin_list_invoices(null)`, AAL2),
        BAD_VALUE,
      );
      await ctx.denied(
        () =>
          ctx.as(
            admin,
            () => ctx.sql`select public.admin_unpause(${randomUUID()}, 'no such shop', 0)`,
            AAL2,
          ),
        BAD_VALUE,
      );
    }));
});

describe("paused: locations, registers and import undo", () => {
  it("refuses direct location and register changes and undoing an import; an owner may still remove a till", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await ctx.sql`update organisations set status = 'read_only' where id = ${a.orgId}`;
      const own = (fn: () => PromiseLike<unknown>) => () =>
        ctx.as(a.owner, async () => {
          await fn();
        });
      const [before] = await ctx.sql`select name from locations where id = ${a.locationId}`;
      await ctx.as(
        a.owner,
        () => ctx.sql`update locations set name = 'Renamed' where id = ${a.locationId}`,
      );
      const [after] = await ctx.sql`select name from locations where id = ${a.locationId}`;
      expect(after!.name).toBe(before!.name); // update matched 0 rows
      await ctx.denied(
        own(
          () =>
            ctx.sql`insert into registers (id, org_id, location_id, name)
                    values (${randomUUID()}, ${a.orgId}, ${a.locationId}, 'Till 9')`,
        ),
        ["42501"],
      );
      await ctx.denied(
        own(() => ctx.sql`select public.undo_import(${a.orgId}, ${randomUUID()})`),
        PAUSED,
      );
      const [inner] =
        await ctx.sql`select has_function_privilege('authenticated', 'public.undo_import_billing(uuid, uuid)', 'execute') as ok`;
      expect(inner!.ok).toBe(false);
    }));
});
