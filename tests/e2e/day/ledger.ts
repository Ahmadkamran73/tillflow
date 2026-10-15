/**
 * An independent expected-value calculator for the whole-day tests. It is written from the rules in
 * docs/PLAN.md (VAT-inclusive prices, half-up rounding per line, refunds at the original rate and
 * share, 5c cash rounding on the cash share) and shares NO code with src/lib/money, so a mistake
 * there cannot hide behind the same mistake here. Amounts are integer cents; rates are basis points.
 */

/** round(num / den), halves away from zero, using integers only. */
export function roundHalf(num: number, den: number): number {
  const sign = num < 0 ? -1 : 1;
  const n = Math.abs(num);
  return sign * Math.floor((2 * n + den) / (2 * den));
}

/** The VAT inside a VAT-inclusive amount: gross x rate / (10000 + rate). */
export const vatIn = (gross: number, rateBp: number) => roundHalf(gross * rateBp, 10000 + rateBp);

/** Nearest 5c, halves up (the shop's cash rounding). */
export const cash5 = (cents: number) => roundHalf(cents, 5) * 5;

export type Line = {
  name: string;
  /** The line's gross AFTER any discount, as it is stored. */
  gross: number;
  rateBp: number;
  qty?: number;
  discount?: number;
  /** Report dimensions (set only where a report is checked). */
  product?: string;
  category?: string;
  brand?: string;
  sizeColour?: string;
};
export type Pay = { method: "cash" | "card" | "exchange"; amount: number; tip?: number };
export type Sale = {
  key: string;
  lines: Line[];
  /** Re-turn deposit: outside VAT, own line. */
  deposit?: number;
  pays: Pay[];
  /** Customers at the table (restaurant), for covers. */
  covers?: number;
  fromTab?: boolean;
};
export type RefundLine = { sale: string; line: number; units: number; of: number };
export type Refund = { sale: string; lines: RefundLine[]; legs: Pay[]; credit?: number };

const rateOf = (l: Line) => l.rateBp;

export function expected(
  sales: Sale[],
  refunds: Refund[],
  opts: { float: number; counted: number },
) {
  const by = new Map<number, { gross: number; vat: number; net: number }>();
  const refBy = new Map<number, { gross: number; vat: number; net: number }>();
  const add = (m: typeof by, rate: number, gross: number, vat: number) => {
    const r = m.get(rate) ?? { gross: 0, vat: 0, net: 0 };
    r.gross += gross;
    r.vat += vat;
    r.net += gross - vat;
    m.set(rate, r);
  };

  let amountDue = 0;
  let items = 0;
  let vat = 0;
  let discount = 0;
  let tips = 0;
  const tender: Record<string, number> = { cash: 0, card: 0, exchange: 0 };
  const tenderCount: Record<string, number> = { cash: 0, card: 0, exchange: 0 };
  const tipsBy: Record<string, number> = { cash: 0, card: 0, exchange: 0 };
  for (const s of sales) {
    const gross = s.lines.reduce((n, l) => n + l.gross, 0);
    const v = s.lines.reduce((n, l) => n + vatIn(l.gross, rateOf(l)), 0);
    for (const l of s.lines) {
      add(by, rateOf(l), l.gross, vatIn(l.gross, rateOf(l)));
      discount += l.discount ?? 0;
    }
    const paid = s.pays.reduce((n, p) => n + p.amount, 0);
    // Whatever was paid must be the items plus the deposit plus the cash rounding of the cash share:
    // a sale in a scenario that does not add up is a mistake in the scenario, caught here.
    const cashShare = s.pays.filter((p) => p.method === "cash").reduce((n, p) => n + p.amount, 0);
    const rest = gross + (s.deposit ?? 0) - (paid - cashShare);
    if (cashShare > 0 && cashShare !== cash5(rest) && cashShare !== rest) {
      throw new Error(`sale ${s.key}: cash ${cashShare} is neither ${rest} nor ${cash5(rest)}`);
    }
    items += gross;
    vat += v;
    amountDue += paid;
    for (const p of s.pays) {
      tender[p.method]! += p.amount;
      tenderCount[p.method]! += 1;
      tipsBy[p.method]! += p.tip ?? 0;
      tips += p.tip ?? 0;
    }
  }

  let refundValue = 0; // value returned: money paid back plus exchange credit
  let refundVat = 0;
  let refundMoney = 0;
  let refundCredit = 0;
  const refTender: Record<string, number> = { cash: 0, card: 0, exchange: 0 };
  const refTenderCount: Record<string, number> = { cash: 0, card: 0, exchange: 0 };
  for (const r of refunds) {
    const sale = sales.find((s) => s.key === r.sale)!;
    for (const rl of r.lines) {
      const l = sale.lines[rl.line]!;
      const g = roundHalf(l.gross * rl.units, rl.of);
      const v = roundHalf(vatIn(l.gross, rateOf(l)) * rl.units, rl.of);
      add(refBy, rateOf(l), g, v);
      refundValue += g;
      refundVat += v;
    }
    for (const leg of r.legs) {
      refTender[leg.method]! += leg.amount;
      refTenderCount[leg.method]! += 1;
      refundMoney += leg.amount;
    }
    refundCredit += r.credit ?? 0;
    if (r.credit) {
      refTender.exchange! += r.credit;
      refTenderCount.exchange! += 1;
    }
  }

  const cashSales = tender.cash!;
  const cashRefunds = refTender.cash!;
  const expectedCash = opts.float + cashSales - cashRefunds;
  return {
    count: sales.length,
    items,
    vat,
    amountDue,
    discount,
    tips,
    tender,
    tenderCount,
    tipsBy,
    refTenderCount,
    byRate: by,
    refunds: {
      count: refunds.length,
      value: refundValue,
      vat: refundVat,
      money: refundMoney,
      credit: refundCredit,
    },
    refByRate: refBy,
    refTender,
    /** Takings after returns, as the reports show them (sales less value returned). */
    netTakings: amountDue - refundValue,
    expectedCash,
    overShort: opts.counted - expectedCash,
  };
}

/** The shop-local calendar day (YYYY-MM-DD) and hour of an instant, using only Intl. */
export function localParts(at: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/**
 * A fixed-offset time zone in which "now" falls on a different calendar day than in UTC (so the tests
 * prove that reports cut days in the shop's own zone) and that is not about to pass local midnight
 * (so a day does not change halfway through a test). UTC+14 differs from UTC from 10:00 UTC; UTC-12
 * differs until 12:00 UTC: between them one always qualifies. "Etc/GMT-14" is UTC+14 (the Etc names
 * have the sign reversed); neither zone has daylight saving.
 */
export function offsetZone(now = new Date()): string {
  const utcDay = now.toISOString().slice(0, 10);
  for (const tz of ["Etc/GMT-14", "Etc/GMT+12"]) {
    const { day, hour } = localParts(now, tz);
    const minutes = hour * 60 + now.getUTCMinutes();
    if (day !== utcDay && minutes <= 23 * 60) return tz;
  }
  throw new Error("unreachable: one of the two zones always qualifies");
}

export const euro = (cents: number) => {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}€${Math.trunc(abs / 100).toLocaleString("en-IE")}.${String(abs % 100).padStart(2, "0")}`;
};

export type DimRow = {
  qty: number;
  gross: number;
  vat: number;
  net: number;
  rQty: number;
  rGross: number;
};

/**
 * Item lines grouped by one report dimension (product, brand, size/colour ...), sales side and
 * refund side, the way the line reports show them. Only lines that carry that dimension count.
 */
export function byDim(
  sales: Sale[],
  refunds: Refund[],
  dim: "product" | "category" | "brand" | "sizeColour",
) {
  const out = new Map<string, DimRow>();
  const row = (k: string) => {
    let r = out.get(k);
    if (!r) out.set(k, (r = { qty: 0, gross: 0, vat: 0, net: 0, rQty: 0, rGross: 0 }));
    return r;
  };
  for (const s of sales)
    for (const l of s.lines) {
      const k = l[dim];
      if (!k) continue;
      const r = row(k);
      const v = vatIn(l.gross, l.rateBp);
      r.qty += l.qty ?? 1;
      r.gross += l.gross;
      r.vat += v;
      r.net += l.gross - v;
    }
  for (const rf of refunds)
    for (const rl of rf.lines) {
      const l = sales.find((s) => s.key === rl.sale)!.lines[rl.line]!;
      const k = l[dim];
      if (!k) continue;
      const r = row(k);
      r.rQty += rl.units;
      r.rGross += roundHalf(l.gross * rl.units, rl.of);
    }
  return out;
}

/**
 * A pattern for exactly this amount or count: not part of a longer number ("€50.55" must not match
 * "€50.557" or "€150.55"). Use with toContainText().
 */
export const exact = (text: string) =>
  new RegExp(`(?<![\\d.,])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d])`);
