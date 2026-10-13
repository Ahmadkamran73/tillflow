// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql, type Actor, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);

type Opts = {
  sku?: string | null;
  barcode?: string | null;
  price?: number;
  stock?: number;
  cost?: number;
  category?: string;
  tax?: string;
  taxSet?: boolean;
  attrs?: Record<string, unknown>;
  attrSet?: string[];
};
const item = (ref: string, o: Opts = {}) => {
  const pid = randomUUID();
  return {
    ref,
    rows: [Number(ref)],
    category: o.category ?? null,
    product: {
      id: pid,
      name: `Item ${ref}`,
      tax_category: o.tax ?? "STANDARD",
      tax_set: o.taxSet ?? false,
      track_set: false,
      takeaway_tax_category: null,
      track_stock: true,
    },
    variants: [
      {
        id: randomUUID(),
        name: "",
        sku: o.sku ?? null,
        barcode: o.barcode ?? null,
        price_incl_vat_cents: o.price ?? 250,
        cost_cents: o.cost ?? null,
        attributes: o.attrs ?? {},
        attr_set: o.attrSet ?? [],
        sort: 0,
        opening_stock: o.stock ?? 0,
      },
    ],
  };
};

/** Upload + confirm + start, as the manager; returns the import id. */
async function begin(
  ctx: Ctx,
  shop: Shop,
  mode: "create" | "upsert" = "create",
  key = "sku",
  total = 1,
  actor: Actor = shop.manager,
) {
  const id = randomUUID();
  await ctx.as(
    actor,
    () =>
      ctx.sql`select public.create_import(${shop.orgId}, ${id}, 'f.csv', ${Buffer.from("Name,Price\nA,1")}, ${total})`,
  );
  await ctx.as(
    actor,
    () =>
      ctx.sql`select public.confirm_import(${shop.orgId}, ${id}, ${mode}, ${key}, ${json(ctx, { name: "Name" })})`,
  );
  const r = (await ctx.sql`select ops.import_begin(${id}, ${actor.userId}) as r`)[0]!.r as {
    org_id: string;
  } | null;
  expect(r?.org_id).toBe(shop.orgId);
  return id;
}

type Result = { ref: string; status: string; code?: string }[];
const apply = async (ctx: Ctx, id: string, user: string, items: unknown[]) =>
  (
    await ctx.sql`select ops.import_apply_batch(${json(ctx, { import_id: id, user_id: user, items })}) as r`
  )[0]!.r as Result;
const finish = (ctx: Ctx, id: string) =>
  ctx.sql`select ops.import_finish(${id}, true, 0, '[]'::jsonb, null)`;
const job = async (ctx: Ctx, id: string) =>
  (await ctx.sql`select * from import_jobs where id = ${id}`)[0]!;
const variantBy = async (ctx: Ctx, org: string, sku: string) =>
  (await ctx.sql`select * from variants where org_id = ${org} and sku = ${sku}`)[0];

describe("bulk import", () => {
  it("creates products, categories, costs and opening stock, and records every change", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 2);
      const res = await apply(ctx, id, a.manager.userId, [
        item("2", { sku: "S1", barcode: "111", stock: 7, cost: 100, category: "Drinks" }),
        item("3", { sku: "S2", category: "Drinks" }),
      ]);
      expect(res.map((r) => r.status)).toEqual(["ok", "ok"]);
      await finish(ctx, id);

      const v = await variantBy(ctx, a.orgId, "S1");
      expect(v).toMatchObject({ barcode: "111", price_incl_vat_cents: 250 });
      expect(
        (await ctx.sql`select cost_cents from variant_costs where variant_id = ${v!.id}`)[0]!
          .cost_cents,
      ).toBe(100);
      expect(
        (await ctx.sql`select on_hand from stock_levels where variant_id = ${v!.id}`)[0]!.on_hand,
      ).toBe(7);
      expect(
        (
          await ctx.sql`select count(*)::int as n from categories where org_id = ${a.orgId} and name = 'Drinks'`
        )[0]!.n,
      ).toBe(1);
      const j = await job(ctx, id);
      expect(j).toMatchObject({
        status: "done",
        created_count: 2,
        updated_count: 0,
        skipped_count: 0,
      });
      expect(j.undo_until).not.toBeNull();
      expect(
        (await ctx.sql`select count(*)::int as n from import_changes where import_id = ${id}`)[0]!
          .n,
      ).toBe(2);
      expect(
        (
          await ctx.sql`select count(*)::int as n from audit_log where entity = 'import' and entity_id = ${id}`
        )[0]!.n,
      ).toBeGreaterThanOrEqual(3);
    });
  });

  it("imports a full batch of 500 products (the 10,000-row path is in import-job.test.ts; a long transaction here would block other files)", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 500);
      for (let i = 0; i < 500; i += 500) {
        const items = Array.from({ length: 500 }, (_, k) =>
          item(String(i + k + 2), { sku: `K${i + k}`, barcode: `B${i + k}`, stock: 1 }),
        );
        const res = await apply(ctx, id, a.manager.userId, items);
        expect(res.every((r) => r.status === "ok")).toBe(true);
      }
      await finish(ctx, id);
      const j = await job(ctx, id);
      expect(j).toMatchObject({ created_count: 500, processed_rows: 500, status: "done" });
      expect(
        (await ctx.sql`select count(*)::int as n from variants where org_id = ${a.orgId}`)[0]!.n,
      ).toBe(500);
    });
  }, 180_000);

  it("rejects a duplicate barcode for that item only, leaving nothing of it behind", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const first = await begin(ctx, a, "create", "sku", 1);
      await apply(ctx, first, a.manager.userId, [item("2", { sku: "OLD", barcode: "555" })]);
      await finish(ctx, first);

      const id = await begin(ctx, a, "create", "sku", 3);
      const clash = item("3", { sku: "NEW1", barcode: "555" });
      const res = await apply(ctx, id, a.manager.userId, [
        item("2", { sku: "NEW0" }),
        clash,
        item("4", { sku: "NEW2" }),
      ]);
      expect(res.map((r) => r.status)).toEqual(["ok", "error", "ok"]);
      expect(res[1]!.code).toBe("23505");
      expect(await variantBy(ctx, a.orgId, "NEW1")).toBeUndefined();
      expect(
        (await ctx.sql`select count(*)::int as n from products where id = ${clash.product.id}`)[0]!
          .n,
      ).toBe(0);
      expect(await variantBy(ctx, a.orgId, "NEW2")).toBeDefined();
      // Another shop may use the same barcode.
      const other = await begin(ctx, b, "create", "sku", 1, b.manager);
      const r2 = await apply(ctx, other, b.manager.userId, [
        item("2", { sku: "OLD", barcode: "555" }),
      ]);
      expect(r2[0]!.status).toBe("ok");
    });
  });

  it("create-only skips products that exist; create-and-update changes them and keeps their stock", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const seed = await begin(ctx, a, "create", "sku", 1);
      await apply(ctx, seed, a.manager.userId, [
        item("2", { sku: "X", price: 300, stock: 9, cost: 120, category: "Old" }),
      ]);
      await finish(ctx, seed);
      const existing = (await variantBy(ctx, a.orgId, "X"))!;

      const skip = await begin(ctx, a, "create", "sku", 2);
      await apply(ctx, skip, a.manager.userId, [
        item("2", { sku: "X", price: 999 }),
        item("3", { sku: "Y" }),
      ]);
      await finish(ctx, skip);
      expect(await job(ctx, skip)).toMatchObject({
        created_count: 1,
        updated_count: 0,
        skipped_count: 1,
      });
      expect((await variantBy(ctx, a.orgId, "X"))!.price_incl_vat_cents).toBe(300);

      const up = await begin(ctx, a, "upsert", "sku", 1);
      await apply(ctx, up, a.manager.userId, [
        item("2", { sku: "X", price: 999, stock: 50, category: "New" }),
      ]);
      await finish(ctx, up);
      expect(await job(ctx, up)).toMatchObject({ created_count: 0, updated_count: 1 });
      const after = (await variantBy(ctx, a.orgId, "X"))!;
      expect(after.id).toBe(existing.id);
      expect(after.price_incl_vat_cents).toBe(999);
      expect(
        (await ctx.sql`select on_hand from stock_levels where variant_id = ${after.id}`)[0]!
          .on_hand,
      ).toBe(9);
      expect(
        (await ctx.sql`select cost_cents from variant_costs where variant_id = ${after.id}`)[0]!
          .cost_cents,
      ).toBe(120);
    });
  });

  it("matches on barcode when asked", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const seed = await begin(ctx, a, "create", "barcode", 1);
      await apply(ctx, seed, a.manager.userId, [item("2", { barcode: "777", price: 100 })]);
      await finish(ctx, seed);
      const up = await begin(ctx, a, "upsert", "barcode", 1);
      await apply(ctx, up, a.manager.userId, [item("2", { barcode: "777", price: 150 })]);
      await finish(ctx, up);
      const rows =
        await ctx.sql`select price_incl_vat_cents from variants where org_id = ${a.orgId} and barcode = '777'`;
      expect(rows.map((r) => r.price_incl_vat_cents)).toEqual([150]);
    });
  });

  it("is safe to run a batch twice (a retried job)", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 2);
      const items = [item("2", { sku: "R1", stock: 4 }), item("3", { sku: "R2" })];
      await apply(ctx, id, a.manager.userId, items);
      await ctx.sql`select ops.import_begin(${id}, ${a.manager.userId})`; // a retry starts again
      const again = await apply(ctx, id, a.manager.userId, items);
      expect(again.every((r) => r.status === "ok")).toBe(true);
      await finish(ctx, id);
      expect(await job(ctx, id)).toMatchObject({ created_count: 2, updated_count: 0 });
      expect(
        (await ctx.sql`select count(*)::int as n from variants where org_id = ${a.orgId}`)[0]!.n,
      ).toBe(2);
      const v = (await variantBy(ctx, a.orgId, "R1"))!;
      expect(
        (await ctx.sql`select on_hand from stock_levels where variant_id = ${v.id}`)[0]!.on_hand,
      ).toBe(4);
    });
  });

  it("undo archives what was created, restores what was updated and reverses opening stock", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const seed = await begin(ctx, a, "create", "sku", 1);
      await apply(ctx, seed, a.manager.userId, [item("2", { sku: "KEEP", price: 300, cost: 100 })]);
      await finish(ctx, seed);

      const id = await begin(ctx, a, "upsert", "sku", 2);
      await apply(ctx, id, a.manager.userId, [
        item("2", { sku: "KEEP", price: 999, cost: 500 }),
        item("3", { sku: "NEWONE", barcode: "42", stock: 6 }),
      ]);
      await finish(ctx, id);

      const out = (
        await ctx.as(a.manager, () => ctx.sql`select public.undo_import(${a.orgId}, ${id}) as r`)
      )[0]!.r as { reverted: number; kept: number };
      expect(out).toEqual({ reverted: 2, kept: 0 });
      const keep = (await variantBy(ctx, a.orgId, "KEEP"))!;
      expect(keep.price_incl_vat_cents).toBe(300);
      expect(
        (await ctx.sql`select cost_cents from variant_costs where variant_id = ${keep.id}`)[0]!
          .cost_cents,
      ).toBe(100);
      const made = (
        await ctx.sql`select id, archived_at, sku, barcode from variants where org_id = ${a.orgId} and name = '' and archived_at is not null`
      )[0]!;
      expect(made.sku).toBeNull();
      expect(made.barcode).toBeNull();
      expect(
        (await ctx.sql`select on_hand from stock_levels where variant_id = ${made.id}`)[0]!.on_hand,
      ).toBe(0);
      expect((await job(ctx, id)).status).toBe("undone");
      // Rows are never deleted.
      expect(
        (await ctx.sql`select count(*)::int as n from variants where id = ${made.id}`)[0]!.n,
      ).toBe(1);
      // A second undo is refused, and the freed SKU can be used again.
      await ctx.denied(
        () => ctx.as(a.manager, () => ctx.sql`select public.undo_import(${a.orgId}, ${id})`),
        ["22023"],
      );
      const again = await begin(ctx, a, "create", "sku", 1);
      expect(
        (
          await apply(ctx, again, a.manager.userId, [item("2", { sku: "NEWONE", barcode: "42" })])
        )[0]!.status,
      ).toBe("ok");
    });
  });

  it("refuses an undo after 24 hours", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 1);
      await apply(ctx, id, a.manager.userId, [item("2", { sku: "OLDIE" })]);
      await finish(ctx, id);
      await ctx.sql`update import_jobs set undo_until = now() - interval '1 minute' where id = ${id}`;
      await ctx.denied(
        () => ctx.as(a.manager, () => ctx.sql`select public.undo_import(${a.orgId}, ${id})`),
        ["22023"],
      );
      expect(await variantBy(ctx, a.orgId, "OLDIE")).toBeDefined();
    });
  });

  it("keeps files 7 days: the purge removes expired ones only", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const old = await begin(ctx, a, "create", "sku", 1);
      await finish(ctx, old).catch(() => undefined);
      await ctx.sql`update import_jobs set status = 'done' where id = ${old}`;
      const fresh = randomUUID();
      await ctx.as(
        a.manager,
        () =>
          ctx.sql`select public.create_import(${a.orgId}, ${fresh}, 'g.csv', ${Buffer.from("x")}, 1)`,
      );
      await ctx.sql`update import_files set expires_at = now() - interval '1 second' where import_id = ${old}`;
      const n = (await ctx.sql`select ops.import_purge() as n`)[0]!.n as number;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(
        (await ctx.sql`select count(*)::int as n from import_files where import_id = ${old}`)[0]!.n,
      ).toBe(0);
      expect(
        (await ctx.sql`select count(*)::int as n from import_files where import_id = ${fresh}`)[0]!
          .n,
      ).toBe(1);
      expect(
        (
          await ctx.sql`select (expires_at > now() + interval '6 days') as ok from import_files where import_id = ${fresh}`
        )[0]!.ok,
      ).toBe(true);
    });
  });

  it("limits uploads: rows 1..50000 and one open import per shop", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const up = (total: number) =>
        ctx.as(
          a.manager,
          () =>
            ctx.sql`select public.create_import(${a.orgId}, ${randomUUID()}, 'f.csv', ${Buffer.from("x")}, ${total})`,
        );
      await ctx.denied(() => up(0), ["22023"]);
      await ctx.denied(() => up(50_001), ["22023"]);
      await begin(ctx, a, "create", "sku", 50_000); // queued
      await ctx.denied(() => up(5), ["55006"]);
    });
  });

  it("existing keys finds only this shop's active variants", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 1);
      await apply(ctx, id, a.manager.userId, [item("2", { sku: "HAVE", barcode: "123" })]);
      const found = (
        await ctx.as(
          a.manager,
          () =>
            ctx.sql`select public.import_existing_keys(${a.orgId}, ${["HAVE", "NOPE"]}::text[], ${["123", "999"]}::text[]) as r`,
        )
      )[0]!.r;
      expect(found).toEqual({ skus: ["HAVE"], barcodes: ["123"] });
      const other = (
        await ctx.as(
          b.manager,
          () =>
            ctx.sql`select public.import_existing_keys(${a.orgId}, ${["HAVE"]}::text[], ${["123"]}::text[]) as r`,
        )
      )[0]!.r;
      expect(other).toEqual({ skus: [], barcodes: [] });
    });
  });
});

describe("bulk import: who can do what", () => {
  it("only managers and owners of the shop can upload, confirm, read or undo", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 1);
      await apply(ctx, id, a.manager.userId, [item("2", { sku: "SEC" })]);
      await finish(ctx, id);

      const up = (actor: Actor | null, org: string) =>
        ctx.as(
          actor,
          () =>
            ctx.sql`select public.create_import(${org}, ${randomUUID()}, 'f.csv', ${Buffer.from("x")}, 1)`,
        );
      await ctx.denied(() => up(a.cashier, a.orgId));
      await ctx.denied(() => up(null, a.orgId));
      await ctx.denied(() => up(b.owner, a.orgId));
      await ctx
        .as(a.owner, () => up(a.owner, a.orgId).then(() => undefined))
        .catch(() => undefined);

      for (const who of [a.cashier, b.manager, b.owner, null]) {
        await ctx.denied(() =>
          ctx.as(who, () => ctx.sql`select public.get_import_file(${a.orgId}, ${id})`),
        );
        await ctx.denied(() =>
          ctx.as(who, () => ctx.sql`select public.undo_import(${a.orgId}, ${id})`),
        );
        await ctx.denied(() =>
          ctx.as(
            who,
            () =>
              ctx.sql`select public.confirm_import(${a.orgId}, ${id}, 'create', 'sku', '{}'::jsonb)`,
          ),
        );
      }
      // Reading: managers of the shop see it; others see nothing.
      expect(
        (await ctx.as(a.manager, () => ctx.sql`select id from import_jobs where id = ${id}`))
          .length,
      ).toBe(1);
      expect(
        (
          await ctx.as(
            a.owner,
            () => ctx.sql`select id from import_changes where import_id = ${id}`,
          )
        ).length,
      ).toBe(1);
      for (const who of [a.cashier, b.manager, b.owner]) {
        expect(
          (await ctx.as(who, () => ctx.sql`select id from import_jobs where id = ${id}`)).length,
        ).toBe(0);
        expect(
          (
            await ctx.as(
              who,
              () => ctx.sql`select import_id from import_changes where import_id = ${id}`,
            )
          ).length,
        ).toBe(0);
      }
      await ctx.denied(() => ctx.as(null, () => ctx.sql`select id from import_jobs`));
    });
  });

  it("nobody can read or change the stored file directly, and jobs cannot be edited", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 1);
      for (const who of [a.owner, a.manager, a.cashier]) {
        await ctx.denied(() => ctx.as(who, () => ctx.sql`select bytes from import_files`));
        await ctx.denied(() => ctx.as(who, () => ctx.sql`delete from import_files`));
        await ctx.denied(() =>
          ctx.as(who, () => ctx.sql`update import_jobs set status = 'done' where id = ${id}`),
        );
        await ctx.denied(() =>
          ctx.as(who, () => ctx.sql`delete from import_jobs where id = ${id}`),
        );
        await ctx.denied(() =>
          ctx.as(
            who,
            () =>
              ctx.sql`insert into import_jobs (id, org_id, created_by, file_name, batch_id) values (${randomUUID()}, ${a.orgId}, ${who.userId}, 'x', ${randomUUID()})`,
          ),
        );
        await ctx.denied(() =>
          ctx.as(
            who,
            () =>
              ctx.sql`insert into import_changes (id, org_id, import_id, variant_id, action) values (${randomUUID()}, ${a.orgId}, ${id}, ${randomUUID()}, 'created')`,
          ),
        );
      }
      // The file is readable through the role-checked function by a manager only.
      const bytes = (
        await ctx.as(
          a.manager,
          () => ctx.sql`select public.get_import_file(${a.orgId}, ${id}) as b`,
        )
      )[0]!.b as Buffer;
      expect(bytes.toString()).toBe("Name,Price\nA,1");
    });
  });

  it("clients cannot call the ops functions at all", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 1);
      await ctx.denied(() =>
        ctx.as(a.owner, () => ctx.sql`select ops.import_begin(${id}, ${a.owner.userId})`),
      );
      await ctx.denied(() =>
        ctx.as(
          a.owner,
          () =>
            ctx.sql`select ops.import_apply_batch(${json(ctx, { import_id: id, user_id: a.owner.userId, items: [] })})`,
        ),
      );
      await ctx.denied(() => ctx.as(a.owner, () => ctx.sql`select ops.import_file(${id})`));
      await ctx.denied(() => ctx.as(a.owner, () => ctx.sql`select ops.import_purge()`));
      await ctx.denied(() =>
        ctx.as(a.owner, () => ctx.sql`select ops.import_finish(${id}, true, 0, '[]'::jsonb, null)`),
      );
    });
  });

  it("the job cannot write as someone who is not a manager of the import's shop", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 1);
      for (const user of [a.cashier.userId, b.manager.userId, randomUUID()]) {
        await ctx.denied(() => apply(ctx, id, user, [item("2", { sku: "EVIL" })]), ["42501"]);
      }
      expect(await variantBy(ctx, a.orgId, "EVIL")).toBeUndefined();
      // A queued import started by someone other than its creator is refused too.
      await ctx.sql`update import_jobs set status = 'done' where id = ${id}`;
      const queued = await (async () => {
        const q = randomUUID();
        await ctx.as(a.manager, () => ctx.sql`select public.create_import(${a.orgId}, ${q}, 'f.csv', ${Buffer.from("x")}, 1)`);
        await ctx.as(a.manager, () => ctx.sql`select public.confirm_import(${a.orgId}, ${q}, 'create', 'sku', '{}'::jsonb)`);
        return q;
      })();
      await ctx.denied(() => ctx.sql`select ops.import_begin(${queued}, ${b.manager.userId})`, ["42501"]);
      await ctx.denied(() => ctx.sql`select ops.import_begin(${queued}, ${a.cashier.userId})`, ["42501"]);
      // A demoted creator cannot run it either.
      await ctx.sql`update import_jobs set status = 'running' where id = ${queued}`;
      await ctx.sql`update memberships set role = 'cashier' where user_id = ${a.manager.userId}`;
      await ctx.denied(
        () => apply(ctx, queued, a.manager.userId, [item("2", { sku: "EVIL2" })]),
        ["42501"],
      );
    });
  });

  it("batches are bounded and items cannot name another shop's ids", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 1);
      await ctx.denied(
        () =>
          apply(
            ctx,
            id,
            a.manager.userId,
            Array.from({ length: 501 }, (_, i) => item(String(i + 2))),
          ),
        ["22023"],
      );

      // A product id that already belongs to Shop B is not touched: the item is simply an error or creates its own variant under Shop A.
      const theirs = randomUUID();
      await ctx.sql`insert into products (id, org_id, name, tax_category) values (${theirs}, ${b.orgId}, 'B product', 'STANDARD')`;
      const sneaky = item("2", { sku: "SNEAK" });
      sneaky.product.id = theirs;
      const res = await apply(ctx, id, a.manager.userId, [sneaky]);
      expect(res[0]!.status).toBe("error");
      expect((await ctx.sql`select name from products where id = ${theirs}`)[0]!.name).toBe(
        "B product",
      );
      expect(await variantBy(ctx, a.orgId, "SNEAK")).toBeUndefined();
    });
  });

  it("saved mappings belong to the shop's managers", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const mid = randomUUID();
      await ctx.as(
        a.manager,
        () =>
          ctx.sql`insert into import_mappings (id, org_id, name, mapping) values (${mid}, ${a.orgId}, 'Square', ${json(ctx, { name: "Item Name" })})`,
      );
      await ctx.denied(
        () =>
          ctx.as(
            a.manager,
            () =>
              ctx.sql`insert into import_mappings (id, org_id, name, mapping) values (${randomUUID()}, ${a.orgId}, 'Square', '{}'::jsonb)`,
          ),
        ["23505"],
      );
      await ctx.denied(() =>
        ctx.as(
          a.cashier,
          () =>
            ctx.sql`insert into import_mappings (id, org_id, name, mapping) values (${randomUUID()}, ${a.orgId}, 'X', '{}'::jsonb)`,
        ),
      );
      await ctx.denied(() =>
        ctx.as(
          b.manager,
          () =>
            ctx.sql`insert into import_mappings (id, org_id, name, mapping) values (${randomUUID()}, ${a.orgId}, 'X', '{}'::jsonb)`,
        ),
      );
      await ctx.denied(() =>
        ctx.as(a.manager, () => ctx.sql`update import_mappings set name = 'Y' where id = ${mid}`),
      );
      for (const who of [a.cashier, b.manager, b.owner]) {
        expect((await ctx.as(who, () => ctx.sql`select id from import_mappings`)).length).toBe(0);
        await ctx.as(who, () => ctx.sql`delete from import_mappings where id = ${mid}`);
      }
      expect(
        (await ctx.sql`select count(*)::int as n from import_mappings where id = ${mid}`)[0]!.n,
      ).toBe(1);
      await ctx.as(a.owner, () => ctx.sql`delete from import_mappings where id = ${mid}`);
      expect(
        (await ctx.sql`select count(*)::int as n from import_mappings where id = ${mid}`)[0]!.n,
      ).toBe(0);
    });
  });
});
describe("bulk import: audit fixes", () => {
  it("an update changes only what the file gave: VAT, SKU/barcode and attributes are kept", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const seed = await begin(ctx, a, "create", "barcode", 1);
      await apply(ctx, seed, a.manager.userId, [
        item("2", {
          sku: "KEEPSKU",
          barcode: "888",
          tax: "ZERO",
          taxSet: true,
          attrs: { ageRestricted: true, depositCents: 15 },
          attrSet: ["ageRestricted", "depositCents"],
        }),
      ]);
      await finish(ctx, seed);
      const up = await begin(ctx, a, "upsert", "barcode", 1);
      // The file has a barcode and a price only: the default VAT and attributes must not leak in.
      await apply(ctx, up, a.manager.userId, [
        item("2", {
          barcode: "888",
          price: 777,
          tax: "STANDARD",
          attrs: { ageRestricted: false, depositCents: 0 },
        }),
      ]);
      await finish(ctx, up);
      const v = (await variantBy(ctx, a.orgId, "KEEPSKU"))!;
      expect(v.price_incl_vat_cents).toBe(777);
      expect(v.attributes).toEqual({ ageRestricted: true, depositCents: 15 });
      expect(
        (
          await ctx.sql`select tax_category from products where id = ${v.product_id}`
        )[0]!.tax_category,
      ).toBe("ZERO");
      // When the file does give them, they change.
      const up2 = await begin(ctx, a, "upsert", "barcode", 1);
      await apply(ctx, up2, a.manager.userId, [
        item("2", {
          barcode: "888",
          tax: "REDUCED",
          taxSet: true,
          attrs: { depositCents: 25 },
          attrSet: ["depositCents"],
        }),
      ]);
      await finish(ctx, up2);
      const w = (await variantBy(ctx, a.orgId, "KEEPSKU"))!;
      expect(w.attributes).toEqual({ ageRestricted: true, depositCents: 25 });
      expect(
        (
          await ctx.sql`select tax_category from products where id = ${w.product_id}`
        )[0]!.tax_category,
      ).toBe("REDUCED");
    });
  });

  it("only the manager who uploaded can confirm; a second Start does not start it twice", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = randomUUID();
      const upload = (i: string) =>
        ctx.as(
          a.manager,
          () =>
            ctx.sql`select public.create_import(${a.orgId}, ${i}, 'f.csv', ${Buffer.from("x")}, 1)`,
        );
      const confirm = (who: Actor, i: string, mapping: unknown = {}) =>
        ctx.as(
          who,
          () =>
            ctx.sql`select public.confirm_import(${a.orgId}, ${i}, 'create', 'sku', ${json(ctx, mapping)})`,
        );
      await upload(id);
      await ctx.denied(() => confirm(a.owner, id), ["22023"]);
      await confirm(a.manager, id);
      expect(
        (
          await ctx.sql`select ops.import_begin(${id}, ${a.manager.userId}) as r`
        )[0]!.r,
      ).not.toBeNull();
      expect(
        (
          await ctx.sql`select ops.import_begin(${id}, ${a.manager.userId}) as r`
        )[0]!.r,
      ).toBeNull();
      // Oversized mappings are refused.
      await ctx.sql`update import_jobs set status = 'failed' where id = ${id}`;
      const big = randomUUID();
      await upload(big);
      await ctx.denied(
        () => confirm(a.manager, big, { name: "x".repeat(9000) }),
        ["22023"],
      );
    });
  });

  it("a stuck import stops blocking after 2 hours, and a new upload replaces an unstarted one", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const stuck = await begin(ctx, a, "create", "sku", 1);
      await ctx.sql`update import_jobs set created_at = now() - interval '3 hours' where id = ${stuck}`;
      const up = (i: string) =>
        ctx.as(
          a.manager,
          () =>
            ctx.sql`select public.create_import(${a.orgId}, ${i}, 'f.csv', ${Buffer.from("x")}, 1)`,
        );
      const first = randomUUID();
      await up(first);
      expect((await job(ctx, stuck)).status).toBe("failed");
      await up(randomUUID());
      expect((await job(ctx, first)).status).toBe("failed");
      expect(
        (
          await ctx.sql`select count(*)::int as n from import_files where import_id = ${first}`
        )[0]!.n,
      ).toBe(0);
    });
  });

  it("keeps only the newest 10 files per shop, dropping the oldest instead of refusing", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const up = (i: string) =>
        ctx.as(a.manager, () => ctx.sql`select public.create_import(${a.orgId}, ${i}, 'f.csv', ${Buffer.from("x")}, 1)`);
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const id = randomUUID();
        ids.push(id);
        await up(id);
        await ctx.sql`update import_jobs set status = 'done' where id = ${id}`;
        // Older uploads expire first; space them out so the order is clear.
        await ctx.sql`update import_files set expires_at = now() + interval '7 days' + ${i} * interval '1 minute' where import_id = ${id}`;
      }
      const kept = (await ctx.sql`select import_id from import_files where org_id = ${a.orgId}`).map((r) => r.import_id as string);
      expect(kept).toHaveLength(10);
      expect(kept).not.toContain(ids[0]);
      expect(kept).not.toContain(ids[1]);
      expect(kept).toContain(ids[11]);
    });
  });

  it("ops.import_file gives the bytes only while running; a failed import can still be undone", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a, "create", "sku", 1);
      expect(
        (await ctx.sql`select ops.import_file(${id}) as b`)[0]!.b,
      ).not.toBeNull();
      await apply(ctx, id, a.manager.userId, [item("2", { sku: "PART" })]);
      await ctx.sql`select ops.import_finish(${id}, false, 0, '[]'::jsonb, 'unexpected_error')`;
      expect(
        (await ctx.sql`select ops.import_file(${id}) as b`)[0]!.b,
      ).toBeNull();
      const out = (
        await ctx.as(
          a.manager,
          () => ctx.sql`select public.undo_import(${a.orgId}, ${id}) as r`,
        )
      )[0]!.r as {
        reverted: number;
      };
      expect(out.reverted).toBe(1);
      expect(await variantBy(ctx, a.orgId, "PART")).toBeUndefined();
    });
  });
});
