import { z } from "zod";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MS_DAY = 86_400_000;

/** `YYYY-MM-DD` as a UTC day number; null when it is not a real calendar date. */
function dayNumber(s: string): number | null {
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s ? null : ms / MS_DAY;
}

/** `YYYY-MM-DD` moved by `days` (calendar days; no clock or time zone involved). */
export function addDays(s: string, days: number): string {
  const n = dayNumber(s);
  if (n === null) throw new RangeError("bad date");
  return new Date((n + days) * MS_DAY).toISOString().slice(0, 10);
}

/** Longest range a report covers (the database allows 400). */
export const MAX_DAYS = 366;

/**
 * What every report screen and every export reads from the URL: the same parse, so an export is
 * exactly what the screen shows. `from` and `to` are shop-local days, both included.
 */
export const reportParams = z
  .object({
    from: day,
    to: day,
    q: z.string().trim().max(60).optional(),
  })
  .refine((p) => dayNumber(p.from) !== null && dayNumber(p.to) !== null, "bad date")
  .refine((p) => p.from <= p.to, "from after to")
  .refine((p) => dayNumber(p.to)! - dayNumber(p.from)! < MAX_DAYS, "range too long");
export type ReportParams = z.infer<typeof reportParams>;

/** The last 30 days including today, for a screen opened with no dates. */
export const defaultParams = (today: string): ReportParams => ({
  from: addDays(today, -29),
  to: today,
});

/** Parse URL search params, falling back to the default range when absent or invalid. */
export function parseReportParams(
  raw: Record<string, string | string[] | undefined>,
  today: string,
): ReportParams {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const r = reportParams.safeParse({ from: one(raw.from), to: one(raw.to), q: one(raw.q) || undefined });
  return r.success ? r.data : defaultParams(today);
}

/** Quick ranges for the filter bar (shop-local `today`). VAT periods are the Irish bi-monthly ones. */
export function presets(today: string) {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const first = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  const lastOf = (yy: number, mm: number) => addDays(first(mm === 12 ? yy + 1 : yy, mm === 12 ? 1 : mm + 1), -1);
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const pStart = m % 2 === 1 ? m : m - 1; // Jan-Feb, Mar-Apr ... the VAT3 period holding today
  const lastP = pStart === 1 ? { y: y - 1, m: 11 } : { y, m: pStart - 2 };
  return {
    today: { from: today, to: today },
    last7: { from: addDays(today, -6), to: today },
    last30: { from: addDays(today, -29), to: today },
    thisMonth: { from: first(y, m), to: today },
    lastMonth: { from: first(prev.y, prev.m), to: lastOf(prev.y, prev.m) },
    vatPeriod: { from: first(y, pStart), to: lastOf(y, pStart + 1) },
    lastVatPeriod: { from: first(lastP.y, lastP.m), to: lastOf(lastP.y, lastP.m + 1) },
  };
}
