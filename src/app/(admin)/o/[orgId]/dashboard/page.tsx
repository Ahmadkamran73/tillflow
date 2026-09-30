import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";

export const metadata: Metadata = { title: "Dashboard · Tillflow POS" };

export default async function DashboardPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId); // layouts do not protect the page on their own

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <div className="rounded-xl border border-dashed p-8 text-center">
        <p className="font-medium">No sales yet</p>
        <p className="text-muted-foreground mt-1 text-sm">
          Today&apos;s sales, takings and VAT will appear here once your first register is set up.
        </p>
      </div>
    </section>
  );
}
