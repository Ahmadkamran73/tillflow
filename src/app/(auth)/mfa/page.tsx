import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { verifyMfaChallengeAction } from "@/lib/auth/actions";
import { safeNext } from "@/lib/auth/redirect";
import { AuthForm } from "../_components/auth-form";
import { MfaEnrol } from "./mfa-enrol";

export const metadata: Metadata = { title: "Two-step verification · Tillflow POS" };

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNext((await searchParams).next);
  const user = await requireUser();
  if (user.aal === "aal2") redirect(next);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Two-step verification</h1>
      {user.hasVerifiedFactor ? (
        <>
          <p className="text-sm">Enter the 6-digit code from your authenticator app.</p>
          <AuthForm
            action={verifyMfaChallengeAction}
            submitLabel="Verify"
            hidden={{ next }}
            fields={[
              {
                name: "code",
                label: "6-digit code",
                autoComplete: "one-time-code",
                inputMode: "numeric",
                maxLength: 6,
              },
            ]}
          />
        </>
      ) : (
        <>
          <p className="text-sm">
            Protect your business with a code from an authenticator app each time you log in. It
            takes about a minute, and you can also do it later from Settings.
          </p>
          <MfaEnrol next={next} />
          <Link
            href={next}
            className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
          >
            Skip for now
          </Link>
        </>
      )}
    </>
  );
}
