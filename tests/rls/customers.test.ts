// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { seedProduct } from "./catalog-helpers";
import { inWorld, sql, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);
const WRONG = ["22023"];

const fields = (over: Record<string, unknown> = {}) => ({
  name: "Mary Byrne",
  email: `mary-${randomUUID().slice(0, 6)}@example.com`,
  phone: "087 123 4567",
  vat_number: null,
  address: "1 Main St, Cork",
  notes: "Prefers receipts by email",
  ...over,
});

const save = (ctx: Ctx, actor: Shop["manager"] | null, org: string, id: string, p: unknown) =>
  ctx.as(actor, () => ctx.sql`select public.save_customer(${org}, ${id}, ${json(ctx, p)}) as r`);

const create = async (ctx: Ctx, shop: Shop, over: Record<string, unknown> = {}) => {
  const id = randomUUID();
  await save(ctx, shop.manager, shop.orgId, id, fields(over));
  return id;
};

/** A cash sale of one 3.50 tea, linked to `customer` (or none). */
async function sellTo(
  ctx: Ctx,
  shop: Shop,
  customer: string | null,
  seq = 1,
  id: string = randomUUID(),
) {
  const { pid, vid } = await seedProduct(ctx, shop.orgId, `sku-${randomUUID().slice(0, 6)}`);
  const cash = (
    await ctx.sql`select id from tender_types where location_id = ${shop.locationId} and method = 'cash'`
  )[0]!.id as string;
  const saleId = id;
  const p = {
    customer_id: customer,
    sale: {
      id: saleId,
      org_id: shop.orgId,
      register_id: shop.registerId,
      user_id: shop.cashier.userId,
      receipt_seq: seq,
      mode: "eat_in",
      completed_at: new Date().toISOString(),
      priced_as_of: new Date().toISOString(),
      items_total: 350,
      vat: 65,
      non_vat: 0,
      cash_rounding: 0,
      amount_due: 350,
      client_due: 350,
    },
    lines: [
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
    ],
    payments: [{ type_id: cash, method: "cash", amount: 350, tendered: 350, change: 0 }],
  };
  const r = (await ctx.sql`select ops.record_sale(${json(ctx, p)}, ${shop.tokenHash}) as r`)[0]!
    .r as string;
  return { saleId, r };
}

const linked = async (ctx: Ctx, saleId: string) =>
  (await ctx.sql`select customer_id from sale_customers where sale_id = ${saleId}`)[0]
    ?.customer_id as string | undefined;

describe("customers: back office functions", () => {
  it("managers and owners create and edit; fields are trimmed and validated", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = randomUUID();
      await save(
        ctx,
        a.owner,
        a.orgId,
        id,
        fields({ name: "  Seán  ", email: " SEAN@Example.com " }),
      );
      const [row] = await ctx.sql`select name, email from customers where id = ${id}`;
      expect(row).toEqual({ name: "Seán", email: "sean@example.com" });
      await save(ctx, a.manager, a.orgId, id, fields({ name: "Seán Ó Briain", email: null }));
      expect((await ctx.sql`select name, email from customers where id = ${id}`)[0]).toEqual({
        name: "Seán Ó Briain",
        email: null,
      });
      for (const bad of [
        { name: "  " },
        { name: "x".repeat(121) },
        { email: "not-an-email" },
        { vat_number: "1" },
        { phone: "9".repeat(31) },
      ]) {
        await ctx.denied(() => save(ctx, a.manager, a.orgId, randomUUID(), fields(bad)), WRONG);
      }
    }));

  it("a duplicate email in one shop is refused; another shop may reuse it", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await create(ctx, a, { email: "same@example.com" });
      await ctx.denied(() => create(ctx, a, { email: "SAME@example.com" }), ["23505"]);
      await create(ctx, b, { email: "same@example.com" });
    }));

  it("cashiers, anon and another shop's staff cannot write or call the functions", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await create(ctx, a);
      await ctx.denied(() => save(ctx, a.cashier, a.orgId, randomUUID(), fields()));
      await ctx.denied(() => save(ctx, null, a.orgId, randomUUID(), fields()));
      await ctx.denied(() => save(ctx, b.owner, a.orgId, randomUUID(), fields()));
      for (const actor of [a.cashier, b.owner, b.manager]) {
        await ctx.denied(() =>
          ctx.as(actor, () => ctx.sql`select public.export_customer(${a.orgId}, ${id})`),
        );
        await ctx.denied(() =>
          ctx.as(actor, () => ctx.sql`select public.anonymise_customer(${a.orgId}, ${id})`),
        );
        await ctx.denied(() =>
          ctx.as(
            actor,
            () => ctx.sql`select public.set_marketing_consent(${a.orgId}, ${id}, true)`,
          ),
        );
      }
      await ctx.denied(() =>
        ctx.as(null, () => ctx.sql`select public.export_customer(${a.orgId}, ${id})`),
      );
    }));

  it("Shop B cannot touch Shop A's customer even with A's org id", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await create(ctx, a);
      // B's manager naming B's own org with A's customer id finds nothing
      await ctx.denied(
        () =>
          save(ctx, b.manager, b.orgId, id, fields({ email: null })).then(() => {
            // the insert would have created a row for B with A's id: the primary key refuses it
          }),
        ["23505"],
      );
      await ctx.denied(
        () => ctx.as(b.manager, () => ctx.sql`select public.export_customer(${b.orgId}, ${id})`),
        WRONG,
      );
      await ctx.denied(
        () => ctx.as(b.manager, () => ctx.sql`select public.anonymise_customer(${b.orgId}, ${id})`),
        WRONG,
      );
    }));
});

describe("customers: read access", () => {
  it("managers and owners read their shop's customers; cashiers, anon and Shop B read none", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await create(ctx, a);
      const count = (actor: Shop["owner"] | null) =>
        ctx.as(
          actor,
          async () =>
            (await ctx.sql`select count(*)::int as n from customers where id = ${id}`)[0]!
              .n as number,
        );
      expect(await count(a.owner)).toBe(1);
      expect(await count(a.manager)).toBe(1);
      expect(await count(a.cashier)).toBe(0);
      expect(await count(b.owner)).toBe(0);
      expect(await count(b.manager)).toBe(0);
      expect(await count(null).catch(() => 0)).toBe(0);
    }));

  it("clients have no direct write access to customers or the sale link", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = await create(ctx, a);
      await ctx.denied(() =>
        ctx.as(
          a.owner,
          () =>
            ctx.sql`insert into customers (id, org_id, name) values (${randomUUID()}, ${a.orgId}, 'X')`,
        ),
      );
      await ctx.denied(() =>
        ctx.as(a.owner, () => ctx.sql`update customers set name = 'X' where id = ${id}`),
      );
      await ctx.denied(() =>
        ctx.as(a.owner, () => ctx.sql`delete from customers where id = ${id}`),
      );
      await ctx.denied(() =>
        ctx.as(
          a.owner,
          () => ctx.sql`update customers set marketing_consent_at = now() where id = ${id}`,
        ),
      );
    }));
});

describe("customers: marketing consent", () => {
  it("the timestamp is the server's; withdrawing clears it; both are audited without personal data", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = await create(ctx, a);
      expect(
        (await ctx.sql`select marketing_consent_at from customers where id = ${id}`)[0]!
          .marketing_consent_at,
      ).toBeNull();
      await ctx.as(
        a.manager,
        () => ctx.sql`select public.set_marketing_consent(${a.orgId}, ${id}, true)`,
      );
      const [on] =
        await ctx.sql`select marketing_consent_at as at, now() as now from customers where id = ${id}`;
      expect(on!.at).not.toBeNull();
      await ctx.as(
        a.manager,
        () => ctx.sql`select public.set_marketing_consent(${a.orgId}, ${id}, false)`,
      );
      expect(
        (await ctx.sql`select marketing_consent_at from customers where id = ${id}`)[0]!
          .marketing_consent_at,
      ).toBeNull();
      const audit = await ctx.sql`
        select action, before, after from audit_log where entity = 'customer' and entity_id = ${id}
        order by created_at`;
      expect(audit.map((r) => r.action)).toEqual([
        "customer.created",
        "customer.consent_given",
        "customer.consent_withdrawn",
      ]);
      expect(audit.every((r) => r.before === null && r.after === null)).toBe(true);
    }));
});

describe("customers: sale link, history and anonymise", () => {
  it("a sale links to a live customer of its own shop; anything else records the sale unlinked", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const mine = await create(ctx, a);
      const theirs = await create(ctx, b);
      const s1 = await sellTo(ctx, a, mine, 1);
      expect(s1.r).toBe("created");
      expect(await linked(ctx, s1.saleId)).toBe(mine);
      // a replay stays one link
      const s2 = await sellTo(ctx, a, theirs, 2);
      expect(s2.r).toBe("created");
      expect(await linked(ctx, s2.saleId)).toBeUndefined();
      const s3 = await sellTo(ctx, a, randomUUID(), 3);
      expect(s3.r).toBe("created");
      expect(await linked(ctx, s3.saleId)).toBeUndefined();
      // replaying an existing sale cannot attach a customer afterwards
      expect((await sellTo(ctx, a, mine, 3, s3.saleId)).r).toBe("duplicate");
      expect(await linked(ctx, s3.saleId)).toBeUndefined();
      const s4 = await sellTo(ctx, a, null, 4);
      expect(await linked(ctx, s4.saleId)).toBeUndefined();
    }));

  it("the link is append-only and only managers and owners of the shop read it", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await create(ctx, a);
      const { saleId } = await sellTo(ctx, a, id);
      const read = (actor: Shop["owner"]) =>
        ctx.as(
          actor,
          async () =>
            (
              await ctx.sql`select count(*)::int as n from sale_customers where sale_id = ${saleId}`
            )[0]!.n as number,
        );
      expect(await read(a.manager)).toBe(1);
      expect(await read(a.cashier)).toBe(0);
      expect(await read(b.owner)).toBe(0);
      await ctx.denied(() => ctx.sql`update sale_customers set customer_id = ${randomUUID()}`);
      await ctx.denied(() => ctx.sql`delete from sale_customers where sale_id = ${saleId}`);
      await ctx.denied(() => ctx.sql`truncate sale_customers`);
    }));

  it("anonymise scrubs every personal field, keeps the sale link, and is idempotent", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = await create(ctx, a, { vat_number: "IE6388047V" });
      await ctx.as(
        a.manager,
        () => ctx.sql`select public.set_marketing_consent(${a.orgId}, ${id}, true)`,
      );
      const { saleId } = await sellTo(ctx, a, id);
      const run = () =>
        ctx.as(a.manager, () => ctx.sql`select public.anonymise_customer(${a.orgId}, ${id})`);
      await run();
      await run();
      const [c] = await ctx.sql`select * from customers where id = ${id}`;
      expect(c).toMatchObject({
        name: "Deleted customer",
        email: null,
        phone: null,
        vat_number: null,
        address: null,
        notes: null,
        marketing_consent_at: null,
      });
      expect(c!.anonymised_at).not.toBeNull();
      expect(await linked(ctx, saleId)).toBe(id);
      expect(
        (
          await ctx.sql`select count(*)::int as n from audit_log
                         where entity_id = ${id} and action = 'customer.anonymised'`
        )[0]!.n,
      ).toBe(1);
      // an anonymised customer cannot be edited, given consent, or linked to a new sale
      await ctx.denied(() => save(ctx, a.manager, a.orgId, id, fields()), WRONG);
      await ctx.denied(
        () =>
          ctx.as(
            a.manager,
            () => ctx.sql`select public.set_marketing_consent(${a.orgId}, ${id}, true)`,
          ),
        WRONG,
      );
      const later = await sellTo(ctx, a, id, 2);
      expect(await linked(ctx, later.saleId)).toBeUndefined();
    }));

  it("export returns the customer and their sales, and is audited without personal data", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = await create(ctx, a, { name: "Aoife Ní Dhubhghaill" });
      const { saleId } = await sellTo(ctx, a, id);
      const [row] = await ctx.as(
        a.owner,
        () => ctx.sql`select public.export_customer(${a.orgId}, ${id}) as d`,
      );
      const d = row!.d as {
        customer: { name: string };
        sales: { sale_id: string; total_cents: number }[];
      };
      expect(d.customer.name).toBe("Aoife Ní Dhubhghaill");
      expect(d.sales).toHaveLength(1);
      expect(d.sales[0]).toMatchObject({ sale_id: saleId, total_cents: 350 });
      const audit = await ctx.sql`
        select after, before from audit_log where entity_id = ${id} and action = 'customer.exported'`;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toEqual({ after: null, before: null });
      await ctx.denied(
        () =>
          ctx.as(
            a.owner,
            () => ctx.sql`select public.export_customer(${a.orgId}, ${randomUUID()})`,
          ),
        WRONG,
      );
    }));
});

describe("customers: the till (device functions)", () => {
  const search = async (ctx: Ctx, token: string, q: string) =>
    (await ctx.sql`select ops.device_customer_search(${token}, ${q}) as r`)[0]!.r as
      { id: string; name: string }[] | null;

  it("finds only this shop's live customers; short, wildcard and unknown-token queries find nothing", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const mine = await create(ctx, a, { name: "Ciara Walsh", email: "ciara@example.com" });
      await create(ctx, b, { name: "Ciara Walsh", email: "ciara@b.example.com" });
      const gone = await create(ctx, a, { name: "Ciara Gone", email: null });
      await ctx.as(a.manager, () => ctx.sql`select public.anonymise_customer(${a.orgId}, ${gone})`);

      expect((await search(ctx, a.tokenHash, "ciara"))!.map((r) => r.id)).toEqual([mine]);
      // name only: an email or phone never matches, and only id and name come back
      expect(await search(ctx, a.tokenHash, "ciara@example")).toEqual([]);
      expect(await search(ctx, a.tokenHash, "ciara")).toEqual([
        { id: mine, name: "Ciara Walsh", hint: "c***@example.com" },
      ]);
      // namesakes are told apart by a masked hint, never the full contact details
      const phoneOnly = await create(ctx, a, {
        name: "Ciara Walsh",
        email: null,
        phone: "087 123 4567",
      });
      const both = await search(ctx, a.tokenHash, "ciara walsh");
      expect(both!.find((r) => r.id === phoneOnly)).toMatchObject({ hint: "ends 567" });
      expect(JSON.stringify(both)).not.toContain("4567");
      expect(JSON.stringify(both)).not.toContain("ciara@");
      expect((await search(ctx, b.tokenHash, "ciara"))!).toHaveLength(1);
      expect(await search(ctx, a.tokenHash, "c")).toEqual([]);
      expect(await search(ctx, a.tokenHash, "%%")).toEqual([]);
      expect(await search(ctx, a.tokenHash, "__")).toEqual([]);
      expect(await search(ctx, "f".repeat(64), "ciara")).toBeNull();
    }));

  it("creates in the till's own shop, stamps consent on the server, refuses a taken email", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = randomUUID();
      const make = (token: string, over: Record<string, unknown> = {}) =>
        ctx.sql`select ops.device_customer_create(${token}, ${json(ctx, {
          id,
          name: "Till Customer",
          email: "till@example.com",
          phone: null,
          vat_number: null,
          consent: true,
          ...over,
        })}) as r`;
      const [res] = await make(a.tokenHash);
      expect((res!.r as { id: string }).id).toBe(id);
      const [c] =
        await ctx.sql`select org_id, marketing_consent_at from customers where id = ${id}`;
      expect(c!.org_id).toBe(a.orgId);
      expect(c!.marketing_consent_at).not.toBeNull();
      expect((await make("f".repeat(64)))[0]!.r).toBeNull();
      await ctx.denied(
        () =>
          ctx.sql`select ops.device_customer_create(${a.tokenHash}, ${json(ctx, {
            id: randomUUID(),
            name: "Dup",
            email: "TILL@example.com",
          })})`,
        ["23505"],
      );
      await ctx.denied(
        () =>
          ctx.sql`select ops.device_customer_create(${b.tokenHash}, ${json(ctx, { id: randomUUID(), name: " " })})`,
        WRONG,
      );
      // no consent unless the tick was sent
      const id2 = randomUUID();
      await ctx.sql`select ops.device_customer_create(${a.tokenHash}, ${json(ctx, { id: id2, name: "No Consent" })})`;
      expect(
        (await ctx.sql`select marketing_consent_at from customers where id = ${id2}`)[0]!
          .marketing_consent_at,
      ).toBeNull();
    }));

  it("clients cannot call the device functions", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      await ctx.denied(() =>
        ctx.as(a.owner, () => ctx.sql`select ops.device_customer_search(${a.tokenHash}, 'abc')`),
      );
    }));
});
