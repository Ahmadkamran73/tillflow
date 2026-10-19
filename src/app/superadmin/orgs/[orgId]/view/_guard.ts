import { notFound } from "next/navigation";
import { z } from "zod";
import { requireSuperadmin } from "@/lib/auth";

/** Every view page checks the superadmin itself: a layout alone is not a security boundary. */
export async function viewGuard(params: Promise<{ orgId: string }>, page: string) {
  const id = z.uuid().safeParse((await params).orgId);
  if (!id.success) notFound();
  const { user } = await requireSuperadmin(`/superadmin/orgs/${id.data}/view/${page}`);
  return { orgId: id.data, userId: user.id };
}
