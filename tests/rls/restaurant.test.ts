// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { seedProduct } from "./catalog-helpers";
import { inWorld, sql, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);

const table = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  name: "T1",
  seats: 4,
  shape: "square",
  x: 0,
  y: 0,
  w: 2,
  h: 2,
  ...over,
});
const plan = (tables: unknown[], floorId: string = randomUUID()) => [
  { id: floorId, name: "Ground", sort: 0, tables },
];
const savePlan = (ctx: Ctx, actor: Shop["owner"] | null, org: string, p: unknown) =>
  ctx.as(actor, () => ctx.sql`select public.save_floor_plan(${org}, ${json(ctx, p)})`);

const event = (shop: Shop, over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  tab_id: randomUUID(),
  kind: "open",
  cashier_user_id: shop.cashier.userId,
  at: new Date().toISOString(),
  detail: { table: "T1", covers: 4 },
  ...over,
});
const record = (ctx: Ctx, token: string, e: unknown) =>
  ctx.sql`select ops.record_tab_event(${token}, ${json(ctx, e)}) as r`;
const meta = async (ctx: Ctx, token: string) =>
  (await ctx.sql`select ops.device_restaurant_meta(${token}) as m`)[0]!.m as {
    floors: unknown[];
    tables: { name: string }[];
  };

describe("floor plan", () => {
  it("managers and owners save a plan; tills and staff read it; archived tables vanish", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const t1 = table();
      const t2 = table({ name: "T2", x: 3 });
      const floor = randomUUID();
      await savePlan(ctx, a.manager, a.orgId, plan([t1, t2], floor));
      const m = await meta(ctx, a.tokenHash);
      expect(m.floors).toHaveLength(1);
      expect(m.tables.map((t) => t.name)).toEqual(["T1", "T2"]);
      // dropping T2 archives it (the row stays)
      await savePlan(ctx, a.owner, a.orgId, plan([t1], floor));
      expect((await meta(ctx, a.tokenHash)).tables.map((t) => t.name)).toEqual(["T1"]);
      expect(
        (
          await ctx.sql`select archived_at is not null as gone from restaurant_tables where id = ${t2.id}`
        )[0]!.gone,
      ).toBe(true);
      // staff of the shop read it; a name freed by archiving can be reused
      const n = await ctx.as(
        a.cashier,
        async () =>
          (
            await ctx.sql`select count(*)::int as n from restaurant_tables where org_id = ${a.orgId}`
          )[0]!.n as number,
      );
      expect(n).toBe(2);
      await savePlan(ctx, a.manager, a.orgId, plan([t1, table({ name: "T2", x: 3 })], floor));
    }));

  it("refuses overlap, duplicate live names and out-of-range values", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      await ctx.denied(
        () => savePlan(ctx, a.manager, a.orgId, plan([table(), table({ name: "T2", x: 1 })])),
        ["22023"],
      );
      await ctx.denied(
        () => savePlan(ctx, a.manager, a.orgId, plan([table(), table({ x: 4 })])),
        ["23505"],
      );
      for (const bad of [
        { seats: 0 },
        { seats: 31 },
        { shape: "star" },
        { w: 9 },
        { x: 60 },
        { name: " " },
      ]) {
        await ctx.denied(() => savePlan(ctx, a.manager, a.orgId, plan([table(bad)])), ["23514"]);
      }
    }));

  it("cashiers, anon and Shop B cannot change Shop A's plan or reuse its ids", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const t = table();
      const floor = randomUUID();
      await savePlan(ctx, a.manager, a.orgId, plan([t], floor));
      await ctx.denied(() => savePlan(ctx, a.cashier, a.orgId, plan([table()])));
      await ctx.denied(() => savePlan(ctx, null, a.orgId, plan([table()])));
      await ctx.denied(() => savePlan(ctx, b.owner, a.orgId, plan([table()])));
      // B naming its own org with A's ids must not touch A's rows
      await ctx.denied(() => savePlan(ctx, b.manager, b.orgId, plan([t], floor)), ["23505"]);
      expect((await ctx.sql`select name from restaurant_tables where id = ${t.id}`)[0]!.name).toBe(
        "T1",
      );
      // B cannot read A's tables; clients cannot delete, and a cashier cannot update
      const seen = await ctx.as(
        b.owner,
        async () =>
          (
            await ctx.sql`select count(*)::int as n from restaurant_tables where org_id = ${a.orgId}`
          )[0]!.n as number,
      );
      expect(seen).toBe(0);
      await ctx.denied(() =>
        ctx.as(a.manager, () => ctx.sql`delete from restaurant_tables where id = ${t.id}`),
      );
      await ctx.denied(() =>
        ctx.as(a.cashier, () => ctx.sql`update restaurant_tables set seats = 9 where id = ${t.id}`),
      );
      // a till of Shop B sees none of A's plan
      expect((await meta(ctx, b.tokenHash)).tables).toHaveLength(0);
    }));
});

describe("service charge setting", () => {
  it("only the owner sets it, within 0 to 25%, and it is audit-logged", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const set = (actor: Shop["owner"] | null, bp: number) =>
        ctx.as(
          actor,
          () => ctx.sql`select public.set_service_charge(${a.orgId}, ${bp}, ${randomUUID()})`,
        );
      await set(a.owner, 1250);
      expect(
        (await ctx.sql`select service_charge_bp as bp from organisations where id = ${a.orgId}`)[0]!
          .bp,
      ).toBe(1250);
      expect(
        (
          await ctx.sql`select count(*)::int as n from audit_log where org_id = ${a.orgId} and action = 'organisation.service_charge_changed'`
        )[0]!.n,
      ).toBe(1);
      await ctx.denied(() => set(a.manager, 500));
      await ctx.denied(() => set(a.cashier, 500));
      await ctx.denied(() => set(null, 500));
      await ctx.denied(() => set(a.owner, 2501), ["22023"]);
      await ctx.denied(() => set(ctx.world.b.owner, 500));
      // not writable directly
      await ctx.denied(() =>
        ctx.as(
          a.owner,
          () => ctx.sql`update organisations set service_charge_bp = 0 where id = ${a.orgId}`,
        ),
      );
    }));
});

describe("tab events", () => {
  it("records once, acknowledges a replay and keeps only allow-listed facts", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const e = event(a, {
        detail: {
          table: "T1",
          covers: 4,
          card_number: "4242424242424242",
          note: "allergic to nuts",
        },
      });
      expect((await record(ctx, a.tokenHash, e))[0]!.r).toBe("recorded");
      expect((await record(ctx, a.tokenHash, e))[0]!.r).toBe("duplicate");
      const [row] = await ctx.sql`select detail, register_id from tab_events where id = ${e.id}`;
      // "T1" is not a table of this shop yet, so the name is dropped; covers stay.
      expect(row!.detail).toEqual({ covers: 4 });
      expect(row!.register_id).toBe(a.registerId);
      expect(
        (await ctx.sql`select count(*)::int as n from tab_events where id = ${e.id}`)[0]!.n,
      ).toBe(1);
    }));

  it("keeps a table name only when it is a real table, and allows one open per tab", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      await savePlan(ctx, a.manager, a.orgId, plan([table({ name: "T1" })]));
      const e = event(a, { detail: { table: "t1", from: "Mary 087 123", covers: 4 } });
      await record(ctx, a.tokenHash, e);
      expect((await ctx.sql`select detail from tab_events where id = ${e.id}`)[0]!.detail).toEqual({
        table: "t1",
        covers: 4,
      });
      await ctx.denied(() => record(ctx, a.tokenHash, event(a, { tab_id: e.tab_id })), ["23505"]);
      await ctx.denied(
        () => record(ctx, a.tokenHash, event(a, { detail: { covers: 31 } })),
        ["22023"],
      );
      await ctx.denied(() => savePlan(ctx, a.manager, a.orgId, null), ["22023"]);
    }));

  it("refuses unknown kinds, strangers, bad times, bad numbers and another shop's id", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await ctx.denied(() => record(ctx, a.tokenHash, event(a, { kind: "delete" })), ["22023"]);
      await ctx.denied(
        () => record(ctx, a.tokenHash, event(a, { cashier_user_id: b.cashier.userId })),
        ["42501"],
      );
      await ctx.denied(
        () => record(ctx, a.tokenHash, event(a, { at: "2020-01-01T00:00:00Z" })),
        ["22023"],
      );
      await ctx.denied(
        () =>
          record(
            ctx,
            a.tokenHash,
            event(a, { at: new Date(Date.now() + 3_600_000).toISOString() }),
          ),
        ["22023"],
      );
      await ctx.denied(
        () => record(ctx, a.tokenHash, event(a, { detail: { covers: 5000 } })),
        ["22023"],
      );
      await ctx.denied(() => record(ctx, "f".repeat(64), event(a)), ["42501"]);
      const e = event(a);
      await record(ctx, a.tokenHash, e);
      // Shop B's till reusing Shop A's event id gets a clash, and Shop A's row stays A's
      await ctx.denied(
        () => record(ctx, b.tokenHash, { ...e, cashier_user_id: b.cashier.userId }),
        ["23505"],
      );
      expect((await ctx.sql`select org_id from tab_events where id = ${e.id}`)[0]!.org_id).toBe(
        a.orgId,
      );
    }));

  it("is append-only and readable only by managers and owners of the shop", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const e = event(a);
      await record(ctx, a.tokenHash, e);
      await ctx.denied(() => ctx.sql`update tab_events set kind = 'void' where id = ${e.id}`);
      await ctx.denied(() => ctx.sql`delete from tab_events where id = ${e.id}`);
      await ctx.denied(() => ctx.sql`truncate tab_events`);
      const count = (actor: Shop["owner"] | null) =>
        ctx.as(
          actor,
          async () =>
            (await ctx.sql`select count(*)::int as n from tab_events where id = ${e.id}`)[0]!
              .n as number,
        );
      expect(await count(a.owner)).toBe(1);
      expect(await count(a.manager)).toBe(1);
      expect(await count(a.cashier)).toBe(0);
      expect(await count(b.owner)).toBe(0);
      for (const actor of [a.owner, a.cashier, null]) {
        await ctx.denied(() =>
          ctx.as(
            actor,
            () => ctx.sql`insert into tab_events (id, org_id, tab_id, register_id, kind, cashier_user_id, at)
            values (${randomUUID()}, ${a.orgId}, ${randomUUID()}, ${a.registerId}, 'open', ${a.cashier.userId}, now())`,
          ),
        );
      }
      await ctx.denied(() =>
        ctx.as(a.owner, () => ctx.sql`select ops.record_tab_event(${a.tokenHash}, '{}'::jsonb)`),
      );
    }));
});

describe("a bill paid from a tab", () => {
  const sell = async (
    ctx: Ctx,
    shop: Shop,
    tabId: string | null,
    over: { lines?: unknown[] } = {},
  ) => {
    const { pid, vid } = await seedProduct(ctx, shop.orgId, `sku-${randomUUID().slice(0, 6)}`);
    const cash = (
      await ctx.sql`select id from tender_types where location_id = ${shop.locationId} and method = 'cash'`
    )[0]!.id as string;
    const id = randomUUID();
    // 3.50 tea at 23% plus a 12.5% service charge: 0.44 at 23% (net 36, VAT 8)
    const p = {
      tab_id: tabId,
      sale: {
        id,
        org_id: shop.orgId,
        register_id: shop.registerId,
        user_id: shop.cashier.userId,
        receipt_seq: 1,
        mode: "eat_in",
        completed_at: new Date().toISOString(),
        priced_as_of: new Date().toISOString(),
        items_total: 394,
        vat: 73,
        non_vat: 0,
        cash_rounding: 0,
        amount_due: 394,
        client_due: 394,
        client_vat: 73,
        review_flags: ["service_differs"],
      },
      lines: over.lines ?? [
        {
          kind: "item",
          variant_id: vid,
          product_id: pid,
          name: "Tea",
          qty: 1,
          unit_price_cents: 350,
          modifiers: [],
          discount_cents: 0,
          tax_category: "STANDARD",
          tax_rate_bp: 2300,
          net_cents: 285,
          vat_cents: 65,
          gross_cents: 350,
        },
        {
          kind: "item",
          variant_id: null,
          product_id: null,
          name: "Service charge 12.5%",
          qty: 1,
          unit_price_cents: 44,
          modifiers: [],
          discount_cents: 0,
          tax_category: "STANDARD",
          tax_rate_bp: 2300,
          net_cents: 36,
          vat_cents: 8,
          gross_cents: 44,
        },
      ],
      payments: [{ type_id: cash, method: "cash", amount: 394, tendered: 400, change: 6 }],
    };
    const r = (await ctx.sql`select ops.record_sale(${json(ctx, p)}, ${shop.tokenHash}) as r`)[0]!
      .r as string;
    return { id, r };
  };

  it("stores the service charge as a taxed line and links the sale to its tab once", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const tab = randomUUID();
      const { id, r } = await sell(ctx, a, tab);
      expect(r).toBe("created");
      const lines =
        await ctx.sql`select name, gross_cents, vat_cents, variant_id from sale_lines where sale_id = ${id} order by line_no`;
      expect(lines.map((l) => l.name)).toEqual(["Tea", "Service charge 12.5%"]);
      expect(lines[1]!.variant_id).toBeNull();
      expect((await ctx.sql`select tab_id from sale_tabs where sale_id = ${id}`)[0]!.tab_id).toBe(
        tab,
      );
      expect(
        (await ctx.sql`select review_flags from sales where id = ${id}`)[0]!.review_flags,
      ).toEqual(["service_differs"]);
      // a service line that does not add up is refused like any other line
      await ctx.denied(
        () =>
          sell(ctx, a, null, {
            lines: [
              {
                kind: "item",
                variant_id: null,
                product_id: null,
                name: "Service charge",
                qty: 1,
                unit_price_cents: 44,
                modifiers: [],
                discount_cents: 0,
                tax_category: "STANDARD",
                tax_rate_bp: 2300,
                net_cents: 30,
                vat_cents: 14,
                gross_cents: 44,
              },
            ],
          }),
        ["22023"],
      );
    }));

  it("managers read tab totals; cashiers and Shop B read none", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const tab = randomUUID();
      await record(ctx, a.tokenHash, event(a, { tab_id: tab, detail: { table: "T1", covers: 4 } }));
      await sell(ctx, a, tab);
      const totals = (actor: Shop["owner"] | null, org: string) =>
        ctx.as(
          actor,
          () =>
            ctx.sql`select * from public.tab_covers(${org}, now() - interval '1 day', now() + interval '1 day')`,
        );
      const [row] = await totals(a.manager, a.orgId);
      expect(row).toMatchObject({ tabs: "1", covers: "4", sales_cents: "394" });
      await ctx.denied(() => totals(a.cashier, a.orgId));
      await ctx.denied(() => totals(b.owner, a.orgId));
      await ctx.denied(() => totals(null, a.orgId));
      await ctx.denied(() => ctx.as(a.manager, () => ctx.sql`delete from sale_tabs`));
    }));
});

describe("voiding a sent line", () => {
  const approve = (ctx: Ctx, shop: Shop, who: Shop["manager"], purpose = "void_item") =>
    ctx.sql`select ops.issue_approval(${shop.tokenHash}, ${who.userId}, ${purpose}) as id`.then(
      (r) => r[0]!.id as string,
    );
  const voidEvent = (shop: Shop, over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    kind: "void_item",
    at: new Date().toISOString(),
    cashier_user_id: shop.cashier.userId,
    approval_id: null,
    claimed_approver: null,
    detail: { item: "Steak", qty: 1, course: 2, note: "Mary 087 123 4567" },
    ...over,
  });
  const send = (ctx: Ctx, shop: Shop, e: unknown) =>
    ctx.sql`select * from ops.record_register_events(${shop.tokenHash}, ${json(ctx, [e])})`;

  it("a manager PIN approval is verified, spent once, and the detail keeps only allow-listed facts", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      await savePlan(ctx, a.manager, a.orgId, plan([table({ name: "T1" })]));
      const approval = await approve(ctx, a, a.manager);
      const e = voidEvent(a, {
        approval_id: approval,
        detail: { item: "Steak", qty: 1, course: 2, table: "t1", note: "Mary 087 123 4567" },
      });
      expect(await send(ctx, a, e)).toHaveLength(1);
      const [row] = await ctx.sql`select action, after from audit_log where id = ${e.id}`;
      expect(row!.action).toBe("tab.void_item");
      expect(row!.after).toMatchObject({
        approval: "pin_verified",
        approved_by: a.manager.userId,
        detail: { item: "Steak", qty: 1, course: 2, table: "T1" },
      });
      expect(JSON.stringify(row!.after)).not.toContain("Mary");
      // replaying the event changes nothing; the spent approval cannot back a second void
      expect(await send(ctx, a, e)).toHaveLength(1);
      await ctx.denied(() => send(ctx, a, voidEvent(a, { approval_id: approval })), ["42501"]);
    }));

  it("a cashier cannot be the approver, and approvals do not cross purposes, tills or shops", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await ctx.denied(() => approve(ctx, a, a.cashier), ["42501"]);
      await ctx.denied(() => approve(ctx, a, a.manager, "bogus"), ["22023"]);
      // a discount approval cannot pay for a void, nor a void approval for a no-sale
      const discount = await approve(ctx, a, a.manager, "discount");
      await ctx.denied(() => send(ctx, a, voidEvent(a, { approval_id: discount })), ["42501"]);
      const voidApproval = await approve(ctx, a, a.manager);
      await ctx.denied(
        () => send(ctx, a, voidEvent(a, { kind: "no_sale", approval_id: voidApproval })),
        ["42501"],
      );
      // another shop's till cannot spend it
      await ctx.denied(() => send(ctx, b, voidEvent(b, { approval_id: voidApproval })), ["42501"]);
    }));

  it("without a server approval the row says unverified_offline and names no approver", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const e = voidEvent(a, { claimed_approver: a.manager.userId });
      await send(ctx, a, e);
      const [row] = await ctx.sql`select after from audit_log where id = ${e.id}`;
      expect(row!.after).toMatchObject({ approval: "unverified_offline", approved_by: null });
      // a claimed approver who is only a cashier is refused
      await ctx.denied(
        () => send(ctx, a, voidEvent(a, { claimed_approver: a.cashier.userId })),
        ["42501"],
      );
    }));
});
