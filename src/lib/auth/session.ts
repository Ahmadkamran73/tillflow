import "server-only";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { createSupabaseServerClient } from "./server";
import { businessName, roles, type Role } from "./schemas";

export type AuthUser = {
  id: string;
  /** aal2 once this sign-in has passed TOTP. */
  aal: "aal1" | "aal2";
  /** True when the user has a verified TOTP factor (so aal2 is possible and therefore required). */
  hasVerifiedFactor: boolean;
  /** Business name typed at sign-up; only used to name the first organisation. */
  signUpBusinessName: string | undefined;
};

export type Membership = { orgId: string; role: Role };

const membershipRow = z.object({ org_id: z.uuid(), role: z.enum(roles) });

/** The verified current user (checked with Supabase, not just the cookie), or null. */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const name = businessName.safeParse(data.user.user_metadata?.business_name);
  return {
    id: data.user.id,
    aal: aal?.currentLevel === "aal2" ? "aal2" : "aal1",
    hasVerifiedFactor: aal?.nextLevel === "aal2",
    signUpBusinessName: name.success ? name.data : undefined,
  };
});

export async function requireUser(): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  return user;
}

/** The caller's memberships, read through RLS with the caller's own JWT. */
async function fetchMemberships(userId: string): Promise<Membership[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("org_id, role")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error("Could not load memberships");
  return z
    .array(membershipRow)
    .parse(data)
    .map((m) => ({ orgId: m.org_id, role: m.role }));
}

const getMemberships = cache(fetchMemberships);

/**
 * Creates the caller’s organisation and owner membership in one database transaction. Only ever
 * called from the explicit “Create your business” action, never as a side effect of loading a page.
 * The SQL function provisions for the JWT’s own user only and is idempotent.
 */
export async function provisionOrganisation(name: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_my_organisation", {
    p_org_id: uuidv7(),
    p_membership_id: uuidv7(),
    p_audit_id: uuidv7(),
    p_name: name,
  });
  if (error) throw new Error("Could not create the organisation");
  return z.uuid().parse(data);
}

function mfaRequired(user: AuthUser, role: Role) {
  return role === "owner" || user.hasVerifiedFactor;
}

function toMfa(next: string): never {
  redirect(`/mfa?next=${encodeURIComponent(next)}`);
}

/**
 * Authorisation for a specific organisation. Call it in every back-office page, layout, server
 * action and route handler. `allowed` is the allow-list, e.g. requireRole(["owner", "manager"], orgId).
 * A stranger, a non-member and a role that is not allowed all get the same 404, so org ids cannot
 * be probed. Owners (and anyone with a TOTP factor) must have passed MFA this session.
 */
export async function requireRole(allowed: Role | readonly Role[], orgId: string) {
  const allow: readonly Role[] = typeof allowed === "string" ? [allowed] : allowed;
  if (!z.uuid().safeParse(orgId).success) notFound();
  const user = await requireUser();
  const membership = (await getMemberships(user.id)).find((m) => m.orgId === orgId);
  if (!membership || !allow.includes(membership.role)) notFound();
  if (mfaRequired(user, membership.role) && user.aal !== "aal2") toMfa("/o");
  return { user, orgId, role: membership.role };
}

export type ApiAuth =
  { ok: true; user: AuthUser; orgId: string; role: Role } | { ok: false; status: 401 | 403 | 404 };

/**
 * `requireRole` for route handlers that are called with fetch (the register’s sync and catalogue):
 * it answers with a status instead of redirecting to a login page, so the device can tell
 * “signed out” (401), “finish MFA” (403) and “not yours” (404) apart from a network failure.
 */
export async function authorizeApi(
  allowed: Role | readonly Role[],
  orgId: string,
): Promise<ApiAuth> {
  const allow: readonly Role[] = typeof allowed === "string" ? [allowed] : allowed;
  if (!z.uuid().safeParse(orgId).success) return { ok: false, status: 404 };
  const user = await getAuthUser();
  if (!user) return { ok: false, status: 401 };
  const membership = (await getMemberships(user.id)).find((m) => m.orgId === orgId);
  if (!membership || !allow.includes(membership.role)) return { ok: false, status: 404 };
  if (mfaRequired(user, membership.role) && user.aal !== "aal2") return { ok: false, status: 403 };
  return { ok: true, user, orgId, role: membership.role };
}

/**
 * Entry point for pages that are not tied to a URL org (/o, /onboarding). Picks the user’s
 * back-office membership (owner first) and applies the MFA gate. A user with no membership at all is
 * sent to /start to create a business explicitly.
 */
export async function requireBackOffice(next: string) {
  const user = await requireUser();
  const memberships = await getMemberships(user.id);
  if (memberships.length === 0) redirect("/start");
  const membership =
    memberships.find((m) => m.role === "owner") ?? memberships.find((m) => m.role === "manager");
  if (!membership) notFound(); // cashiers work on the register, not in the back office
  if (mfaRequired(user, membership.role) && user.aal !== "aal2") {
    toMfa(next);
  }
  return { user, orgId: membership.orgId, role: membership.role };
}
