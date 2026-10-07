import type { Metadata } from "next";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { t, type MessageKey } from "@/lib/i18n";

export const metadata: Metadata = { title: `${t("staff.title")} · ${t("app.name")}` };

const done: Record<string, MessageKey> = {
  reset: "staff.resetDone",
  added: "staff.added",
  pinSet: "staff.pinSetDone",
  removed: "staff.removed",
};

export default async function StaffPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string; n?: string }>;
}) {
  const { orgId } = await params;
  const { role: viewerRole } = await requireRole(["owner", "manager"], orgId);
  const { result, n } = await searchParams;
  const location = await getLocation(orgId);

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("memberships")
    .select("id, role, display_name, pin_set_at, pin_locked_until, till_only")
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
      <Link
        href={`/o/${orgId}/staff/new`}
        className={buttonVariants({ className: "h-12 self-start px-5" })}
      >
        {t("staff.add")}
      </Link>

      {result && done[result] ? (
        <p key={n} role="status" tabIndex={-1} autoFocus className="rounded-lg border p-3 text-sm">
          {t(done[result])}
        </p>
      ) : result ? (
        <p key={n} role="alert" tabIndex={-1} autoFocus className="text-destructive text-sm">
          {t("staff.error")}
        </p>
      ) : null}

      <div
        className="surface-panel overflow-x-auto"
        role="region"
        tabIndex={0}
        aria-label={t("staff.title")}
      >
        <Table>
          <caption className="sr-only">{t("staff.title")}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("staff.name")}</TableHead>
              <TableHead scope="col">{t("staff.role")}</TableHead>
              <TableHead scope="col">{t("staff.pin")}</TableHead>
              <TableHead scope="col">
                <span className="sr-only">{t("staff.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((m) => {
              const locked = m.pin_locked_until && new Date(m.pin_locked_until) > new Date();
              const name = m.display_name ?? t("staff.noName");
              // Managers clear cashiers; only an owner clears a manager or an owner.
              const canReset = m.pin_set_at && (m.role === "cashier" || viewerRole === "owner");
              // Till-only cashiers are managed here; people with a login set their own PIN.
              const canManage = m.till_only === true;
              return (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell>
                    {t(`lock.role.${m.role as "owner" | "manager" | "cashier"}`)}
                  </TableCell>
                  <TableCell>
                    {locked
                      ? t("staff.pinLocked", { time: time.format(new Date(m.pin_locked_until!)) })
                      : m.pin_set_at
                        ? t("staff.pinSet")
                        : t("staff.pinNone")}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-2">
                      {canManage && (
                        <Link
                          href={`/o/${orgId}/staff/${m.id}`}
                          aria-label={t("staff.manageFor", { name })}
                          className={buttonVariants({ variant: "outline", className: "h-12" })}
                        >
                          {t("staff.manage")}
                        </Link>
                      )}
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
                    </div>
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
