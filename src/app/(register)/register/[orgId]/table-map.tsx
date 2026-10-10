"use client";

import { ArmchairIcon, InfoIcon, ReceiptTextIcon, UtensilsCrossedIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import type { Feed } from "@/lib/register/feed";
import type { LocalTab } from "@/lib/register/db";
import { tableStatus, type TableStatus } from "@/lib/register/tabs";

type Floor = Feed["floors"][number];
type TableRow = Feed["tables"][number];

/** Status is shown as an icon AND text, never colour alone. */
const STATUS_ICON = {
  free: ArmchairIcon,
  seated: ArmchairIcon,
  ordered: UtensilsCrossedIcon,
  bill: ReceiptTextIcon,
} satisfies Record<TableStatus, typeof ArmchairIcon>;

const STATUS_STYLE: Record<TableStatus, string> = {
  free: "border-input bg-paper border-dashed",
  seated: "border-solid-border bg-paper border-solid",
  ordered: "border-solid-border bg-accent border-solid",
  bill: "border-primary bg-paper border-4 border-double",
};

/**
 * The till's table map (docs/specs/restaurant.md): each floor is a grid of cells, each table a
 * button placed on it. Works from the local copy of the plan and the tabs in IndexedDB, so it is
 * the same offline.
 */
export function TableMap({
  floors,
  tables,
  tabs,
  onTable,
  onQuickSale,
}: {
  floors: readonly Floor[];
  tables: readonly TableRow[];
  /** All open tabs of this till. */
  tabs: readonly LocalTab[];
  onTable: (table: TableRow) => void;
  onQuickSale: () => void;
}) {
  const live = tabs.filter((tab) => tab.state === "open");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="tables-heading" tabIndex={-1} className="text-lg font-semibold outline-offset-4">
          {t("tables.title")}
        </h2>
        <Button size="touch" variant="outline" className="ml-auto" onClick={onQuickSale}>
          {t("tables.quickSale")}
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">{t("tables.pickTable")}</p>
      <p className="border-solid-border bg-paper flex items-center gap-2 rounded-lg border-2 p-3 text-sm font-medium">
        <InfoIcon aria-hidden className="size-5 shrink-0" />
        {t("tables.notShared")}
      </p>
      {tables.length === 0 && <p>{t("tables.empty")}</p>}
      {[...floors]
        .sort((a, b) => a.sort - b.sort)
        .map((floor) => {
          const here = tables.filter((x) => x.floorId === floor.id);
          if (here.length === 0) return null;
          const cols = Math.max(8, ...here.map((x) => x.x + x.w));
          const rows = Math.max(3, ...here.map((x) => x.y + x.h));
          return (
            <section
              key={floor.id}
              aria-labelledby={`floor-${floor.id}`}
              className="flex flex-col gap-2"
            >
              <h3 id={`floor-${floor.id}`} className="font-semibold">
                {t("tables.floor", { name: floor.name })}
              </h3>
              <div
                className="grid gap-2"
                style={{
                  gridTemplateColumns: `repeat(${cols}, minmax(5rem, 1fr))`,
                  gridAutoRows: "minmax(4.5rem, auto)",
                  gridTemplateRows: `repeat(${rows}, minmax(4.5rem, auto))`,
                }}
              >
                {here.map((table) => {
                  const mine = live.filter((tab) => tab.tableId === table.id);
                  const status = tableStatus(mine);
                  const Icon = STATUS_ICON[status];
                  return (
                    <button
                      key={table.id}
                      type="button"
                      onClick={() => onTable(table)}
                      aria-label={`${t("tables.table", { name: table.name })}, ${t(`tables.status.${status}`)}, ${mine.length > 1 ? t("tables.bills", { count: mine.length }) : t("tables.seats", { count: table.seats })}`}
                      style={{
                        gridColumn: `${table.x + 1} / span ${table.w}`,
                        gridRow: `${table.y + 1} / span ${table.h}`,
                      }}
                      className={`till-key flex min-h-12 flex-col items-center justify-center gap-0.5 p-1 text-center ${
                        table.shape === "round" ? "rounded-full" : "rounded-xl"
                      } border-2 ${STATUS_STYLE[status]}`}
                    >
                      <span className="font-display leading-none font-semibold">{table.name}</span>
                      <span className="flex items-center gap-1 text-xs">
                        <Icon aria-hidden className="size-4" />
                        {t(`tables.status.${status}`)}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {mine.length > 1
                          ? t("tables.bills", { count: mine.length })
                          : t("tables.seats", { count: table.seats })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
    </div>
  );
}
