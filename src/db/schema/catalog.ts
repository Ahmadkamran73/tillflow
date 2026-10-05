import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { organisations } from "./tenancy";

/** Register tiles and report groups. Starter rows come from the business-type preset. */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    colour: text("colour"),
    sort: integer("sort").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("categories_org_name_key").on(t.orgId, t.name),
    // Target for composite FKs so a child can never point at another org's category.
    unique("categories_org_id_id_key").on(t.orgId, t.id),
    foreignKey({
      name: "categories_org_parent_fk",
      columns: [t.orgId, t.parentId],
      foreignColumns: [t.orgId, t.id],
    }),
    index("categories_org_sort_idx").on(t.orgId, t.sort),
    index("categories_org_parent_idx").on(t.orgId, t.parentId),
    check("categories_colour_hex", sql`${t.colour} is null or ${t.colour} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
);

export type Category = typeof categories.$inferSelect;

const colour = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export const categoryInsertInput = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  name: z.string().trim().min(1).max(60),
  parentId: z.uuid().nullish(),
  colour: colour.nullish(),
  sort: z.int().min(0).max(10_000).default(0),
});
export const categoryUpdateInput = categoryInsertInput.omit({ id: true, orgId: true }).partial();
