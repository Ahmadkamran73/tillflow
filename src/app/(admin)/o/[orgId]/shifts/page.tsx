import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
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
import { t, type MessageKey } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { zNumber } from "@/lib/shift-report";

export const metadata: Metadata = { title: `${t("shifts.title")} · ${t("app.name")}` };

/** An empty cell: a dash to look at, "Not closed" for a screen reader. */
const None = () => (
  <>
    <span aria-hidden>-</span>
    <span className="sr-only">{t("shifts.notClosed")}</span>
  </>
);

const overShortText = (cents: number) =>
  cents === 0
    ? t("shifts.balanced")
    : t(cents > 0 ? "shifts.over" : "shifts.short", { amount: formatCents(Math.abs(cents)) });

/** The latest shifts: open ones (live X-report) and closed ones (Z-reports). Managers and owners. */
export default async function ShiftsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const location = await getLocation(orgId);
  if (!location) notFound();

  const supabase = await createSupabaseServerClient();
  const [shifts, closes, registers] = await Promise.all([
    supabase
      .from("shifts")
      .select("id, register_id, opened_at, float_cents")
      .eq("org_id", orgId)
      .order("opened_at", { ascending: false })
      .limit(50),
    supabase
      .from("shift_closes")
      .select(
        "shift_id, z_seq, closed_at, counted_cents, expected_cents, over_short_cents, review_flags",
      )
      .eq("org_id", orgId)
      .order("closed_at", { ascending: false })
      .limit(50),
    supabase.from("registers").select("id, name").eq("org_id", orgId),
  ]);
  if (shifts.error || closes.error || registers.error) throw new Error("Could not load shifts");
  const tills = new Map((registers.data ?? []).map((r) => [r.id as string, r.name as string]));
  const closeOf = new Map((closes.data ?? []).map((c) => [c.shift_id as string, c]));
  const time = new Intl.DateTimeFormat("en-IE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: location.timezone,
  });

  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("shifts.title")}</h1>
      <p className="text-muted-foreground text-sm">{t("shifts.intro")}</p>
      {(shifts.data ?? []).length === 0 ? (
        <div className="surface-panel p-8 text-center">
          <h2 className="font-display text-heading font-semibold">{t("shifts.empty")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("shifts.emptyBody")}</p>
        </div>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("shifts.title")}
        >
          <Table>
            <caption className="sr-only">{t("shifts.title")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("shifts.col.till")}</TableHead>
                <TableHead scope="col">{t("shifts.col.opened")}</TableHead>
                <TableHead scope="col">{t("shifts.col.closed")}</TableHead>
                <TableHead scope="col">{t("shifts.col.z")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("shifts.col.expected")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("shifts.col.counted")}
                </TableHead>
                <TableHead scope="col">{t("shifts.col.overShort")}</TableHead>
                <TableHead scope="col">{t("shifts.col.check")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(shifts.data ?? []).map((s) => {
                const c = closeOf.get(s.id as string);
                const flags = ((c?.review_flags as string[] | undefined) ?? []).map((f) =>
                  t(`shifts.flag.${f}` as MessageKey),
                );
                return (
                  <TableRow key={s.id as string}>
                    <TableHead scope="row" className="font-normal">
                      <Link
                        href={`/o/${orgId}/shifts/${s.id}`}
                        className="inline-flex min-h-12 items-center underline"
                      >
                        {tills.get(s.register_id as string) ?? t("shifts.tillFallback")}
                        <span className="sr-only"> ({t("shifts.view")})</span>
                      </Link>
                    </TableHead>
                    <TableCell>{time.format(new Date(s.opened_at as string))}</TableCell>
                    <TableCell>
                      {c ? time.format(new Date(c.closed_at as string)) : t("shifts.open")}
                    </TableCell>
                    <TableCell className="font-mono">
                      {c ? zNumber(c.z_seq as number) : <None />}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {c ? formatCents(c.expected_cents as number) : <None />}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {c ? formatCents(c.counted_cents as number) : <None />}
                    </TableCell>
                    <TableCell>
                      {c ? overShortText(c.over_short_cents as number) : <None />}
                    </TableCell>
                    <TableCell className="text-sm">
                      {flags.length ? flags.join("; ") : t("shifts.checkNone")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
