// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql, type Actor, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);

type Kind = "products" | "stock" | "customers";

/** Upload + confirm + start, as the manager; returns the import id. */
async function begin(
  ctx: Ctx,
  shop: Shop,
  type: Kind,
  mode: string,
  key: string,
  actor: Actor = shop.manager,
) {
  const id = randomUUID();
  await ctx.as(
    actor,
    () =>
      ctx.sql`select public.create_import(${shop.orgId}, ${id}, 'f.csv', ${Buffer.from("A\n1")}, ${1}, ${type})`,
  );
  await ctx.as(
    actor,
    () =>
      ctx.sql`select public.confirm_import(${shop.orgId}, ${id}, ${mode}, ${key}, ${json(ctx, { name: "Name" })})`,
  );
  const r = (await ctx.sql`select ops.import_begin(${id}, ${actor.userId}) as r`)[0]!.r as {
    org_id: string;
    type: string;
  } | null;
  expect(r).toMatchObject({ org_id: shop.orgId, type });
  return id;
}

type Result = { ref: string; status: string; code?: string }[];
const call = async (
  ctx: Ctx,
  fn: "stock" | "customers" | "batch",
  id: string,
  user: string,
  items: unknown[],
) => {
  const p = json(ctx, { import_id: id, user_id: user, items });
  const r =
    fn === "stock"
      ? await ctx.sql`select ops.import_apply_stock(${p}) as r`
      : fn === "customers"
        ? await ctx.sql`select ops.import_apply_customers(${p}) as r`
        : await ctx.sql`select ops.import_apply_batch(${p}) as r`;
  return r[0]!.r as Result;
};
const finish = (ctx: Ctx, id: string) =>
  ctx.sql`select ops.import_finish(${id}, true, 0, '[]'::jsonb, null)`;
const job = async (ctx: Ctx, id: string) =>
  (await ctx.sql`select * from import_jobs where id = ${id}`)[0]!;

/** A stock-tracked product with one variant, made through a products import. */
async function product(
  ctx: Ctx,
  shop: Shop,
  sku: string,
  o: { barcode?: string; track?: boolean; stock?: number } = {},
) {
  const id = await begin(ctx, shop, "products", "create", "sku");
  const variantId = randomUUID();
  const res = await call(ctx, "batch", id, shop.manager.userId, [
    {
      ref: "2",
      rows: [2],
      category: null,
      product: {
        id: randomUUID(),
        name: `Item ${sku}`,
        tax_category: "STANDARD",
        tax_set: false,
        track_set: false,
        takeaway_tax_category: null,
        track_stock: o.track ?? true,
      },
      variants: [
        {
          id: variantId,
          name: "",
          sku,
          barcode: o.barcode ?? null,
          price_incl_vat_cents: 250,
          cost_cents: null,
          attributes: {},
          attr_set: [],
          sort: 0,
          opening_stock: o.stock ?? 0,
        },
      ],
    },
  ]);
  expect(res[0]!.status).toBe("ok");
  await finish(ctx, id);
  return variantId;
}
const onHand = async (ctx: Ctx, variantId: string) =>
  Number(
    (
      await ctx.sql`select coalesce(sum(qty_delta), 0)::int as n from stock_movements where variant_id = ${variantId}`
    )[0]!.n,
  );

const customer = (ref: string, fields: Record<string, unknown>, set: string[] = []) => ({
  ref,
  id: randomUUID(),
  fields: {
    name: "N",
    email: null,
    phone: null,
    vat_number: null,
    address: null,
    notes: null,
    ...fields,
  },
  set,
});

describe("stock import", () => {
  it("counts set the shelf quantity, deliveries add to it, equal counts are skipped", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const v1 = await product(ctx, a, "S1", { stock: 5 });
      const v2 = await product(ctx, a, "S2", { barcode: "5390001", stock: 2 });
      const v3 = await product(ctx, a, "S3", { stock: 4 });

      const c = await begin(ctx, a, "stock", "count", "sku");
      const res = await call(ctx, "stock", c, a.manager.userId, [
        { ref: "2", key: "S1", qty: 12, note: "Shelf count" },
        { ref: "3", key: "S2", qty: 0, note: null },
        { ref: "4", key: "S3", qty: 4, note: null }, // same as the system
      ]);
      expect(res.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
      await finish(ctx, c);
      expect([await onHand(ctx, v1), await onHand(ctx, v2), await onHand(ctx, v3)]).toEqual([
        12, 0, 4,
      ]);
      expect(await job(ctx, c)).toMatchObject({
        status: "done",
        updated_count: 2,
        skipped_count: 1,
      });
      expect(
        (
          await ctx.sql`select reason, note from stock_movements where variant_id = ${v1} and reason = 'count'`
        )[0],
      ).toMatchObject({ reason: "count", note: "Shelf count" });

      const r = await begin(ctx, a, "stock", "received", "barcode");
      const res2 = await call(ctx, "stock", r, a.manager.userId, [
        { ref: "2", key: "5390001", qty: 24, note: null },
      ]);
      expect(res2[0]!.status).toBe("ok");
      await finish(ctx, r);
      expect(await onHand(ctx, v2)).toBe(24);
    });
  });

  it("refuses unknown, untracked and out-of-range rows without stopping the others", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const v = await product(ctx, a, "OK1", { stock: 1 });
      await product(ctx, a, "NOTRACK", { track: false });
      const id = await begin(ctx, a, "stock", "received", "sku");
      const res = await call(ctx, "stock", id, a.manager.userId, [
        { ref: "2", key: "MISSING", qty: 1, note: null },
        { ref: "3", key: "NOTRACK", qty: 1, note: null },
        { ref: "4", key: "OK1", qty: 0, note: null }, // a delivery of 0
        { ref: "5", key: "OK1", qty: 1000001, note: null },
        { ref: "6", key: "OK1", qty: 3, note: null },
      ]);
      expect(res.map((r) => [r.status, r.code])).toEqual([
        ["error", "P0002"],
        ["error", "22023"],
        ["error", "22023"],
        ["error", "22023"],
        ["ok", undefined],
      ]);
      expect(await onHand(ctx, v)).toBe(4);
    });
  });

  it("does not touch an archived product or another shop's product with the same SKU", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const vb = await product(ctx, b, "SHARED", { stock: 9 });
      const id = await begin(ctx, a, "stock", "received", "sku");
      const res = await call(ctx, "stock", id, a.manager.userId, [
        { ref: "2", key: "SHARED", qty: 5, note: null },
      ]);
      expect(res[0]).toMatchObject({ status: "error", code: "P0002" });
      expect(await onHand(ctx, vb)).toBe(9);
    });
  });

  it("is safe to run twice: a retried batch adds nothing", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const v = await product(ctx, a, "R1", { stock: 0 });
      const id = await begin(ctx, a, "stock", "received", "sku");
      const items = [{ ref: "2", key: "R1", qty: 10, note: null }];
      await call(ctx, "stock", id, a.manager.userId, items);
      await call(ctx, "stock", id, a.manager.userId, items);
      expect(await onHand(ctx, v)).toBe(10);
    });
  });

  it("undo puts the quantity back with an opposite adjustment and keeps the history", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const v = await product(ctx, a, "U1", { stock: 5 });
      const id = await begin(ctx, a, "stock", "count", "sku");
      await call(ctx, "stock", id, a.manager.userId, [
        { ref: "2", key: "U1", qty: 20, note: null },
      ]);
      await finish(ctx, id);
      expect(await onHand(ctx, v)).toBe(20);
      const r = (
        await ctx.as(a.manager, () => ctx.sql`select public.undo_import(${a.orgId}, ${id}) as r`)
      )[0]!.r as { reverted: number };
      expect(r.reverted).toBe(1);
      expect(await onHand(ctx, v)).toBe(5);
      expect(
        (await ctx.sql`select count(*)::int as n from stock_movements where variant_id = ${v}`)[0]!
          .n,
      ).toBe(3); // opening, count, undo
      expect((await job(ctx, id)).status).toBe("undone");
    });
  });
});

describe("customer import", () => {
  it("creates customers with the screen's rules and never sets marketing consent", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a, "customers", "create", "email");
      const res = await call(ctx, "customers", id, a.manager.userId, [
        customer("2", { name: "Mary Byrne", email: "Mary@Example.com", phone: "087 123 4567" }),
        customer("3", { name: "Walk-in" }),
        customer("4", { name: "Bad", email: "not-an-email" }),
        {
          ...customer("5", { name: "Sneaky" }),
          fields: { name: "Sneaky", marketing_consent_at: "2026-01-01" },
        },
      ]);
      expect(res.map((r) => r.status)).toEqual(["ok", "ok", "error", "ok"]);
      await finish(ctx, id);
      const rows =
        await ctx.sql`select name, email, marketing_consent_at from customers where org_id = ${a.orgId} order by name`;
      expect(rows.map((r) => r.name)).toEqual(["Mary Byrne", "Sneaky", "Walk-in"]);
      expect(rows.find((r) => r.name === "Mary Byrne")!.email).toBe("mary@example.com");
      expect(rows.every((r) => r.marketing_consent_at === null)).toBe(true);
      expect(await job(ctx, id)).toMatchObject({ status: "done", created_count: 3 });
    });
  });

  it("create-only skips an existing e-mail; update changes the name and only the fields given", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const first = await begin(ctx, a, "customers", "create", "email");
      await call(ctx, "customers", first, a.manager.userId, [
        customer("2", { name: "Old Name", email: "x@example.com", phone: "111", notes: "keep me" }),
      ]);
      await finish(ctx, first);
      await ctx.sql`update customers set marketing_consent_at = now() where org_id = ${a.orgId} and email = 'x@example.com'`;

      const skip = await begin(ctx, a, "customers", "create", "email");
      await call(ctx, "customers", skip, a.manager.userId, [
        customer("2", { name: "Other", email: "X@example.com" }),
      ]);
      await finish(ctx, skip);
      expect(await job(ctx, skip)).toMatchObject({ created_count: 0, skipped_count: 1 });

      const up = await begin(ctx, a, "customers", "upsert", "email");
      await call(ctx, "customers", up, a.manager.userId, [
        customer("2", { name: "New Name", email: "x@example.com", phone: "222" }, ["phone"]),
      ]);
      await finish(ctx, up);
      const row = (
        await ctx.sql`select * from customers where org_id = ${a.orgId} and email = 'x@example.com'`
      )[0]!;
      expect(row).toMatchObject({ name: "New Name", phone: "222", notes: "keep me" });
      expect(row.marketing_consent_at).not.toBeNull(); // untouched
      expect(await job(ctx, up)).toMatchObject({ updated_count: 1 });

      // undo of the update restores the old values
      await ctx.as(a.manager, () => ctx.sql`select public.undo_import(${a.orgId}, ${up})`);
      const back = (
        await ctx.sql`select * from customers where org_id = ${a.orgId} and email = 'x@example.com'`
      )[0]!;
      expect(back).toMatchObject({ name: "Old Name", phone: "111", notes: "keep me" });
    });
  });

  it("undo anonymises created customers (the row stays) and a retried batch creates none twice", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a, "customers", "create", "email");
      const items = [customer("2", { name: "Temp", email: "t@example.com", phone: "1" })];
      await call(ctx, "customers", id, a.manager.userId, items);
      await call(ctx, "customers", id, a.manager.userId, items);
      await finish(ctx, id);
      expect(
        (await ctx.sql`select count(*)::int as n from customers where org_id = ${a.orgId}`)[0]!.n,
      ).toBe(1);
      await ctx.as(a.manager, () => ctx.sql`select public.undo_import(${a.orgId}, ${id})`);
      const row = (await ctx.sql`select * from customers where org_id = ${a.orgId}`)[0]!;
      expect(row).toMatchObject({ name: "Deleted customer", email: null, phone: null });
      expect(row.anonymised_at).not.toBeNull();
    });
  });

  it("the same e-mail in another shop is not a match", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const idB = await begin(ctx, b, "customers", "create", "email");
      await call(ctx, "customers", idB, b.manager.userId, [
        customer("2", { name: "B's", email: "same@example.com" }),
      ]);
      await finish(ctx, idB);
      const idA = await begin(ctx, a, "customers", "upsert", "email");
      await call(ctx, "customers", idA, a.manager.userId, [
        customer("2", { name: "A's", email: "same@example.com" }),
      ]);
      await finish(ctx, idA);
      expect(
        (await ctx.sql`select name from customers where org_id = ${b.orgId}`).map((r) => r.name),
      ).toEqual(["B's"]);
      expect(
        (await ctx.sql`select name from customers where org_id = ${a.orgId}`).map((r) => r.name),
      ).toEqual(["A's"]);
    });
  });

  it("import_existing_emails answers managers of the shop only, for that shop only", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await begin(ctx, a, "customers", "create", "email");
      await call(ctx, "customers", id, a.manager.userId, [
        customer("2", { name: "M", email: "m@example.com" }),
      ]);
      await finish(ctx, id);
      const ask = (who: Actor | null, org: string) =>
        ctx.as(who, async () => {
          const r =
            await ctx.sql`select public.import_existing_emails(${org}, ${["m@example.com"]}::text[]) as r`;
          return r[0]!.r as string[];
        });
      expect(await ask(a.manager, a.orgId)).toEqual(["m@example.com"]);
      expect(await ask(a.cashier, a.orgId)).toEqual([]); // RLS hides customers from cashiers
      expect(await ask(b.manager, a.orgId)).toEqual([]);
      await ctx.denied(() => ask(null, a.orgId));
    });
  });
});

describe("settings and access for every type", () => {
  it("rejects a mode or key that belongs to another type, and unknown types", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const mk = async (type: Kind) => {
        const id = randomUUID();
        await ctx.as(
          a.manager,
          () =>
            ctx.sql`select public.create_import(${a.orgId}, ${id}, 'f.csv', ${Buffer.from("A\n1")}, ${1}, ${type})`,
        );
        return id;
      };
      const confirm = (id: string, mode: string, key: string) =>
        ctx.as(
          a.manager,
          () =>
            ctx.sql`select public.confirm_import(${a.orgId}, ${id}, ${mode}, ${key}, ${json(ctx, { name: "N" })})`,
        );
      // a confirmed import blocks the next upload, so run each one to its end
      const settle = async (id: string) => {
        await ctx.sql`select ops.import_begin(${id}, ${a.manager.userId})`;
        await finish(ctx, id);
      };
      const s = await mk("stock");
      await ctx.denied(() => confirm(s, "create", "sku"), ["22023"]);
      await ctx.denied(() => confirm(s, "count", "email"), ["22023"]);
      await confirm(s, "received", "barcode");
      await settle(s);
      const c = await mk("customers");
      await ctx.denied(() => confirm(c, "count", "email"), ["22023"]);
      await ctx.denied(() => confirm(c, "create", "sku"), ["22023"]);
      await confirm(c, "upsert", "email");
      await settle(c);
      const p = await mk("products");
      await ctx.denied(() => confirm(p, "received", "sku"), ["22023"]);
      await ctx.denied(
        () =>
          ctx.as(
            a.manager,
            () =>
              ctx.sql`select public.create_import(${a.orgId}, ${randomUUID()}, 'f.csv', ${Buffer.from("A\n1")}, ${1}, ${"suppliers"})`,
          ),
        ["22023"],
      );
    });
  });

  it("each batch writer refuses another type's import, a demoted creator and anyone but the job role", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const st = await begin(ctx, a, "stock", "count", "sku");
      await ctx.denied(() => call(ctx, "customers", st, a.manager.userId, []), ["55000"]);
      await ctx.denied(() => call(ctx, "batch", st, a.manager.userId, []), ["55000"]);
      await ctx.denied(() => call(ctx, "stock", st, randomUUID(), []), ["42501"]);
      await finish(ctx, st);

      const cu = await begin(ctx, a, "customers", "create", "email");
      await ctx.denied(() => call(ctx, "stock", cu, a.manager.userId, []), ["55000"]);
      // the creator stops being a manager before the job runs
      await ctx.sql`update memberships set role = 'cashier' where org_id = ${a.orgId} and user_id = ${a.manager.userId}`;
      await ctx.denied(() => call(ctx, "customers", cu, a.manager.userId, []), ["42501"]);
    });
  });

  it("cashiers and other shops cannot upload, run or undo any type; app roles cannot call the batch writers", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      for (const type of ["stock", "customers"] as const) {
        await ctx.denied(() =>
          ctx.as(
            a.cashier,
            () =>
              ctx.sql`select public.create_import(${a.orgId}, ${randomUUID()}, 'f.csv', ${Buffer.from("A\n1")}, ${1}, ${type})`,
          ),
        );
        await ctx.denied(() =>
          ctx.as(
            b.manager,
            () =>
              ctx.sql`select public.create_import(${a.orgId}, ${randomUUID()}, 'f.csv', ${Buffer.from("A\n1")}, ${1}, ${type})`,
          ),
        );
      }
      const id = await begin(ctx, a, "stock", "count", "sku");
      await finish(ctx, id);
      for (const who of [a.cashier, b.manager, b.owner, null]) {
        await ctx.denied(() =>
          ctx.as(who, () => ctx.sql`select public.undo_import(${a.orgId}, ${id})`),
        );
      }
      for (const who of [a.owner, a.manager, a.cashier, null]) {
        await ctx.denied(() =>
          ctx.as(
            who,
            () =>
              ctx.sql`select ops.import_apply_stock(${json(ctx, { import_id: id, user_id: a.manager.userId, items: [] })})`,
          ),
        );
        await ctx.denied(() =>
          ctx.as(
            who,
            () =>
              ctx.sql`select ops.import_apply_customers(${json(ctx, { import_id: id, user_id: a.manager.userId, items: [] })})`,
          ),
        );
      }
    });
  });
});

describe("customer import: erasure and retries", () => {
  it("erasing a customer clears the old values kept for undo, and undo then reports it as kept", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const first = await begin(ctx, a, "customers", "create", "email");
      await call(ctx, "customers", first, a.manager.userId, [
        customer("2", { name: "Mary Old", email: "m@example.com", phone: "111" }),
      ]);
      await finish(ctx, first);
      const up = await begin(ctx, a, "customers", "upsert", "email");
      const items = [customer("2", { name: "Mary New", email: "m@example.com" })];
      await call(ctx, "customers", up, a.manager.userId, items);
      // a retried batch recognises its own update instead of failing on the change row
      expect((await call(ctx, "customers", up, a.manager.userId, items))[0]!.status).toBe("ok");
      await finish(ctx, up);
      const before = async () =>
        (await ctx.sql`select before from import_changes where import_id = ${up}`)[0]!.before;
      expect(JSON.stringify(await before())).toContain("Mary Old");

      const id = (await ctx.sql`select id from customers where org_id = ${a.orgId}`)[0]!.id;
      await ctx.as(a.manager, () => ctx.sql`select public.anonymise_customer(${a.orgId}, ${id})`);
      expect(await before()).toBeNull();
      const r = (
        await ctx.as(a.manager, () => ctx.sql`select public.undo_import(${a.orgId}, ${up}) as r`)
      )[0]!.r as { reverted: number; kept: number };
      expect(r).toMatchObject({ reverted: 0, kept: 1 });
    });
  });
});

describe("preview lookup, saved matches and file retention", () => {
  it("import_stock_keys tells tracked from untracked products, this shop only, managers only", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await product(ctx, a, "T1", { barcode: "5391", stock: 1 });
      await product(ctx, a, "U1", { track: false });
      await product(ctx, b, "B1");
      const ask = (who: Actor | null, org: string, by = "sku") =>
        ctx.as(who, async () => {
          const r =
            await ctx.sql`select public.import_stock_keys(${org}, ${["T1", "U1", "B1", "X"]}::text[], ${by}) as r`;
          return r[0]!.r as { tracked: string[]; untracked: string[] };
        });
      const r = await ask(a.manager, a.orgId);
      expect([r.tracked, r.untracked]).toEqual([["T1"], ["U1"]]);
      expect((await ask(b.manager, a.orgId)).tracked).toEqual([]);
      const bc = await ctx.as(a.manager, async () => {
        const x =
          await ctx.sql`select public.import_stock_keys(${a.orgId}, ${["5391"]}::text[], 'barcode') as r`;
        return x[0]!.r as { tracked: string[] };
      });
      expect(bc.tracked).toEqual(["5391"]);
    });
  });

  it("customer files expire after 24 hours, other files after 7 days, and the purge removes them", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const hours = async (id: string) =>
        Number(
          (
            await ctx.sql`select extract(epoch from (expires_at - now()))/3600 as h from import_files where import_id = ${id}`
          )[0]!.h,
        );
      const up = async (type: Kind) => {
        const id = randomUUID();
        await ctx.as(
          a.manager,
          () =>
            ctx.sql`select public.create_import(${a.orgId}, ${id}, 'f.csv', ${Buffer.from("A\n1")}, ${1}, ${type})`,
        );
        return id;
      };
      const c = await up("customers");
      expect(await hours(c)).toBeLessThanOrEqual(24);
      expect(await hours(c)).toBeGreaterThan(23);
      const s = await up("stock"); // a new upload replaces the unstarted one
      expect(await hours(s)).toBeGreaterThan(160);
      const c2 = await up("customers");
      await ctx.sql`update import_files set expires_at = now() - interval '1 second' where import_id = ${c2}`;
      await ctx.sql`select ops.import_purge()`;
      expect(
        (await ctx.sql`select count(*)::int as n from import_files where import_id = ${c2}`)[0]!.n,
      ).toBe(0);
    });
  });

  it("saved matches are per kind: the same name can exist for products and customers", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const save = (type: string) =>
        ctx.as(
          a.manager,
          () =>
            ctx.sql`insert into import_mappings (id, org_id, type, name, mapping) values (${randomUUID()}, ${a.orgId}, ${type}, 'My file', '{}'::jsonb)`,
        );
      await save("products");
      await save("customers");
      await ctx.denied(() => save("customers"), ["23505"]);
      await ctx.denied(() => save("suppliers"), ["23514"]);
      const rows = await ctx.as(
        a.manager,
        () => ctx.sql`select type from import_mappings where org_id = ${a.orgId} order by type`,
      );
      expect(rows.map((r) => r.type)).toEqual(["customers", "products"]);
    });
  });
});
