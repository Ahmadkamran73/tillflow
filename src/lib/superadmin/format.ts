const dateTime = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dateOnly = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** An instant as `05/11/2026, 14:30` in Irish time, or `fallback` for null. */
export function irishDateTime(iso: string | null, fallback: string): string {
  return iso ? dateTime.format(new Date(iso)) : fallback;
}

export function irishDay(iso: string | null, fallback: string): string {
  return iso ? dateOnly.format(new Date(iso)) : fallback;
}
