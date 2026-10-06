import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { getLocation } from "@/lib/catalog";
import { resetPinAction } from "@/lib/device/admin-actions";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: `${t("staff.title")} · ${t("app.name")}` };

export default async function StaffPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { orgId } = await params;
  const { role: viewerRole } = await requireRole(["owner", "manager"], orgId);
  const { result } = await searchParams;
  const location = await getLocation(orgId);

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("memberships")
    .select("id, role, display_name, pin_set_at, pin_locked_until")
    .eq("org_id", orgId)
    .order("created_at");
  const time = new Intl.DateTimeFormat("en-IE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: location?.timezone ?? "Europe/Dublin",
  });

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("staff.title")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("staff.body")}</p>

      {result === "reset" ? (
        <p role="status" tabIndex={-1} autoFocus className="rounded-lg border p-3 text-sm">
          {t("staff.resetDone")}
        </p>
      ) : result ? (
        <p role="alert" tabIndex={-1} autoFocus className="text-destructive text-sm">
          {t("staff.error")}
        </p>
      ) : null}

      <div className="surface-panel overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("staff.name")}</TableHead>
              <TableHead scope="col">{t("staff.role")}</TableHead>
              <TableHead scope="col">{t("staff.pin")}</TableHead>
              <TableHead scope="col">
                <span className="sr-only">{t("staff.reset")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((m) => {
              const locked = m.pin_locked_until && new Date(m.pin_locked_until) > new Date();
              const name = m.display_name ?? t("staff.noName");
              // Managers clear cashiers; only an owner clears a manager or an owner.
              const canReset = m.pin_set_at && (m.role === "cashier" || viewerRole === "owner");
              return (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell>{t(`lock.role.${m.role as "owner" | "manager" | "cashier"}`)}</TableCell>
                  <TableCell>
                    {locked
                      ? t("staff.pinLocked", { time: time.format(new Date(m.pin_locked_until!)) })
                      : m.pin_set_at
                        ? t("staff.pinSet")
                        : t("staff.pinNone")}
                  </TableCell>
                  <TableCell className="text-right">
                    {canReset && (
                      <form action={resetPinAction}>
                        <input type="hidden" name="orgId" value={orgId} />
                        <input type="hidden" name="membershipId" value={m.id} />
                        <Button
                          type="submit"
                          variant="outline"
                          className="h-12"
                          aria-label={t("staff.resetFor", { name })}
                        >
                          {t("staff.reset")}
                        </Button>
                      </form>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
