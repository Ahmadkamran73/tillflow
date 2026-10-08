import type { ReviewFlag } from "@/lib/sync/process";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { getLocation } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { receiptNo } from "@/lib/register/sale";
import { markSaleReviewedAction } from "@/lib/sync/actions";
import { getSalesToReview } from "@/lib/sync/attention";

export const metadata: Metadata = { title: `${t("sales.review.title")} · ${t("app.name")}` };

/** Saved sales the server flagged, until a manager marks each one reviewed. */
export default async function SalesToReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string; n?: string }>;
}) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const { result, n } = await searchParams;
  const location = await getLocation(orgId);
  if (!location) notFound();

  const supabase = await createSupabaseServerClient();
  const [sales, registers] = await Promise.all([
    getSalesToReview(orgId),
    supabase.from("registers").select("id, name").eq("org_id", orgId),
  ]);
  if (registers.error) throw new Error("Could not load tills");
  const tills = new Map((registers.data ?? []).map((r) => [r.id as string, r.name as string]));
  const time = new Intl.DateTimeFormat("en-IE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: location.timezone,
  });

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("sales.review.title")}</h1>
      <p className="max-w-prose text-sm">{t("sales.review.body")}</p>

      {result === "reviewed" ? (
        <p key={n} role="status" tabIndex={-1} autoFocus className="rounded-lg border p-3 text-sm">
          {t("sales.review.done")}
        </p>
      ) : result ? (
        <p key={n} role="alert" tabIndex={-1} autoFocus className="text-destructive text-sm">
          {t("sales.review.error")}
        </p>
      ) : null}

      {sales.length === 0 ? (
        <p className="surface-panel p-8 text-center">{t("sales.review.none")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {sales.map((s) => {
            const receipt = receiptNo(tills.get(s.registerId) ?? "Till", s.receiptSeq);
            return (
              <li key={s.id} className="surface-panel flex flex-col gap-2 p-5">
                <h2 className="text-heading font-mono font-semibold">{receipt}</h2>
                <p className="text-sm">
                  {time.format(new Date(s.completedAt))} ·{" "}
                  <span className="font-mono tabular-nums">{formatCents(s.amountDueCents)}</span>
                </p>
                <ul className="list-disc pl-5 text-sm">
                  {s.flags.map((f) => (
                    <li key={f}>
                      {t(`sales.flag.${f as ReviewFlag}`)}
                      {f === "vat_differs" && s.clientVatCents !== null
                        ? ` (${t("sales.review.tillVat", {
                            till: formatCents(s.clientVatCents),
                            server: formatCents(s.vatCents),
                          })})`
                        : ""}
                    </li>
                  ))}
                </ul>
                <form action={markSaleReviewedAction} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="orgId" value={orgId} />
                  <input type="hidden" name="id" value={s.id} />
                  <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium">
                    {t("sales.review.note")}
                    <Input name="note" maxLength={500} autoComplete="off" className="h-12" />
                  </label>
                  <Button
                    type="submit"
                    variant="outline"
                    className="h-12 px-5"
                    aria-label={t("sales.review.markFor", { receipt })}
                  >
                    {t("sales.review.mark")}
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      <Link
        href={`/o/${orgId}/sales`}
        className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
      >
        {t("sales.title")}
      </Link>
    </section>
  );
}
