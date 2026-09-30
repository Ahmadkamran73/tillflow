import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { isGoogleAuthEnabled } from "@/lib/auth";
import { signInAction, signInWithGoogleAction } from "@/lib/auth/actions";
import { safeNext } from "@/lib/auth/redirect";
import { AuthForm } from "../_components/auth-form";

export const metadata: Metadata = { title: "Log in · Tillflow POS" };

const ERRORS: Record<string, string> = {
  callback: "That sign-in did not complete. Please try again.",
  link_expired: "That link has expired or was already used. Request a new one.",
  google_not_allowed: "Google sign-in is only for owners and managers.",
  google_disabled: "Google sign-in is not available yet.",
  rate: "Too many attempts. Wait a minute and try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const google = isGoogleAuthEnabled();

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>
      {error && ERRORS[error] ? (
        <p role="alert" className="text-destructive text-sm">
          {ERRORS[error]}
        </p>
      ) : null}

      <AuthForm
        action={signInAction}
        submitLabel="Log in"
        hidden={{ next: safeNext(next) }}
        fields={[
          { name: "email", label: "Email", type: "email", autoComplete: "email" },
          {
            name: "password",
            label: "Password",
            type: "password",
            autoComplete: "current-password",
          },
        ]}
      />

      {google ? (
        <form action={signInWithGoogleAction}>
          <Button type="submit" variant="outline" className="h-12 w-full">
            Continue with Google
          </Button>
          <p className="text-muted-foreground mt-2 text-sm">For owners and managers.</p>
        </form>
      ) : null}

      <nav aria-label="Other ways in" className="flex flex-col gap-2 text-sm">
        <Link
          href="/magic-link"
          className="inline-flex min-h-12 items-center underline underline-offset-4"
        >
          Email me a sign-in link
        </Link>
        <Link
          href="/forgot-password"
          className="inline-flex min-h-12 items-center underline underline-offset-4"
        >
          Forgot your password?
        </Link>
        <span>
          New to Tillflow?{" "}
          <Link href="/signup" className="underline underline-offset-4">
            Create an account
          </Link>
        </span>
      </nav>
    </>
  );
}
