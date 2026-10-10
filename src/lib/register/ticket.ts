import type { Cart, CartLine } from "./cart";

export type Station = "bar" | "kitchen";
export const stations: readonly Station[] = ["bar", "kitchen"];

export type TicketLabels = {
  order: string;
  eatIn: string;
  takeAway: string;
  allergens: string;
  /** Display name of an allergen code. */
  allergen: (code: string) => string;
};

/** Breaks `s` into lines of at most `cols` characters; continuation lines start with `indent`. */
export function wrapText(s: string, cols: number, indent = ""): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of s.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : indent + w;
    if (next.length > cols && cur) {
      out.push(cur);
      cur = indent + w;
    } else cur = next;
    while (cur.length > cols) {
      out.push(cur.slice(0, cols));
      cur = indent + cur.slice(cols);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * One kitchen or bar ticket per station that has lines (bar first). Amounts never appear: a ticket
 * is for the person making the order. `stationOf` says where a line is made (by its category).
 */
export function buildTickets(args: {
  cart: Pick<Cart, "mode" | "orderName"> & { lines: readonly CartLine[] };
  /** Printed receipt number, e.g. "Till 1 · 000042". */
  number: string;
  /** Shop-local time, e.g. "14:32". */
  time: string;
  /** Paper width of each station's printer. */
  colsOf: (station: Station) => number;
  stationOf: (line: CartLine) => Station;
  labels: TicketLabels;
}): { station: Station; lines: string[] }[] {
  const { cart, labels } = args;
  return stations.flatMap((station) => {
    const cols = args.colsOf(station);
    const rule = "-".repeat(cols);
    const mine = cart.lines.filter((l) => args.stationOf(l) === station);
    if (mine.length === 0) return [];
    const out: string[] = [station.toUpperCase(), `${labels.order} ${args.number}`];
    if (cart.orderName) out.push(...wrapText(cart.orderName.toUpperCase(), cols));
    out.push(cart.mode === "take_away" ? labels.takeAway : labels.eatIn, args.time, rule);
    for (const l of mine) {
      out.push(...wrapText(`${l.qty} x ${l.name}`, cols));
      for (const m of l.modifiers) out.push(...wrapText(m.name, cols, "   + "));
      if (l.allergens?.length)
        out.push(
          ...wrapText(
            `${labels.allergens}: ${l.allergens.map(labels.allergen).join(", ")}`,
            cols,
            "   ",
          ),
        );
    }
    out.push(rule);
    return [{ station, lines: out }];
  });
}

/** The printable allergen list: every item that declares allergens, with their names. */
export function allergenListLines(
  items: readonly { name: string; allergens: readonly string[] }[],
  cols: number,
  title: string,
  allergen: (code: string) => string,
): string[] {
  const out = [title, "-".repeat(cols)];
  for (const i of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
    if (i.allergens.length === 0) continue;
    out.push(...wrapText(i.name, cols));
    out.push(...wrapText(i.allergens.map(allergen).join(", "), cols, "  "));
  }
  return out;
}
