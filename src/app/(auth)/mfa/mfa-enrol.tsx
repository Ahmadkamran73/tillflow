"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { startMfaEnrolAction, verifyMfaEnrolAction, type MfaEnrolStart } from "@/lib/auth/actions";
import { AuthForm } from "../_components/auth-form";

export function MfaEnrol({ next }: { next: string }) {
  const [start, setStart] = useState<MfaEnrolStart | null>(null);
  const [pending, startTransition] = useTransition();
  const stepsRef = useRef<HTMLHeadingElement>(null);
  const started = Boolean(start && "factorId" in start);
  // The button unmounts when the QR step appears; move focus to the new step so it is announced.
  useEffect(() => {
    if (started) stepsRef.current?.focus();
  }, [started]);

  if (!start || "error" in start) {
    return (
      <div className="flex flex-col gap-3">
        {start && "error" in start ? (
          <p role="alert" className="text-destructive text-sm">
            {start.error}
          </p>
        ) : null}
        <Button
          type="button"
          className="h-12"
          disabled={pending}
          onClick={() => startTransition(async () => setStart(await startMfaEnrolAction()))}
        >
          {pending ? "Please wait…" : "Set up authenticator app"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 ref={stepsRef} tabIndex={-1} className="text-lg font-medium outline-none">
        Set up your authenticator app
      </h2>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>
          Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).
        </li>
        <li>Scan this code, or type the setup key shown below it.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element -- SVG data URI from Supabase */}
      <img
        src={start.qrCode}
        alt="QR code to add Tillflow POS to your authenticator app"
        width={192}
        height={192}
        className="self-center rounded-lg border bg-white p-2"
      />
      <p className="text-sm">
        Setup key:{" "}
        <code data-testid="mfa-secret" className="font-mono break-all">
          {start.secret.match(/.{1,4}/g)?.join(" ")}
        </code>
      </p>
      <AuthForm
        action={verifyMfaEnrolAction}
        submitLabel="Turn on two-step verification"
        hidden={{ factorId: start.factorId, next }}
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
    </div>
  );
}
