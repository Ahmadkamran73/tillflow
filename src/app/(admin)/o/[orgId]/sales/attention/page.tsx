import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { resolveRejectedSaleAction, retryRejectedSaleAction } from "@/lib/sync/actions";
import { reasonText, syncSale, SYNC_REASONS, type SyncReason } from "@/lib/sync/protocol";

export const metadata: Metadata = { title: `${t("attention.title")} · ${t("app.name")}` };

type Detail = { tillDueCents?: number; serverDueCents?: number };

const RESULTS: Record<string, { key: MessageKey; alert: boolean }> = {
  retried: { key: "attention.retried", alert: false },
  resolved: { key: "attention.resolved", alert: false },
  failed: { key: "attention.retryFailed", alert: true },
  note: { key: "attention.noteRequired", alert: true },
  error: { key: "attention.error", alert: true },
};

export default async function AttentionPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const location = await getLocation(orgId);
  if (!location) notFound();
  const { result } = await searchParams;
  const message = result ? RESULTS[result] : undefined;

  const supabase = await createSupabaseServerClient();
  const [rejections, registers] = await Promise.all([
    supabase
      .from("sync_rejections")
      .select("id, register_id, reason, detail, payload, created_at")
      .eq("org_id", orgId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("registers").select("id, name").eq("org_id", orgId),
  ]);
  if (rejections.error || registers.error)
    throw new Error("Could not load sales needing attention");
  const rows = rejections.data ?? [];

  // Product names for the items column (only ids travel from the till).
  const sales = rows.map((r) => syncSale.safeParse(r.payload ?? {}));
  const variantIds = [
    ...new Set(sales.flatMap((s) => (s.success ? s.data.lines.map((l) => l.variantId) : []))),
  ];
  const names = new Map<string, string>();
  if (variantIds.length > 0) {
    const { data: vs } = await supabase
      .from("variants")
      .select("id, name, product_id")
      .eq("org_id", orgId)
      .in("id", variantIds);
    const productIds = [...new Set((vs ?? []).map((v) => v.product_id as string))];
    const { data: ps } = productIds.length
      ? await supabase.from("products").select("id, name").eq("org_id", orgId).in("id", productIds)
      : { data: [] };
    const productName = new Map((ps ?? []).map((p) => [p.id as string, p.name as string]));
    for (const v of vs ?? [])
      names.set(v.id, productName.get(v.product_id as string) ?? (v.name as string));
  }

  const tillName = new Map((registers.data ?? []).map((r) => [r.id as string, r.name as string]));
  const time = new Intl.DateTimeFormat("en-IE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: location.timezone,
  });

  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("attention.title")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("attention.intro")}</p>

      {message && (
        <p
          role={message.alert ? "alert" : "status"}
          className={message.alert ? "text-destructive text-sm" : "rounded-lg border p-3 text-sm"}
        >
          {t(message.key)}
        </p>
      )}

      {rows.length === 0 ? (
        <div className="surface-panel p-8 text-center">
          <h2 className="font-display text-heading font-semibold">{t("attention.empty")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("attention.emptyBody")}</p>
        </div>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("attention.title")}
        >
          <Table>
            <caption className="sr-only">{t("attention.title")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("attention.col.time")}</TableHead>
                <TableHead scope="col">{t("attention.col.till")}</TableHead>
                <TableHead scope="col">{t("attention.col.reason")}</TableHead>
                <TableHead scope="col">{t("attention.col.amounts")}</TableHead>
                <TableHead scope="col">{t("attention.col.items")}</TableHead>
                <TableHead scope="col">{t("attention.col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => {
                const sale = sales[i];
                const detail = r.detail as Detail;
                // A refund, void or exchange return from the till: a manager resolves it by hand.
                const isRefund = (r.detail as { kind?: unknown }).kind === "refund";
                const reason = (SYNC_REASONS as readonly string[]).includes(r.reason)
                  ? reasonText[r.reason as SyncReason]
                  : reasonText.invalid;
                const till = tillName.get(r.register_id as string) ?? "";
                const when = time.format(new Date(r.created_at as string));
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">
                      {sale?.success ? time.format(new Date(sale.data.completedAt)) : when}
                    </TableCell>
                    <TableCell>
                      {till}
                      {sale?.success && (
                        <span className="text-muted-foreground block font-mono text-xs">
                          #{String(sale.data.receiptSeq).padStart(6, "0")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-64">{reason}</TableCell>
                    <TableCell className="font-mono text-sm tabular-nums">
                      {typeof detail.tillDueCents === "number" && (
                        <span className="block">
                          {t("attention.tillTotal", { amount: formatCents(detail.tillDueCents) })}
                        </span>
                      )}
                      {typeof detail.serverDueCents === "number" && (
                        <span className="block">
                          {t("attention.serverTotal", {
                            amount: formatCents(detail.serverDueCents),
                          })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-56 text-sm">
                      {isRefund
                        ? t(
                            (r.detail as { recorded?: unknown }).recorded === true
                              ? "attention.refundRecorded"
                              : "attention.refundRow",
                          )
                        : sale?.success
                        ? sale.data.lines
                            .map((l) => `${l.qty} × ${names.get(l.variantId) ?? "?"}`)
                            .join(", ")
                        : t("attention.unreadable")}
                    </TableCell>
                    <TableCell>
                      <div
                        role="group"
                        aria-label={t("attention.rowFor", { time: when, till })}
                        className="flex flex-col gap-2"
                      >
                        {!isRefund && (
                          <form action={retryRejectedSaleAction}>
                            <input type="hidden" name="orgId" value={orgId} />
                            <input type="hidden" name="id" value={r.id} />
                            <Button type="submit" variant="outline" className="h-12 w-full px-4">
                              {t("attention.retry")}
                            </Button>
                          </form>
                        )}
                        <form action={resolveRejectedSaleAction} className="flex flex-col gap-2">
                          <input type="hidden" name="orgId" value={orgId} />
                          <input type="hidden" name="id" value={r.id} />
                          <label className="text-xs" htmlFor={`note-${r.id}`}>
                            {t("attention.note")}
                          </label>
                          <Input
                            id={`note-${r.id}`}
                            name="note"
                            required
                            maxLength={500}
                            aria-describedby={`note-hint-${r.id}`}
                            className="h-12"
                          />
                          <span id={`note-hint-${r.id}`} className="text-muted-foreground text-xs">
                            {t("attention.noteHint")}
                          </span>
                          <Button type="submit" className="h-12 px-4">
                            {t("attention.resolve")}
                          </Button>
                        </form>
                      </div>
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
