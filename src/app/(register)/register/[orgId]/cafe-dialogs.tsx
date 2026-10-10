"use client";

import { PrinterIcon, WheatIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import type { PrinterSettings, StationSetup } from "@/lib/register/print";
import { stations, type Station } from "@/lib/register/ticket";
import { Modal } from "./dialogs";

const selectClass = "border-input bg-background h-12 rounded-md border-2 px-3 text-base";

export const allergenName = (code: string) => t(`allergen.${code}` as Parameters<typeof t>[0]);

/** Allergens of an item: an icon and the names in text, never colour alone. */
export function AllergenBadge({ codes }: { codes: readonly string[] }) {
  if (codes.length === 0) return null;
  const list = codes.map(allergenName).join(", ");
  return (
    <span className="block text-xs font-medium">
      <WheatIcon aria-hidden className="mr-1 inline size-3.5" />
      <span className="sr-only">{t("register.allergenBadge", { list })}</span>
      <span aria-hidden>{list}</span>
    </span>
  );
}

export function AllergenListDialog({
  items,
  onPrint,
  onClose,
  status,
}: {
  items: { id: string; name: string; allergens: string[] }[];
  onPrint: () => void;
  onClose: () => void;
  /** Result of the last print, announced inside the dialog. */
  status?: string;
}) {
  return (
    <Modal title={t("register.allergensTitle")} onClose={onClose}>
      {items.length === 0 ? (
        <p>{t("register.allergensNone")}</p>
      ) : (
        <ul
          tabIndex={0}
          aria-label={t("register.allergensTitle")}
          className="flex max-h-[50dvh] flex-col gap-2 overflow-y-auto"
        >
          {items.map((i) => (
            <li key={i.id}>
              <p className="font-medium">{i.name}</p>
              <AllergenBadge codes={i.allergens} />
            </li>
          ))}
        </ul>
      )}
      <p role="status" className="min-h-5 text-sm font-medium">
        {status}
      </p>
      <div className="flex flex-col gap-2">
        <Button type="button" size="touch" disabled={items.length === 0} onClick={onPrint}>
          <PrinterIcon aria-hidden /> {t("register.allergensPrint")}
        </Button>
        <Button type="button" size="touch" variant="outline" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
    </Modal>
  );
}

/** Which station makes each category, and a button to set up each station's printer. */
export function StationsDialog({
  value,
  categories,
  onChange,
  onSetUp,
  onClose,
}: {
  value: StationSetup;
  categories: { id: string; name: string }[];
  onChange: (v: StationSetup) => void;
  onSetUp: (station: Station) => void;
  onClose: () => void;
}) {
  const label = (s: Station) => t(`register.station.${s}`);
  const describe = (p: PrinterSettings | undefined) =>
    p ? t(`register.printer.${p.type}`) : t("register.stationPrinterNone");
  return (
    <Modal
      title={t("register.stationsTitle")}
      description={t("register.stationsHelp")}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        {stations.map((s) => (
          <Button
            key={s}
            type="button"
            size="touch"
            variant="outline"
            className="justify-between"
            onClick={() => onSetUp(s)}
          >
            <span>{t("register.stationSetUp", { station: label(s) })}</span>
            <span>{describe(value.printers[s])}</span>
          </Button>
        ))}
        {categories.map((c) => (
          <label key={c.id} className="flex flex-col gap-1 text-sm font-medium">
            {t("register.stationFor", { category: c.name })}
            <select
              className={selectClass}
              value={value.categories[c.id] ?? "kitchen"}
              onChange={(e) =>
                onChange({
                  ...value,
                  categories: { ...value.categories, [c.id]: e.target.value as Station },
                })
              }
            >
              {stations.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <Button type="button" size="touch" variant="outline" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
    </Modal>
  );
}
