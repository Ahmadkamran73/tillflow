import { localDate } from "@/lib/money";

/**
 * Billing periods are whole months counted from an anchor date (the first day after the trial),
 * in Irish local dates. Dates are `YYYY-MM-DD` strings; nothing here depends on the server's time
 * zone. A period runs from `start` up to but not including the next start.
 */
export const BILLING_TIME_ZONE = "Europe/Dublin";

type Ymd = { y: number; m: number; d: number };

function parse(date: string): Ymd {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`not a date: ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function fmt({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `anchor` plus `months` months, keeping the anchor's day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(anchor: string, months: number): string {
  const a = parse(anchor);
  const index = a.y * 12 + (a.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return fmt({ y, m, d: Math.min(a.d, daysInMonth(y, m)) });
}

/** `date` plus `days` days. */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parse(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

/** Whole days from `a` to `b` (negative if `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86_400_000);
}

/** `2026-11-05` as `05/11/2026`. */
export function irishDate(ymd: string): string {
  const { y, m, d } = parse(ymd);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

/** Irish local date of an instant. */
export function dublinDate(instant: Date): string {
  return localDate(instant, BILLING_TIME_ZONE);
}

/** The n-th period (0 = first) of a subscription anchored on `anchor`. */
export function periodN(anchor: string, n: number): { start: string; end: string } {
  return { start: addMonths(anchor, n), end: addMonths(anchor, n + 1) };
}

/** Which period (index from 0) contains `date`; -1 if it is before the anchor. */
export function periodIndexOf(anchor: string, date: string): number {
  if (date < anchor) return -1;
  const a = parse(anchor);
  const t = parse(date);
  let n = (t.y - a.y) * 12 + (t.m - a.m);
  if (addMonths(anchor, n) > date) n -= 1;
  return n;
}

/** The first period starts the day the trial ends (shop-local). */
export function firstPeriodStart(trialEndsAt: Date): string {
  return dublinDate(trialEndsAt);
}

export type DunningState = "current" | "reminder_1" | "reminder_2" | "pause";

/**
 * Where an unpaid invoice stands on `today`: before its due date it is current; from the due date
 * the first reminder is owed; from seven days after it the second; once more than `graceDays`
 * have passed since the due date the account is paused. The states are ordered:
 * a job that was down sends the reminder it has reached (and the one before it, once, because each
 * send is stamped on the invoice); once the pause is due it pauses and says so, without the older
 * reminders. With fewer than 7 grace days there is no second reminder.
 */
export function dunningState(today: string, dueOn: string, graceDays: number): DunningState {
  const late = daysBetween(dueOn, today);
  if (late < 0) return "current";
  if (late > graceDays) return "pause";
  return late >= 7 ? "reminder_2" : "reminder_1";
}
