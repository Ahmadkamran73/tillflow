import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { organisations } from "./tenancy";

/** Append-only. UPDATE/DELETE/TRUNCATE are revoked and blocked by trigger. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_org_created_idx").on(t.orgId, t.createdAt),
    index("audit_log_org_entity_idx").on(t.orgId, t.entity, t.entityId),
  ],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;

export const auditLogInsertInput = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  actorUserId: z.uuid().nullable(),
  action: z.string().trim().min(1).max(100),
  entity: z.string().trim().min(1).max(100),
  entityId: z.uuid().nullish(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  ip: z.string().max(45).nullish(),
});
