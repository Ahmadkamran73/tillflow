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
import { t } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { receiptNo } from "@/lib/register/sale";

export const metadata: Metadata = { title: `${t("sales.title")} · ${t("app.name")}` };

/** The latest sales that have reached the server (reports come later), and a link to Needs attention. */
export default async function SalesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const location = await getLocation(orgId);
  if (!location) notFound();

  const supabase = await createSupabaseServerClient();
  const [sales, registers, attention] = await Promise.all([
    supabase
      .from("sales")
      .select("id, register_id, receipt_seq, completed_at, vat_cents, amount_due_cents")
      .eq("org_id", orgId)
      .order("completed_at", { ascending: false })
      .limit(50),
    supabase.from("registers").select("id, name").eq("org_id", orgId),
    supabase
      .from("sync_rejections")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "open"),
  ]);
  if (sales.error || registers.error) throw new Error("Could not load sales");
  const tills = new Map((registers.data ?? []).map((r) => [r.id as string, r.name as string]));
  const time = new Intl.DateTimeFormat("en-IE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: location.timezone,
  });
  const open = attention.count ?? 0;

  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("sales.title")}</h1>
      <p>
        <Link href={`/o/${orgId}/sales/attention`} className="font-medium underline">
          {open > 0 ? t("sales.attentionLink", { count: open }) : t("sales.attentionNone")}
        </Link>
      </p>
      {(sales.data ?? []).length === 0 ? (
        <div className="surface-panel p-8 text-center">
          <h2 className="font-display text-heading font-semibold">{t("sales.empty")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("sales.emptyBody")}</p>
        </div>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("sales.title")}
        >
          <Table>
            <caption className="sr-only">{t("sales.title")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("sales.col.receipt")}</TableHead>
                <TableHead scope="col">{t("sales.col.time")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("sales.col.vat")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("sales.col.total")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sales.data ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono">
                    {receiptNo(
                      tills.get(s.register_id as string) ?? "Till",
                      s.receipt_seq as number,
                    )}
                  </TableCell>
                  <TableCell>{time.format(new Date(s.completed_at as string))}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(s.vat_cents as number)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(s.amount_due_cents as number)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
