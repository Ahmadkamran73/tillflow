import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireRole } from "@/lib/auth";
import { signOutAction } from "@/lib/auth/actions";
import { getOrganisationName } from "@/lib/org";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const { role } = await requireRole(["owner", "manager"], orgId);
  const orgName = await getOrganisationName(orgId);
  if (!orgName) notFound();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b px-4 py-3">
        <span className="font-semibold">{orgName}</span>
        <Badge variant="secondary" className="capitalize">
          {role}
        </Badge>
        <nav aria-label="Back office" className="flex gap-4 text-sm">
          <Link
            href={`/o/${orgId}/dashboard`}
            className="inline-flex min-h-12 items-center underline underline-offset-4"
          >
            Dashboard
          </Link>
        </nav>
        <form action={signOutAction} className="ml-auto">
          <Button type="submit" variant="outline" className="h-12 px-4">
            Sign out
          </Button>
        </form>
      </header>
      <main className="flex-1 p-4">{children}</main>
    </div>
  );
}
