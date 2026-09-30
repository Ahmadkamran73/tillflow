import type { Metadata } from "next";
import Link from "next/link";
import { requestPasswordResetAction } from "@/lib/auth/actions";
import { AuthForm } from "../_components/auth-form";

export const metadata: Metadata = { title: "Reset password · Tillflow POS" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
      <AuthForm
        action={requestPasswordResetAction}
        submitLabel="Send reset link"
        fields={[{ name: "email", label: "Email", type: "email", autoComplete: "email" }]}
      />
      <Link
        href="/login"
        className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
      >
        Back to log in
      </Link>
    </>
  );
}
