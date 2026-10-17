import type { Period } from "./provider";
import { dublinDate, firstPeriodStart, periodIndexOf, periodN } from "./period";

/** The facts the database gives about a business (ops.billing_candidates), already parsed. */
export type ScheduleFacts = {
  anchorDate: string | null;
  trialEndsAt: Date | null;
  lastPeriodStart: string | null;
  /** The day a paused business was reopened; months that passed while it was paused are not billed. */
  resumedOn?: string | null;
};

/**
 * The period to invoice next, or null if nothing is due yet.
 * - Before the first invoice: once the trial has ended, a month starting the day it ended.
 * - After that: the month after the latest invoice, from the day that month starts (invoices are
 *   issued in advance). Months are counted from the anchor, so 31 January stays on the 31st.
 * The caller has already skipped businesses with an unpaid invoice, so at most one is open.
 */
export function nextPeriod(f: ScheduleFacts, now: Date): Period | null {
  if (f.lastPeriodStart === null) {
    if (f.trialEndsAt === null || f.trialEndsAt > now) return null;
    return periodN(f.anchorDate ?? firstPeriodStart(f.trialEndsAt), 0);
  }
  const anchor = f.anchorDate ?? f.lastPeriodStart;
  const index = periodIndexOf(anchor, f.lastPeriodStart);
  if (index < 0) return null;
  const next = periodN(anchor, index + 1);
  const today = dublinDate(now);
  // Reopened after being paused past the end of the last invoiced period: nothing is charged for the
  // gap, and the next period starts on the day it was reopened.
  if (f.resumedOn && f.resumedOn > next.start && f.resumedOn <= today)
    return periodN(f.resumedOn, 0);
  return next.start <= today ? next : null;
}
