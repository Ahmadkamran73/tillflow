"use server";

import { redirect } from "next/navigation";
import { allowAttempt, clientIp, RATE_LIMITED_MESSAGE } from "@/lib/rate-limit";
import { appUrl, isGoogleAuthEnabled } from "./config";
import { safeNext } from "./redirect";
import {
  emailOnlyInput,
  fieldErrorsOf,
  mfaEnrolVerifyInput,
  resetPasswordInput,
  signInInput,
  createOrganisationInput,
  signUpInput,
  totpCodeInput,
  type FormState,
} from "./schemas";
import { createSupabaseServerClient } from "./server";
import { provisionOrganisation, requireUser } from "./session";

// Server actions reachable without a session. Every one validates with Zod, rate-limits by
// IP + email, and answers the same way whether or not the account exists. Raw provider errors are
// never shown; only the error *code* is logged (never emails, tokens or names).

const str = (formData: FormData, key: string) => {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
};

function logAuthError(action: string, error: { code?: string; status?: number }) {
  console.error(`[auth] ${action} failed`, { code: error.code, status: error.status });
}

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpInput.safeParse({
    email: str(formData, "email"),
    password: str(formData, "password"),
    businessName: str(formData, "businessName"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  const { email, password, businessName } = parsed.data;

  if (!(await allowAttempt("sign-up", await clientIp(), email))) {
    return { error: RATE_LIMITED_MESSAGE };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { business_name: businessName },
      emailRedirectTo: `${appUrl()}/auth/callback?next=/o`,
    },
  });
  if (error) {
    if (error.code === "weak_password") {
      return { fieldErrors: { password: ["Choose a stronger password."] } };
    }
    logAuthError("signUp", error);
    return { error: "We could not create your account. Please try again." };
  }
  // Same message for a new and an already-registered email, so sign-up cannot be used to find accounts.
  return { ok: true, message: "Check your email for a link to confirm your account." };
}

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInInput.safeParse({
    email: str(formData, "email"),
    password: str(formData, "password"),
  });
  if (!parsed.success) return { error: "Enter your email and password." };
  const { email, password } = parsed.data;

  if (!(await allowAttempt("login", await clientIp(), email))) {
    return { error: RATE_LIMITED_MESSAGE };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "email_not_confirmed") {
      return { error: "Confirm your email first. We sent you a link when you signed up." };
    }
    if (error.code !== "invalid_credentials") logAuthError("signIn", error);
    return { error: "Incorrect email or password." };
  }
  redirect(safeNext(str(formData, "next")));
}

export async function sendMagicLinkAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = emailOnlyInput.safeParse({ email: str(formData, "email") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  const { email } = parsed.data;

  if (!(await allowAttempt("magic-link", await clientIp(), email))) {
    return { error: RATE_LIMITED_MESSAGE };
  }

  const supabase = await createSupabaseServerClient();
  // shouldCreateUser: false. Sign-in links never create accounts; sign-up has its own form.
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${appUrl()}/auth/callback?next=/o` },
  });
  if (error && error.code !== "otp_disabled" && error.status !== 422)
    logAuthError("magicLink", error);
  return { ok: true, message: "If that email has an account, a sign-in link is on its way." };
}

export async function requestPasswordResetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = emailOnlyInput.safeParse({ email: str(formData, "email") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  const { email } = parsed.data;

  if (!(await allowAttempt("reset", await clientIp(), email))) {
    return { error: RATE_LIMITED_MESSAGE };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${appUrl()}/auth/callback?next=/reset-password`,
  });
  if (error) logAuthError("resetRequest", error);
  return { ok: true, message: "If that email has an account, a reset link is on its way." };
}

/** Runs on /reset-password after the recovery link created a session. */
export async function updatePasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  // Enforced here as well as on the page: a recovery link alone must not change an MFA account's password.
  if (user.hasVerifiedFactor && user.aal !== "aal2") {
    return { error: "Confirm your authenticator code first." };
  }
  const parsed = resetPasswordInput.safeParse({
    password: str(formData, "password"),
    confirmPassword: str(formData, "confirmPassword"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };

  if (!(await allowAttempt("reset", "update", user.id))) return { error: RATE_LIMITED_MESSAGE };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    if (error.code === "weak_password" || error.code === "same_password") {
      return { fieldErrors: { password: ["Choose a different, stronger password."] } };
    }
    logAuthError("updatePassword", error);
    return { error: "We could not change your password. Request a new reset link and try again." };
  }
  // A reset usually means a lost or shared credential: end every other session.
  await supabase.auth.signOut({ scope: "others" });
  redirect("/o");
}

/** "Continue with Google". Owners and managers only; see the callback for the role check. */
export async function signInWithGoogleAction(): Promise<void> {
  if (!isGoogleAuthEnabled()) redirect("/login?error=google_disabled");
  if (!(await allowAttempt("login", await clientIp(), "google"))) redirect("/login?error=rate");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${appUrl()}/auth/callback?next=/o` },
  });
  if (error || !data.url) {
    if (error) logAuthError("google", error);
    redirect("/login?error=callback");
  }
  redirect(data.url);
}

/**
 * The explicit “Create your business” step for a signed-in user who has no organisation yet.
 * A form POST (Next checks the origin), not a side effect of rendering a page.
 */
export async function createOrganisationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const parsed = createOrganisationInput.safeParse({ businessName: str(formData, "businessName") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  if (!(await allowAttempt("sign-up", "org", user.id))) return { error: RATE_LIMITED_MESSAGE };

  try {
    await provisionOrganisation(parsed.data.businessName);
  } catch {
    console.error("[auth] createOrganisation failed");
    return { error: "We could not create your business. Please try again." };
  }
  // The new owner is at aal1: set up the authenticator first, then onboarding.
  redirect("/mfa?next=%2Fonboarding");
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}

// ---------------------------------------------------------------- TOTP MFA

export type MfaEnrolStart =
  { error: string } | { factorId: string; qrCode: string; secret: string };

/** Starts TOTP enrolment: returns the QR code and the manual key. Nothing is trusted until verified. */
export async function startMfaEnrolAction(): Promise<MfaEnrolStart> {
  const user = await requireUser();
  if (user.hasVerifiedFactor) return { error: "An authenticator app is already set up." };
  if (!(await allowAttempt("mfa", user.id))) return { error: RATE_LIMITED_MESSAGE };

  const supabase = await createSupabaseServerClient();
  // Abandoned earlier attempts would otherwise pile up against the factor limit.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.all ?? []) {
    if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    issuer: "Tillflow POS",
  });
  if (error || !data) {
    if (error) logAuthError("mfaEnroll", error);
    return { error: "We could not start set-up. Please try again." };
  }
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

export async function verifyMfaEnrolAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const parsed = mfaEnrolVerifyInput.safeParse({
    factorId: str(formData, "factorId"),
    code: str(formData, "code"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  // Someone who already has an authenticator must use the challenge, never enrol a second factor.
  if (user.hasVerifiedFactor) return { error: "An authenticator app is already set up." };
  if (!(await allowAttempt("mfa", user.id))) return { error: RATE_LIMITED_MESSAGE };

  const supabase = await createSupabaseServerClient();
  // challengeAndVerify on an unverified factor activates it and upgrades this session to aal2.
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });
  if (error) {
    if (error.code !== "mfa_verification_failed") logAuthError("mfaEnrolVerify", error);
    return { error: "That code is not correct. Check your app and try again." };
  }
  redirect(safeNext(str(formData, "next"), "/onboarding"));
}

export async function verifyMfaChallengeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const parsed = totpCodeInput.safeParse({ code: str(formData, "code") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  if (!(await allowAttempt("mfa", user.id))) return { error: RATE_LIMITED_MESSAGE };

  const supabase = await createSupabaseServerClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const factor = factors?.totp[0];
  if (!factor) return { error: "No authenticator app is set up for this account." };

  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code: parsed.data.code,
  });
  if (error) {
    if (error.code !== "mfa_verification_failed") logAuthError("mfaChallenge", error);
    return { error: "That code is not correct. Check your app and try again." };
  }
  redirect(safeNext(str(formData, "next")));
}
