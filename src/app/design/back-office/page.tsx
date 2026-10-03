import { TrendingUpIcon } from "lucide-react";
import type { Metadata } from "next";
import { BackOfficeShell } from "@/components/back-office/shell";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "Back office layout", robots: { index: false } };

// Placeholder figures for the layout preview only (amounts are display strings, not maths).
const kpis = [
  { label: "dashboard.sales", value: "€1,284.50", change: "+8%" },
  { label: "dashboard.transactions", value: "86", change: "+3%" },
  { label: "dashboard.vat", value: "€213.40", change: "+8%" },
] as const;
const hours = [
  ["8", 22],
  ["9", 48],
  ["10", 61],
  ["11", 55],
  ["12", 83],
  ["1", 100],
  ["2", 72],
  ["3", 44],
  ["4", 38],
  ["5", 52],
] as const;
const sales = [
  ["T-004218", "14:52", "card", "€14.80"],
  ["T-004217", "14:49", "cash", "€6.80"],
  ["T-004216", "14:41", "card", "€23.10"],
  ["T-004215", "14:33", "cash", "€3.40"],
] as const;

export default function Page() {
  return (
    <BackOfficeShell orgId="demo" orgName="Harbour Café" role="owner">
      <div className="flex max-w-5xl flex-col gap-6">
        <h1 className="text-title font-semibold tracking-tight">{t("dashboard.title")}</h1>

        <dl className="surface-panel divide-border grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {kpis.map((k) => (
            <div key={k.label} className="flex flex-col gap-1 p-5">
              <dt className="text-muted-foreground font-mono text-xs tracking-wide">
                {t(k.label)}
              </dt>
              <dd className="font-display text-display font-semibold tabular-nums">{k.value}</dd>
              <dd className="text-muted-foreground flex items-center gap-1 text-sm">
                <TrendingUpIcon aria-hidden className="size-4" />
                {t("dashboard.vsLast", { change: k.change, day: "Wednesday" })}
              </dd>
            </div>
          ))}
        </dl>

        <section className="surface-panel flex flex-col gap-4 p-5">
          <h2 className="text-heading font-semibold">{t("dashboard.hourly")}</h2>
          <p className="text-muted-foreground -mt-2 text-sm">
            {t("dashboard.peak", { hour: "1pm", amount: "€214" })}
          </p>
          <div
            role="img"
            aria-label={t("dashboard.hourlySummary", { hour: "1pm", amount: "€214" })}
            className="border-border flex h-44 items-end gap-2 border-b"
          >
            {hours.map(([h, pct]) => (
              <div key={h} className="flex h-full flex-1 flex-col justify-end gap-1">
                <div
                  className={pct === 100 ? "bg-ember" : "bg-primary"}
                  style={{ height: `${pct}%` }}
                />
              </div>
            ))}
          </div>
          <div aria-hidden className="text-muted-foreground flex gap-2 text-xs tabular-nums">
            {hours.map(([h]) => (
              <span key={h} className="flex-1 text-center">
                {h}
              </span>
            ))}
          </div>
        </section>

        <section className="surface-panel flex flex-col gap-2 p-5">
          <h2 className="text-heading font-semibold">{t("dashboard.recent")}</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("dashboard.receipt")}</TableHead>
                <TableHead>{t("dashboard.time")}</TableHead>
                <TableHead>{t("dashboard.tender")}</TableHead>
                <TableHead className="text-right">{t("register.total")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sales.map(([no, time, tender, total]) => (
                <TableRow key={no}>
                  <TableCell className="font-mono">{no}</TableCell>
                  <TableCell className="tabular-nums">{time}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(`tender.${tender}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{total}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      </div>
    </BackOfficeShell>
  );
}
