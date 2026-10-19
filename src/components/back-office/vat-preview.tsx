"use client";

import {
  findRateBp,
  formatCents,
  localDate,
  parseCents,
  splitVat,
  type RateRow,
} from "@/lib/money";
import type { TaxCategory } from "@/lib/money";
import { t } from "@/lib/i18n";

/** Today's rate for a category, or null when the table has none (never a guessed rate). */
export function rateToday(rates: readonly RateRow[], category: string, timeZone: string) {
  try {
    return findRateBp(rates, "IE", category as TaxCategory, localDate(new Date(), timeZone));
  } catch {
    return null;
  }
}

export const rateLabel = (bp: number) => `${bp / 100}%`;

/** Live "ex VAT / VAT" for a VAT-inclusive price, using the shared money library. */
export function VatPreview({
  price,
  category,
  takeawayCategory,
  rates,
  timeZone,
  id,
}: {
  price: string;
  category: string;
  takeawayCategory?: string;
  rates: readonly RateRow[];
  timeZone: string;
  id: string;
}) {
  const cents = parseCents(price);
  const lines: string[] = [];
  let message: string | null = null;

  if (cents === null) {
    message = t("catalog.vat.none");
  } else {
    const bp = rateToday(rates, category, timeZone);
    if (bp === null) {
      message = t("catalog.vat.noRate");
    } else {
      const { net, vat } = splitVat(cents, bp);
      lines.push(
        t("catalog.vat.ex", { amount: formatCents(net) }),
        t("catalog.vat.vat", { amount: formatCents(vat), rate: rateLabel(bp) }),
      );
      const awayBp = takeawayCategory ? rateToday(rates, takeawayCategory, timeZone) : null;
      if (awayBp !== null && awayBp !== bp) {
        lines.push(
          t("catalog.vat.takeaway", {
            amount: formatCents(splitVat(cents, awayBp).vat),
            rate: rateLabel(awayBp),
          }),
        );
      }
    }
  }

  return (
    <p id={id} aria-live="polite" className="text-muted-foreground font-mono text-sm tabular-nums">
      {message ?? lines.join(" · ")}
    </p>
  );
}
