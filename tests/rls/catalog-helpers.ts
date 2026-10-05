import { randomUUID } from "node:crypto";
import type { Ctx } from "./helpers";

export async function seedProduct({ sql }: Ctx, orgId: string, barcode: string | null = null) {
  const pid = randomUUID();
  const vid = randomUUID();
  await sql`insert into products (id, org_id, name, tax_category) values (${pid}, ${orgId}, 'Tea', 'STANDARD')`;
  await sql`insert into variants (id, org_id, product_id, price_incl_vat_cents, barcode)
            values (${vid}, ${orgId}, ${pid}, 350, ${barcode})`;
  return { pid, vid };
}

export async function seedGroup({ sql }: Ctx, orgId: string, name = "Milk") {
  const gid = randomUUID();
  const oid = randomUUID();
  await sql`insert into modifier_groups (id, org_id, name) values (${gid}, ${orgId}, ${name})`;
  await sql`insert into modifiers (id, org_id, group_id, name, price_delta_cents) values (${oid}, ${orgId}, ${gid}, 'Oat', 50)`;
  return { gid, oid };
}

/** A save_product payload: two variants, the first with 5 opening stock. */
export const payload = (orgId: string, locationId: string) => ({
  org_id: orgId,
  location_id: locationId,
  product: {
    id: randomUUID(),
    name: "Tee",
    category_id: null as string | null,
    tax_category: "STANDARD",
    takeaway_tax_category: null as string | null,
    track_stock: true,
  },
  variants: [
    {
      id: randomUUID(),
      name: "M / Black",
      barcode: "111",
      price_incl_vat_cents: 1230,
      attributes: { size: "M", colour: "Black" },
      opening_stock: 5,
    },
    { id: randomUUID(), name: "L / Black", barcode: "222", price_incl_vat_cents: 1230 },
  ],
  modifier_group_ids: [] as string[],
});
