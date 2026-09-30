import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { requireBackOffice } from "@/lib/auth";

export const metadata: Metadata = { title: "Welcome · Tillflow POS" };

// Placeholder: the real onboarding wizard (business type, tills, product import) comes later.
export default async function OnboardingPage() {
  const { orgId } = await requireBackOffice("/onboarding");
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-4 px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome to Tillflow POS</h1>
      <p className="text-sm">
        Your account is ready. Setting up your business type, tills and products will happen here
        soon.
      </p>
      <Link
        href={`/o/${orgId}/dashboard`}
        className={buttonVariants({ className: "h-12 w-fit px-5" })}
      >
        Go to dashboard
      </Link>
    </main>
  );
}
