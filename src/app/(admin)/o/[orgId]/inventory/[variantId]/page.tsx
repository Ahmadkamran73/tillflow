import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireRole } from "@/lib/auth";
import { getLocation } from "@/lib/catalog";
import { t, type MessageKey } from "@/lib/i18n";
import { getVariantStock } from "@/lib/inventory";
import { setThresholdAction } from "@/lib/inventory-actions";
import { AdjustForm } from "./adjust-form";

export const metadata: Metadata = { title: `${t("inventory.title")} · ${t("app.name")}` };

const when = new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeStyle: "short" });

export default async function VariantStockPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; variantId: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { orgId, variantId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const location = await getLocation(orgId);
  if (!location) notFound();
  const item = await getVariantStock(orgId, location.id, variantId);
  if (!item) notFound();
  const sp = await searchParams;
  const negative = item.onHand < 0;

  return (
    <section className="flex flex-col gap-4">
      <Link
        href={`/o/${orgId}/inventory`}
        className="inline-flex min-h-12 items-center text-sm font-medium underline underline-offset-4"
      >
        {t("inventory.detail.back")}
      </Link>
      <h1 className="text-title font-semibold tracking-tight">{item.name}</h1>

      {sp.saved ? (
        <p role="status" tabIndex={-1} autoFocus className="rounded-lg border p-3 text-sm">
          {t("inventory.saved")}
        </p>
      ) : null}
      {sp.error ? (
        <p
          role="alert"
          tabIndex={-1}
          autoFocus
          className="border-destructive rounded-lg border p-3 text-sm"
        >
          {t("inventory.err.generic")}
        </p>
      ) : null}

      <p
        className={`text-amount font-mono tabular-nums ${negative ? "text-destructive" : ""}`}
        data-testid="on-hand"
      >
        {negative ? <span aria-hidden>⚠ </span> : null}
        {item.onHand}
        {negative ? (
          <span className="ml-2 font-sans text-base">{t("inventory.status.negative")}</span>
        ) : null}
      </p>
      <p className="text-muted-foreground text-sm">
        {t("inventory.detail.productTotal", { n: item.productTotal })}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <AdjustForm orgId={orgId} variantId={variantId} />

        <form
          action={setThresholdAction}
          className="surface-panel flex max-w-xl flex-col gap-4 p-5"
        >
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="variantId" value={variantId} />
          <input type="hidden" name="productId" value={item.productId} />
          <h2 className="text-heading font-semibold">{t("inventory.threshold.title")}</h2>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="threshold" className="text-sm font-medium">
              {t("inventory.threshold.label")}
            </label>
            <input
              id="threshold"
              name="threshold"
              inputMode="numeric"
              defaultValue={item.threshold ?? ""}
              aria-describedby="threshold-hint"
              autoComplete="off"
              className="border-input bg-background h-12 rounded-lg border px-3 text-base outline-none focus-visible:ring-3 md:text-sm"
            />
            <p id="threshold-hint" className="text-muted-foreground text-sm">
              {t("inventory.threshold.hint")}
            </p>
          </div>
          <Button type="submit" size="touch" variant="outline">
            {t("inventory.threshold.submit")}
          </Button>
        </form>
      </div>

      <h2 className="text-heading font-semibold">{t("inventory.history.title")}</h2>
      {item.movements.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("inventory.history.empty")}</p>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("inventory.history.title")}
        >
          <Table aria-label={t("inventory.history.title")}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("inventory.history.col.when")}</TableHead>
                <TableHead scope="col">{t("inventory.history.col.reason")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("inventory.history.col.change")}
                </TableHead>
                <TableHead scope="col">{t("inventory.history.col.note")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {item.movements.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{when.format(new Date(m.created_at))}</TableCell>
                  <TableCell>{t(`inventory.reason.${m.reason}` as MessageKey)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {m.qty_delta > 0 ? `+${m.qty_delta}` : m.qty_delta}
                  </TableCell>
                  <TableCell>{m.note ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
