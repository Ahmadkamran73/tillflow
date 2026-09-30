import type { Metadata } from "next";
import Link from "next/link";
import { sendMagicLinkAction } from "@/lib/auth/actions";
import { AuthForm } from "../_components/auth-form";

export const metadata: Metadata = { title: "Email sign-in link · Tillflow POS" };

export default function MagicLinkPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Email me a sign-in link</h1>
      <AuthForm
        action={sendMagicLinkAction}
        submitLabel="Send link"
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
