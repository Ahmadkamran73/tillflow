import { redirect } from "next/navigation";
import { requireBackOffice } from "@/lib/auth";

/** Post-login router: sends the user to their dashboard (new users are sent to /start first). */
export default async function BackOfficeEntry() {
  const { orgId } = await requireBackOffice("/o");
  redirect(`/o/${orgId}/dashboard`);
}
