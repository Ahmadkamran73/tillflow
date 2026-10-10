import { v7 as uuidv7 } from "uuid";
import { apportion } from "@/lib/money";
import { unitWithModifiers, type Cart, type CartLine } from "./cart";
import type { LocalTab, LocalTabEvent, RegisterDb } from "./db";

// Restaurant tabs (docs/specs/restaurant.md). A tab is a working document on ONE till: a cart tied
// to a table, with seats, courses and what has been sent to the kitchen. It carries no money of
// its own: every bill (or part of a split bill) is paid as an ordinary sale, so the server prices
// and records it like any other. Tab events (open, send, fire, transfer, merge, close) queue in
// IndexedDB and sync after the sales; they exist for covers and the audit trail.

export type TableStatus = "free" | "seated" | "ordered" | "bill";
export const COURSES = [1, 2, 3, 4] as const;
export const MAX_SEATS = 30;

export const courseOf = (l: Pick<CartLine, "course">) => l.course ?? 1;
export const isSent = (l: Pick<CartLine, "sentAt">) => !!l.sentAt;

/** Free, seated (open, nothing ordered), ordered (something rung up) or bill (asked for or split). */
export function tableStatus(tabs: readonly LocalTab[]): TableStatus {
  const open = tabs.filter((t) => t.state === "open");
  if (open.length === 0) return "free";
  if (open.some((t) => t.billAt || t.splitFrom)) return "bill";
  return open.some((t) => t.cart.lines.length > 0) ? "ordered" : "seated";
}

/**
 * What a Send (or "Fire next course") would print: the lines not yet sent whose course has been
 * released. Send releases course 1 (and anything already fired); Fire next releases the next course
 * that has lines waiting. Returns null when there is nothing to send.
 */
export function pendingSend(
  tab: Pick<LocalTab, "cart" | "firedCourse">,
  fireNext: boolean,
): { course: number; lines: CartLine[] } | null {
  const waiting = tab.cart.lines.filter((l) => !isSent(l));
  if (waiting.length === 0) return null;
  let course = Math.max(tab.firedCourse, 1);
  if (fireNext) {
    const later = waiting.map(courseOf).filter((c) => c > tab.firedCourse);
    if (later.length === 0) return null;
    course = Math.min(...later);
  }
  const lines = waiting.filter((l) => courseOf(l) <= course);
  return lines.length ? { course, lines } : null;
}

/** The cart with these lines marked as sent: a sent line is never changed or removed again. */
export const markSent = (cart: Cart, ids: ReadonlySet<string>, at: string): Cart => ({
  ...cart,
  lines: cart.lines.map((l) => (ids.has(l.id) ? { ...l, sentAt: at } : l)),
});

export type SplitError = "empty_part" | "bad_quantities" | "too_many_parts";

/** What the whole bill comes to, from the money library: the parts must add up to exactly this. */
export type WholeBill = {
  /** Each cart line's gross after every line and basket discount, in cart order. */
  lineGross: readonly number[];
  /** The service charge on the whole bill, in cents. */
  serviceCents: number;
};

/**
 * Splits a cart into `parts` carts that add up to the whole bill to the cent. `qtys[i][p]` is how
 * many units of line i part p takes; every line's units must be handed out exactly.
 *
 * Nothing is rounded again per part. Each line's discounted gross (`whole.lineGross`) is shared
 * over the parts that take its units by largest remainder, and every part line is given the fixed
 * discount that leaves it exactly that share; the basket discount is folded in the same way. The
 * whole bill's service charge is shared over the parts by their food and drink the same way and
 * carried as a fixed share (`serviceCents`). The parts' lines, discounts and charges therefore sum
 * to the whole bill's, with ties going to the earlier part, always.
 */
export function splitCart(
  cart: Cart,
  qtys: readonly (readonly number[])[],
  parts: number,
  whole: WholeBill,
): { ok: true; carts: Cart[] } | { ok: false; error: SplitError } {
  if (parts < 2 || parts > 10) return { ok: false, error: "too_many_parts" };
  if (qtys.length !== cart.lines.length || whole.lineGross.length !== cart.lines.length)
    return { ok: false, error: "bad_quantities" };
  const lines: CartLine[][] = Array.from({ length: parts }, () => []);
  const food: number[] = Array(parts).fill(0);
  for (let i = 0; i < cart.lines.length; i++) {
    const line = cart.lines[i]!;
    const q = qtys[i]!;
    if (
      q.length !== parts ||
      q.some((n) => !Number.isInteger(n) || n < 0) ||
      q.reduce((s, n) => s + n, 0) !== line.qty
    )
      return { ok: false, error: "bad_quantities" };
    const takers = q.filter((n) => n > 0).length;
    const shares = apportion(whole.lineGross[i]!, q);
    const unit = unitWithModifiers(line);
    q.forEach((n, p) => {
      if (n === 0) return;
      const lost = unit * n - shares[p]!;
      const { discount: _discount, ...rest } = line;
      void _discount;
      lines[p]!.push({
        ...rest,
        qty: n,
        id: takers === 1 ? line.id : uuidv7(),
        ...(lost > 0 ? { discount: { amount: lost } } : {}),
      });
      food[p] = food[p]! + shares[p]!;
    });
  }
  if (lines.some((l) => l.length === 0)) return { ok: false, error: "empty_part" };
  const charge = cart.serviceBp
    ? apportion(cart.mode === "take_away" ? 0 : whole.serviceCents, food)
    : undefined;
  const { lines: _lines, discount: _discount, ...rest } = cart;
  void _lines;
  void _discount;
  return {
    ok: true,
    carts: lines.map((l, p) => ({
      ...rest,
      lines: l,
      ...(charge ? { serviceCents: charge[p]! } : {}),
    })),
  };
}

/** The seats on a cart (sorted), and each line wholly given to its seat; seatless lines go to the first seat. */
export function qtysBySeat(cart: Cart): { seats: number[]; qtys: number[][] } {
  const seats = [...new Set(cart.lines.map((l) => l.seat).filter((s): s is number => !!s))].sort(
    (a, b) => a - b,
  );
  if (seats.length === 0) seats.push(1);
  const qtys = cart.lines.map((l) => {
    const at = Math.max(0, seats.indexOf(l.seat ?? seats[0]!));
    return seats.map((_, p) => (p === at ? l.qty : 0));
  });
  return { seats, qtys };
}

const newEvent = (
  tab: Pick<LocalTab, "rootId" | "registerId">,
  kind: LocalTabEvent["kind"],
  cashierUserId: string,
  detail: LocalTabEvent["detail"],
  at: string,
): LocalTabEvent => ({
  id: uuidv7(),
  tabId: tab.rootId,
  registerId: tab.registerId,
  kind,
  cashierUserId,
  at,
  detail,
  syncState: "pending",
});

type Who = { cashierUserId: string };

/** The open tabs of this till. */
export const openTabs = (db: RegisterDb) => db.tabs.where("state").equals("open").toArray();

/** Opens a tab on a table (or a seat-less tab with no table) for `covers` guests. */
export async function openTab(
  db: RegisterDb,
  args: Who & {
    registerId: string;
    table: { id: string; name: string } | null;
    covers: number;
    serviceBp: number;
    mode?: Cart["mode"];
  },
): Promise<LocalTab> {
  const at = new Date().toISOString();
  const id = uuidv7();
  const tab: LocalTab = {
    id,
    rootId: id,
    registerId: args.registerId,
    tableId: args.table?.id ?? null,
    tableName: args.table?.name ?? "",
    covers: args.covers,
    cashierUserId: args.cashierUserId,
    openedAt: at,
    cart: { lines: [], ageChecked: true, mode: args.mode, serviceBp: args.serviceBp || undefined },
    firedCourse: 0,
    state: "open",
  };
  await db.transaction("rw", db.tabs, db.tabEvents, async () => {
    await db.tabs.add(tab);
    await db.tabEvents.add(
      newEvent(tab, "open", args.cashierUserId, { table: tab.tableName, covers: args.covers }, at),
    );
  });
  return tab;
}

/** Saves the cart of a tab as it is edited (lines, seats, courses). Closed tabs are left alone. */
export async function saveTabCart(db: RegisterDb, id: string, cart: Cart): Promise<void> {
  await db.tabs
    .where("id")
    .equals(id)
    .and((t) => t.state === "open")
    .modify({ cart });
}

/** Prints are the caller's job; this records that the lines were sent and queues the event. */
export async function recordSend(
  db: RegisterDb,
  tab: LocalTab,
  args: Who & { course: number; lineIds: string[]; fire: boolean },
): Promise<LocalTab> {
  const at = new Date().toISOString();
  const next: LocalTab = {
    ...tab,
    cart: markSent(tab.cart, new Set(args.lineIds), at),
    firedCourse: Math.max(tab.firedCourse, args.course),
  };
  await db.transaction("rw", db.tabs, db.tabEvents, async () => {
    await db.tabs.put(next);
    await db.tabEvents.add(
      newEvent(
        tab,
        args.fire ? "fire" : "send",
        args.cashierUserId,
        { table: tab.tableName, course: args.course, lines: args.lineIds.length },
        at,
      ),
    );
  });
  return next;
}

/** The bill was asked for: the table shows "bill" until it is paid. */
export async function requestBill(db: RegisterDb, id: string): Promise<void> {
  await db.tabs.update(id, { billAt: new Date().toISOString() });
}

/**
 * Replaces a tab by one tab per part (same table, same root), each to be paid on its own as an
 * ordinary sale. The old tab goes; nothing is lost because the parts hold every unit.
 */
export async function splitTab(db: RegisterDb, tab: LocalTab, carts: Cart[]): Promise<LocalTab[]> {
  const children = carts.map((cart, i): LocalTab => ({
    ...tab,
    id: uuidv7(),
    cart,
    splitFrom: tab.id,
    part: i + 1,
    billAt: tab.billAt ?? new Date().toISOString(),
  }));
  await db.transaction("rw", db.tabs, async () => {
    await db.tabs.delete(tab.id);
    await db.tabs.bulkAdd(children);
  });
  return children;
}

/** Moves a tab to a free table. */
export async function transferTab(
  db: RegisterDb,
  tab: LocalTab,
  to: { id: string; name: string },
  who: Who,
): Promise<void> {
  const at = new Date().toISOString();
  await db.transaction("rw", db.tabs, db.tabEvents, async () => {
    await db.tabs.where("rootId").equals(tab.rootId).modify({ tableId: to.id, tableName: to.name });
    await db.tabEvents.add(
      newEvent(tab, "transfer", who.cashierUserId, { from: tab.tableName, to: to.name }, at),
    );
  });
}

/** Merges `source` into `target` (two tables become one bill): lines move across, source goes. */
export async function mergeTabs(
  db: RegisterDb,
  source: LocalTab,
  target: LocalTab,
  who: Who,
): Promise<LocalTab> {
  const at = new Date().toISOString();
  const next: LocalTab = {
    ...target,
    covers: target.covers + source.covers,
    cart: { ...target.cart, lines: [...target.cart.lines, ...source.cart.lines] },
    firedCourse: Math.max(target.firedCourse, source.firedCourse),
  };
  await db.transaction("rw", db.tabs, db.tabEvents, async () => {
    await db.tabs.put(next);
    await db.tabs.delete(source.id);
    await db.tabEvents.add(
      newEvent(
        source,
        "merge",
        who.cashierUserId,
        { from: source.tableName, to: target.tableName, mergedTab: target.rootId },
        at,
      ),
    );
  });
  return next;
}

/**
 * Closes a tab after its bill was paid (or an empty tab was released). The close event goes out
 * with the last open part of the root.
 */
export async function closeTab(
  db: RegisterDb,
  tab: LocalTab,
  who: Who,
  kind: "close" | "void" = "close",
): Promise<void> {
  const at = new Date().toISOString();
  await db.transaction("rw", db.tabs, db.tabEvents, async () => {
    await db.tabs.update(tab.id, { state: "closed", closedAt: at });
    const left = await db.tabs
      .where("rootId")
      .equals(tab.rootId)
      .and((t) => t.state === "open")
      .count();
    if (left === 0)
      await db.tabEvents.add(
        newEvent(tab, kind, who.cashierUserId, { table: tab.tableName, parts: tab.part ?? 1 }, at),
      );
  });
}

/** Closed tabs and their synced events leave the device after a day; open tabs never do. */
export async function pruneTabs(db: RegisterDb, now = Date.now()): Promise<void> {
  const old = await db.tabs
    .where("state")
    .equals("closed")
    .and((t) => new Date(t.closedAt ?? 0).getTime() < now - 86_400_000)
    .primaryKeys();
  if (old.length) await db.tabs.bulkDelete(old);
}
