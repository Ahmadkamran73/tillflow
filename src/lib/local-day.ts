import { localDate } from "@/lib/money";

/** The instant a shop-local day starts (00:00 in `timeZone`), for "today" reports. */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const [y, m, d] = localDate(instant, timeZone).split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)])) as Record<
    string,
    number
  >;
  // What the wall clock shows at `guess`, read as UTC, minus `guess` = the zone's offset then.
  const offset = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - guess;
  return new Date(guess - offset);
}
