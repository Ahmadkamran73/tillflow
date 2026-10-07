import { config } from "dotenv";
import { createHash, randomUUID } from "node:crypto";
import postgres, { type TransactionSql } from "postgres";
import { expect } from "vitest";

config({ path: ".env.local", quiet: true });

const url = process.env.DIRECT_URL;
if (!url) throw new Error("DIRECT_URL is not set (local Supabase, see .env.local)");

export const sql = postgres(url, { max: 4, onnotice: () => {} });

/**
 * LOCAL/CI ONLY. Lets the least-privilege role from migration 0008 log in and returns its URL.
 * The password is derived from the local connection string (stable across parallel test files,
 * never a literal); on staging/production the owner sets a real one in the SQL editor.
 */
export async function opsRoleUrl(): Promise<string> {
  const password = createHash("sha256").update(`tillflow_ops:${url}`).digest("hex");
  await sql.unsafe(`alter role tillflow_ops with login password '${password}'`);
  const u = new URL(url!);
  u.username = "tillflow_ops";
  u.password = password;
  return u.toString();
}

export type Role = "owner" | "manager" | "cashier";
export type Actor = { userId: string; role: Role };
export type Shop = {
  orgId: string;
  locationId: string;
  registerId: string;
  /** SHA-256 hex of the till's (made-up) device token, as stored on registers.device_token_hash. */
  tokenHash: string;
  owner: Actor;
  manager: Actor;
  cashier: Actor;
};
export type World = { a: Shop; b: Shop };

class Rollback extends Error {}

/** JWT session facts. Defaults to a fully verified (aal2) password session. */
export type Session = { aal?: "aal1" | "aal2"; amr?: { method: string }[] };

export type Ctx = ReturnType<typeof makeCtx>;

function makeCtx(tx: TransactionSql, world: World) {
  const claims = (userId: string, session: Session) =>
    JSON.stringify({
      sub: userId,
      role: "authenticated",
      aal: session.aal ?? "aal2",
      amr: session.amr ?? [],
    });

  return {
    /** The transaction connection. Tests must query through this (shadowing the module-level pool), never the pool. */
    sql: tx,
    world,
    /** Run fn as a signed-in user (RLS applies), then go back to the seeding superuser. */
    // Each call runs in a savepoint: if fn fails, the rollback also undoes SET LOCAL ROLE, and
    // the aborted transaction is never asked to run a "reset role" (which would raise 25P02).
    async as<T>(actor: Actor | null, fn: () => Promise<T>, session: Session = {}): Promise<T> {
      return tx.savepoint(async () => {
        if (actor) {
          await tx`select set_config('request.jwt.claims', ${claims(actor.userId, session)}, true)`;
          await tx.unsafe("set local role authenticated");
        } else {
          await tx`select set_config('request.jwt.claims', '', true)`;
          await tx.unsafe("set local role anon");
        }
        const result = await fn();
        await tx.unsafe("reset role");
        return result;
      }) as Promise<T>;
    },
    async asService<T>(fn: () => Promise<T>): Promise<T> {
      return tx.savepoint(async () => {
        await tx.unsafe("set local role service_role");
        const result = await fn();
        await tx.unsafe("reset role");
        return result;
      }) as Promise<T>;
    },
    /** The statement must be refused (privilege, RLS check, trigger or FK). Uses a savepoint so the tx survives. */
    async denied(fn: () => PromiseLike<unknown>, codes = ["42501", "23503"]) {
      let error: unknown;
      try {
        await tx.savepoint(async () => {
          await fn();
        });
      } catch (e) {
        error = e;
      }
      expect(error, "expected the statement to be refused").toBeDefined();
      expect(codes).toContain((error as { code?: string }).code);
    },
  };
}

async function seedShop(tx: TransactionSql, name: string): Promise<Shop> {
  const orgId = randomUUID();
  const locationId = randomUUID();
  const registerId = randomUUID();
  const actor = (role: Role): Actor => ({ userId: randomUUID(), role });
  const shop: Shop = {
    orgId,
    locationId,
    registerId,
    tokenHash: createHash("sha256").update(`device:${registerId}`).digest("hex"),
    owner: actor("owner"),
    manager: actor("manager"),
    cashier: actor("cashier"),
  };
  await tx`insert into organisations (id, name, business_type) values (${orgId}, ${name}, 'general')`;
  for (const a of [shop.owner, shop.manager, shop.cashier]) {
    await tx`insert into memberships (id, org_id, user_id, role, pin_hash, display_name)
             values (${randomUUID()}, ${orgId}, ${a.userId}, ${a.role}, 'argon2-secret', ${a.role})`;
  }
  await tx`insert into locations (id, org_id, name) values (${locationId}, ${orgId}, ${name + " Main"})`;
  await tx`insert into registers (id, org_id, location_id, name, device_token_hash)
           values (${registerId}, ${orgId}, ${locationId}, 'Till 1', ${shop.tokenHash})`;
  await tx`insert into audit_log (id, org_id, actor_user_id, action, entity)
           values (${randomUUID()}, ${orgId}, ${shop.owner.userId}, 'seed', 'organisation')`;
  return shop;
}

/**
 * Seeds Shop A and Shop B (owner, manager, cashier each) inside a transaction that is always
 * rolled back, so tests leave nothing behind and audit_log stays append-only for real.
 */
export async function inWorld(fn: (ctx: Ctx) => Promise<void>) {
  try {
    await sql.begin(async (tx) => {
      const world = { a: await seedShop(tx, "Shop A"), b: await seedShop(tx, "Shop B") };
      await fn(makeCtx(tx, world));
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

/** Gives a seeded user a verified authenticator, as Supabase would after MFA enrolment. */
export async function enrolTotp(tx: TransactionSql, actor: Actor) {
  await tx`insert into auth.users (id, aud, role) values (${actor.userId}, 'authenticated', 'authenticated') on conflict (id) do nothing`;
  await tx`insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at, secret)
           values (${randomUUID()}, ${actor.userId}, 'totp', 'verified', now(), now(), 'x')`;
}
