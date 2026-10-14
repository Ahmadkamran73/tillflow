// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql, type Actor, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);

/** Upload + confirm + start a supplier import, as the manager; returns the import id. */
async function begin(ctx: Ctx, shop: Shop, mode = "create", actor: Actor = shop.manager) {
  const id = randomUUID();
  await ctx.as(
    actor,
    () =>
      ctx.sql`select public.create_import(${shop.orgId}, ${id}, 'f.csv', ${Buffer.from("A\n1")}, ${1}, 'suppliers')`,
  );
  await ctx.as(
    actor,
    () =>
      ctx.sql`select public.confirm_import(${shop.orgId}, ${id}, ${mode}, 'name', ${json(ctx, { name: "Name" })})`,
  );
  const r = (await ctx.sql`select ops.import_begin(${id}, ${actor.userId}) as r`)[0]!.r as {
    org_id: string;
    type: string;
  } | null;
  expect(r).toMatchObject({ org_id: shop.orgId, type: "suppliers" });
  return id;
}

type Result = { ref: string; status: string; code?: string }[];
const apply = async (ctx: Ctx, id: string, user: string, items: unknown[]) =>
  (
    await ctx.sql`select ops.import_apply_suppliers(${json(ctx, { import_id: id, user_id: user, items })}) as r`
  )[0]!.r as Result;
const finish = (ctx: Ctx, id: string) =>
  ctx.sql`select ops.import_finish(${id}, true, 0, '[]'::jsonb, null)`;
const job = async (ctx: Ctx, id: string) =>
  (await ctx.sql`select * from import_jobs where id = ${id}`)[0]!;

const supplier = (ref: string, fields: Record<string, unknown>, set: string[] = []) => ({
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
const all = (ctx: Ctx, org: string) =>
  ctx.sql`select * from suppliers where org_id = ${org} order by name`;

describe("supplier import", () => {
  it("creates suppliers with the contact rules; a bad row fails alone", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a);
      const res = await apply(ctx, id, a.manager.userId, [
        supplier("2", {
          name: "Dairy Direct Ltd",
          email: "Orders@Dairy.example",
          phone: "021 123",
        }),
        supplier("3", { name: "Walk-in Wholesale" }),
        supplier("4", { name: "Bad", email: "not-an-email" }),
        supplier("5", { name: "" }),
      ]);
      expect(res.map((r) => r.status)).toEqual(["ok", "ok", "error", "error"]);
      await finish(ctx, id);
      const rows = await all(ctx, a.orgId);
      expect(rows.map((r) => r.name)).toEqual(["Dairy Direct Ltd", "Walk-in Wholesale"]);
      expect(rows[0]!.email).toBe("orders@dairy.example");
      expect(await job(ctx, id)).toMatchObject({ status: "done", created_count: 2 });
    });
  });

  it("create-only skips an existing name (any case); update changes only the fields given; undo restores", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const first = await begin(ctx, a);
      await apply(ctx, first, a.manager.userId, [
        supplier("2", {
          name: "Acme Foods",
          email: "a@acme.example",
          phone: "111",
          notes: "keep me",
        }),
      ]);
      await finish(ctx, first);

      const skip = await begin(ctx, a, "create");
      await apply(ctx, skip, a.manager.userId, [
        supplier("2", { name: "ACME FOODS", phone: "999" }),
      ]);
      await finish(ctx, skip);
      expect(await job(ctx, skip)).toMatchObject({ created_count: 0, skipped_count: 1 });
      expect((await all(ctx, a.orgId))[0]!.phone).toBe("111");

      const up = await begin(ctx, a, "upsert");
      const items = [supplier("2", { name: "Acme Foods Ltd", phone: "222" }, ["phone"])];
      // a different spelling is a different supplier: it is created, not matched
      await apply(ctx, up, a.manager.userId, items);
      const items2 = [supplier("3", { name: "acme foods", phone: "222" }, ["phone"])];
      await apply(ctx, up, a.manager.userId, items2);
      expect((await apply(ctx, up, a.manager.userId, items2))[0]!.status).toBe("ok"); // retry
      await finish(ctx, up);
      const acme = (await all(ctx, a.orgId)).find((r) => r.email === "a@acme.example")!;
      expect(acme).toMatchObject({ name: "acme foods", phone: "222", notes: "keep me" });
      expect(await job(ctx, up)).toMatchObject({ created_count: 1, updated_count: 1 });

      await ctx.as(a.manager, () => ctx.sql`select public.undo_import(${a.orgId}, ${up})`);
      const rows = await all(ctx, a.orgId);
      expect(rows.find((r) => r.id === acme.id)).toMatchObject({
        name: "Acme Foods",
        phone: "111",
      });
      expect(rows.filter((r) => r.archived_at === null)).toHaveLength(1);
      expect(rows.filter((r) => r.archived_at !== null)).toHaveLength(1); // "Acme Foods Ltd", kept, archived
    });
  });

  it("undo archives what was created (the row stays) and reports an already archived one as kept", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a);
      await apply(ctx, id, a.manager.userId, [
        supplier("2", { name: "One" }),
        supplier("3", { name: "Two" }),
      ]);
      await finish(ctx, id);
      const one = (await all(ctx, a.orgId)).find((r) => r.name === "One")!;
      await ctx.sql`update suppliers set archived_at = now() where id = ${one.id}`;
      const r = (
        await ctx.as(a.manager, () => ctx.sql`select public.undo_import(${a.orgId}, ${id}) as r`)
      )[0]!.r as { reverted: number; kept: number };
      expect(r).toMatchObject({ reverted: 1, kept: 1 });
      expect((await all(ctx, a.orgId)).every((x) => x.archived_at !== null)).toBe(true);
    });
  });

  it("a retried batch creates nothing twice; the same name in another shop is not a match", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const idB = await begin(ctx, b);
      await apply(ctx, idB, b.manager.userId, [supplier("2", { name: "Shared Name", phone: "B" })]);
      await finish(ctx, idB);

      const id = await begin(ctx, a, "upsert");
      const items = [supplier("2", { name: "Shared Name", phone: "A" }, ["phone"])];
      await apply(ctx, id, a.manager.userId, items);
      await apply(ctx, id, a.manager.userId, items);
      await finish(ctx, id);
      expect((await all(ctx, a.orgId)).map((r) => r.phone)).toEqual(["A"]);
      expect((await all(ctx, b.orgId)).map((r) => r.phone)).toEqual(["B"]);
    });
  });

  it("names are unique per shop among suppliers not archived; managers can read but not write directly", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await begin(ctx, a);
      await apply(ctx, id, a.manager.userId, [supplier("2", { name: "Only One" })]);
      await finish(ctx, id);
      await ctx.denied(
        () =>
          ctx.sql`insert into suppliers (id, org_id, name) values (${randomUUID()}, ${a.orgId}, ' only one ')`,
        ["23505"],
      );
      const read = async (who: Actor | null, org: string) =>
        ctx.as(who, () => ctx.sql`select id from suppliers where org_id = ${org}`);
      expect(await read(a.manager, a.orgId)).toHaveLength(1);
      expect(await read(a.owner, a.orgId)).toHaveLength(1);
      expect(await read(a.cashier, a.orgId)).toHaveLength(0);
      expect(await read(b.manager, a.orgId)).toHaveLength(0);
      for (const who of [a.owner, a.manager, a.cashier]) {
        await ctx.denied(() =>
          ctx.as(
            who,
            () =>
              ctx.sql`insert into suppliers (id, org_id, name) values (${randomUUID()}, ${a.orgId}, 'X')`,
          ),
        );
        await ctx.denied(() => ctx.as(who, () => ctx.sql`update suppliers set name = 'Y'`));
        await ctx.denied(() => ctx.as(who, () => ctx.sql`delete from suppliers`));
      }
      await ctx.denied(() => ctx.as(null, () => ctx.sql`select id from suppliers`));
    });
  });

  it("import_existing_supplier_names answers managers of that shop only", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await begin(ctx, a);
      await apply(ctx, id, a.manager.userId, [supplier("2", { name: "Known Ltd" })]);
      await finish(ctx, id);
      const ask = (who: Actor | null, org: string) =>
        ctx.as(who, async () => {
          const r =
            await ctx.sql`select public.import_existing_supplier_names(${org}, ${["known ltd", "nope"]}::text[]) as r`;
          return r[0]!.r as string[];
        });
      expect(await ask(a.manager, a.orgId)).toEqual(["known ltd"]);
      expect(await ask(a.cashier, a.orgId)).toEqual([]);
      expect(await ask(b.manager, a.orgId)).toEqual([]);
      await ctx.denied(() => ask(null, a.orgId));
    });
  });

  it("settings: mode and key must belong to suppliers; the file expires in 24 hours", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = randomUUID();
      await ctx.as(
        a.manager,
        () =>
          ctx.sql`select public.create_import(${a.orgId}, ${id}, 'f.csv', ${Buffer.from("A\n1")}, ${1}, 'suppliers')`,
      );
      const hours = Number(
        (
          await ctx.sql`select extract(epoch from (expires_at - now()))/3600 as h from import_files where import_id = ${id}`
        )[0]!.h,
      );
      expect(hours).toBeGreaterThan(23);
      expect(hours).toBeLessThanOrEqual(24);
      const confirm = (mode: string, key: string) =>
        ctx.as(
          a.manager,
          () =>
            ctx.sql`select public.confirm_import(${a.orgId}, ${id}, ${mode}, ${key}, ${json(ctx, { name: "N" })})`,
        );
      await ctx.denied(() => confirm("count", "name"), ["22023"]);
      await ctx.denied(() => confirm("create", "email"), ["22023"]);
      await ctx.denied(() => confirm("create", "sku"), ["22023"]);
      await confirm("upsert", "name");
    });
  });

  it("the writer refuses other import types, a demoted creator and every role but the job's", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await begin(ctx, a);
      await ctx.denied(() => apply(ctx, id, randomUUID(), []), ["42501"]);
      for (const who of [a.owner, a.manager, a.cashier, null]) {
        await ctx.denied(() =>
          ctx.as(
            who,
            () =>
              ctx.sql`select ops.import_apply_suppliers(${json(ctx, { import_id: id, user_id: a.manager.userId, items: [] })})`,
          ),
        );
      }
      await finish(ctx, id);
      // other writers refuse a suppliers import
      const c = await begin(ctx, a);
      await ctx.denied(
        () =>
          ctx.sql`select ops.import_apply_customers(${json(ctx, { import_id: c, user_id: a.manager.userId, items: [] })})`,
        ["55000"],
      );
      await ctx.denied(
        () =>
          ctx.sql`select ops.import_apply_stock(${json(ctx, { import_id: c, user_id: a.manager.userId, items: [] })})`,
        ["55000"],
      );
      await ctx.denied(
        () =>
          ctx.sql`select ops.import_apply_batch(${json(ctx, { import_id: c, user_id: a.manager.userId, items: [] })})`,
        ["55000"],
      );
      await ctx.sql`update memberships set role = 'cashier' where org_id = ${a.orgId} and user_id = ${a.manager.userId}`;
      await ctx.denied(() => apply(ctx, c, a.manager.userId, []), ["42501"]);
    });
  });

  it("cashiers and other shops cannot upload or undo a supplier import", async () => {
    await inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      for (const who of [a.cashier, b.manager]) {
        await ctx.denied(() =>
          ctx.as(
            who,
            () =>
              ctx.sql`select public.create_import(${a.orgId}, ${randomUUID()}, 'f.csv', ${Buffer.from("A\n1")}, ${1}, 'suppliers')`,
          ),
        );
      }
      const id = await begin(ctx, a);
      await finish(ctx, id);
      for (const who of [a.cashier, b.manager, b.owner, null]) {
        await ctx.denied(() =>
          ctx.as(who, () => ctx.sql`select public.undo_import(${a.orgId}, ${id})`),
        );
      }
    });
  });
});

describe("supplier import: personal data does not outlive its use", () => {
  it("undo scrubs a created supplier, and the purge clears old values once the window has passed", async () => {
    await inWorld(async (ctx) => {
      const { a } = ctx.world;
      const first = await begin(ctx, a);
      await apply(ctx, first, a.manager.userId, [
        supplier("2", { name: "Old Trader", email: "t@trader.example", phone: "111" }),
      ]);
      await finish(ctx, first);
      const up = await begin(ctx, a, "upsert");
      await apply(ctx, up, a.manager.userId, [
        supplier("2", { name: "Old Trader", phone: "222" }, ["phone"]),
        supplier("3", { name: "New Trader", email: "n@trader.example", notes: "n" }),
      ]);
      await finish(ctx, up);
      const before = async () =>
        (
          await ctx.sql`select count(*)::int as n from import_changes where import_id = ${up} and before is not null`
        )[0]!.n;
      expect(await before()).toBe(1);

      // the window has not passed: the purge keeps them
      await ctx.sql`select ops.import_purge()`;
      expect(await before()).toBe(1);
      // once it has, the old values go
      await ctx.sql`update import_jobs set undo_until = now() - interval '1 minute' where id = ${up}`;
      await ctx.sql`select ops.import_purge()`;
      expect(await before()).toBe(0);

      // undo (on a fresh import, still inside its window) scrubs the supplier it created
      const again = await begin(ctx, a);
      await apply(ctx, again, a.manager.userId, [
        supplier("2", { name: "Temp Trader", email: "x@trader.example", phone: "9" }),
      ]);
      await finish(ctx, again);
      await ctx.as(a.manager, () => ctx.sql`select public.undo_import(${a.orgId}, ${again})`);
      const gone = (await all(ctx, a.orgId)).find(
        (r) => r.archived_at !== null && r.name === "Deleted supplier",
      );
      expect(gone).toMatchObject({
        email: null,
        phone: null,
        vat_number: null,
        address: null,
        notes: null,
      });
      expect((await all(ctx, a.orgId)).some((r) => r.name === "Temp Trader")).toBe(false);
    });
  });
});
