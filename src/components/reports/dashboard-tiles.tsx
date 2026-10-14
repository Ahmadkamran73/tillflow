import Link from "next/link";
import type { DashboardTile } from "@/config/business-type-presets";
import { t } from "@/lib/i18n";
import { formatCents, roundHalfUp } from "@/lib/money";
import type { DashboardData, TopRow } from "@/lib/reports/dashboard";

const label = "text-muted-foreground font-mono text-xs tracking-wide";
const value = "text-amount font-mono tabular-nums";

/** Today is part of a day and last week's is a whole one, so say what last week was, not up or down. */
const lastWeekText = (weekday: string, shown: string) => t("dash.lastWeekWas", { weekday, value: shown });

function TopList({ rows, empty }: { rows: TopRow[]; empty: string }) {
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
      {rows.map((r, i) => (
        <li key={`${i}-${r.label}`} className="flex justify-between gap-3">
          <span className="min-w-0 break-words">
            {r.label}
            <span className="text-muted-foreground"> · {t("dash.units", { count: r.qty })}</span>
          </span>
          <span className="font-mono tabular-nums">{formatCents(r.grossCents)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The tiles a business type asks for, from the pre-aggregated summary. */
export function DashboardTiles({
  orgId,
  tiles,
  data,
  timeZone,
  lowProducts,
}: {
  orgId: string;
  tiles: readonly DashboardTile[];
  data: DashboardData;
  timeZone: string;
  lowProducts: number;
}) {
  const weekday = new Intl.DateTimeFormat("en-IE", { weekday: "long", timeZone }).format(
    new Date(`${data.lastWeekDay}T12:00:00Z`),
  );
  const money = formatCents;
  const count = (n: number) => String(n);

  const body = (tile: DashboardTile) => {
    switch (tile) {
      case "salesToday":
        return (
          <>
            <dd className={value}>{money(data.today.takingsCents)}</dd>
            <dd className="text-muted-foreground text-sm">
              {lastWeekText(weekday, money(data.lastWeek.takingsCents))}
            </dd>
          </>
        );
      case "transactions":
        return (
          <>
            <dd className={value}>{data.today.transactions}</dd>
            <dd className="text-muted-foreground text-sm">
              {lastWeekText(weekday, count(data.lastWeek.transactions))}
            </dd>
          </>
        );
      case "vatCollected":
        return (
          <>
            <dd className={value}>{money(data.today.vatCents)}</dd>
            <dd className="text-muted-foreground text-sm">
              {lastWeekText(weekday, money(data.lastWeek.vatCents))}
            </dd>
          </>
        );
      case "fastestMovers":
        return (
          <dd>
            <TopList rows={data.top} empty={t("dash.topEmpty")} />
          </dd>
        );
      case "lowStock":
        return (
          <>
            <dd className={value}>{lowProducts}</dd>
            <dd>
              <Link
                href={`/o/${orgId}/inventory?filter=low`}
                className="inline-flex min-h-12 items-center text-sm font-medium underline"
              >
                {t("dash.seeLowStock")}
              </Link>
            </dd>
          </>
        );
      case "salesByBrand":
        return (
          <dd>
            <TopList rows={data.brands} empty={t("dash.topEmpty")} />
          </dd>
        );
      case "salesBySizeColour":
        return (
          <dd>
            <TopList rows={data.sizes} empty={t("dash.topEmpty")} />
          </dd>
        );
      case "serialsSold":
        return <dd className={value}>{data.serialsToday}</dd>;
      case "salesByHour":
        return data.hours.length === 0 ? (
          <dd className="text-muted-foreground text-sm">{t("tile.empty")}</dd>
        ) : (
          <dd>
            <ol className="flex flex-col gap-1 text-sm">
              {data.hours.map((h) => (
                <li key={h.hour} className="flex justify-between gap-3">
                  <span>{h.hour}</span>
                  <span className="font-mono tabular-nums">{money(h.grossCents)}</span>
                </li>
              ))}
            </ol>
          </dd>
        );
      case "tips":
        return <dd className={value}>{money(data.today.tipsCents)}</dd>;
      case "covers":
        return <dd className={value}>{data.covers?.covers ?? 0}</dd>;
      case "spendPerCover":
        return (
          <dd className={value}>
            {data.covers && data.covers.covers > 0
              ? money(roundHalfUp(data.covers.spendPerCoverBase, data.covers.covers))
              : money(0)}
          </dd>
        );
    }
  };

  return (
    <section aria-labelledby="dash-today" className="flex flex-col gap-2">
      <h2 id="dash-today" className="sr-only">
        {t("dash.today")}
      </h2>
      <dl className="surface-panel divide-border grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {tiles.map((tile) => (
          <div key={tile} className="flex flex-col gap-1 p-5">
            <dt className={label}>
              {tile === "fastestMovers" ? t("dash.top") : t(`tile.${tile}`)}
            </dt>
            {body(tile)}
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground flex flex-wrap items-center gap-3 text-sm">
        {t("dash.fresh")}
        <Link href={`/o/${orgId}/reports`} className="inline-flex min-h-12 items-center underline">
          {t("dash.allReports")}
        </Link>
      </p>
    </section>
  );
}
