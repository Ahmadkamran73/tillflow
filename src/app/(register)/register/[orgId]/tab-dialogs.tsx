"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { evenShares, formatCents } from "@/lib/money";
import type { Cart } from "@/lib/register/cart";
import {
  MAX_SEATS,
  qtysBySeat,
  splitCart,
  type SplitError,
  type WholeBill,
} from "@/lib/register/tabs";
import { Cancel, Modal } from "./dialogs";

// Restaurant dialogs (docs/specs/restaurant.md): open a table, pick a bill, split a bill, move or merge.

/** How many guests sit down. Guests are numbered as seats on the order. */
export function CoversDialog({
  tableName,
  max,
  onOpen,
  onClose,
}: {
  tableName: string;
  max: number;
  onOpen: (covers: number) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const n = Number(value);
  const valid = /^\d{1,2}$/.test(value) && n >= 1 && n <= Math.min(max, MAX_SEATS);
  const limit = Math.min(max, MAX_SEATS);
  const showError = touched && !valid;
  return (
    <Modal title={t("tab.coversTitle", { name: tableName })} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (valid) onOpen(n);
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("tab.coversLabel")}
          <Input
            autoFocus
            inputMode="numeric"
            autoComplete="off"
            value={value}
            aria-invalid={showError}
            aria-describedby={showError ? "covers-error" : "covers-hint"}
            className="h-12 text-base tabular-nums md:text-base"
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <p id="covers-hint" className="text-muted-foreground text-sm">
          {t("tab.coversHint", { max: limit })}
        </p>
        {showError && (
          <p id="covers-error" role="alert" className="text-destructive text-sm">
            {t("tab.coversError", { max: limit })}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Cancel onClick={onClose} />
          <Button type="submit" size="touch">
            {t("tab.open")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A table with more than one bill (after a split): which one? */
export function TabPicker({
  tableName,
  items,
  onPick,
  onClose,
}: {
  tableName: string;
  items: { id: string; part: number; totalCents: number }[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={t("tab.pickTitle", { name: tableName })}
      description={t("tab.pickBody")}
      onClose={onClose}
    >
      <ul className="flex flex-col gap-2">
        {items.map((i) => (
          <li key={i.id}>
            <Button
              type="button"
              size="touch"
              variant="outline"
              className="w-full justify-between"
              onClick={() => onPick(i.id)}
            >
              {t("tab.pickItem", { part: i.part, amount: formatCents(i.totalCents) })}
            </Button>
          </li>
        ))}
      </ul>
      <Cancel onClick={onClose} />
    </Modal>
  );
}

type Mode = "seat" | "item" | "even";

/**
 * Splits the bill by seat, by item, or evenly. By seat and by item make separate bills, each paid
 * on its own as a normal sale. Evenly keeps one bill and takes it in several payments.
 */
export function SplitDialog({
  cart,
  whole,
  totalCents,
  onSplit,
  onEven,
  onClose,
}: {
  cart: Cart;
  whole: WholeBill;
  totalCents: number;
  onSplit: (carts: Cart[]) => void;
  onEven: (payers: number) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("seat");
  const [parts, setParts] = useState(2);
  const [payers, setPayers] = useState(2);
  // qtys[line][part]: units of a line given to a part (by item).
  const [qtys, setQtys] = useState<number[][]>(() => cart.lines.map((l) => [l.qty, 0]));
  const [error, setError] = useState("");

  const seat = qtysBySeat(cart);

  function setPartsTo(n: number) {
    const next = Math.min(6, Math.max(2, n));
    setParts(next);
    // Units move to the first part when a part disappears; new parts start empty.
    setQtys((q) =>
      q.map((row, i) => {
        const kept = row.slice(0, next);
        const lost = row.slice(next).reduce((s, x) => s + x, 0);
        while (kept.length < next) kept.push(0);
        kept[0] = (kept[0] ?? 0) + lost;
        void i;
        return kept;
      }),
    );
    setError("");
  }
  function step(line: number, part: number, delta: 1 | -1) {
    setQtys((q) =>
      q.map((row, i) => {
        if (i !== line) return row;
        const next = [...row];
        const v = (next[part] ?? 0) + delta;
        if (v < 0) return row;
        // Taking a unit for this part takes it from the first part that has one (or gives it back to part 1).
        const from = delta === 1 ? next.findIndex((x, p) => p !== part && x > 0) : -1;
        if (delta === 1 && from === -1) return row;
        next[part] = v;
        if (delta === 1) next[from] = (next[from] ?? 0) - 1;
        else next[part === 0 ? 1 : 0] = (next[part === 0 ? 1 : 0] ?? 0) + 1;
        return next;
      }),
    );
    setError("");
  }

  function go() {
    if (mode === "even") return onEven(payers);
    if (mode === "seat") {
      if (seat.seats.length < 2) return setError(t("split.errors.one_seat"));
      const r = splitCart(cart, seat.qtys, seat.seats.length, whole);
      return r.ok ? onSplit(r.carts) : setError(msg(r.error));
    }
    const r = splitCart(cart, qtys, parts, whole);
    return r.ok ? onSplit(r.carts) : setError(msg(r.error));
  }
  const msg = (e: SplitError) => t(`split.errors.${e}`);

  const shares = evenShares(totalCents, payers);
  const modes: [Mode, string][] = [
    ["seat", t("split.bySeat")],
    ["item", t("split.byItem")],
    ["even", t("split.evenly")],
  ];
  return (
    <Modal title={t("split.title")} description={t("split.intro")} onClose={onClose}>
      <div role="group" aria-label={t("split.mode")} className="grid grid-cols-3 gap-2">
        {modes.map(([m, label]) => (
          <Button
            key={m}
            type="button"
            size="touch"
            variant={mode === m ? "default" : "outline"}
            aria-pressed={mode === m}
            onClick={() => {
              setMode(m);
              setError("");
            }}
          >
            {label}
          </Button>
        ))}
      </div>

      {mode === "seat" && (
        <div className="flex flex-col gap-2 text-sm">
          <p>{t("split.seatsFound", { count: seat.seats.length })}</p>
          <ul className="flex flex-col gap-1">
            {seat.seats.map((s, p) => (
              <li key={s}>
                {t("split.seatLine", {
                  n: s,
                  items: cart.lines
                    .map((l, i) => (seat.qtys[i]![p] ? `${seat.qtys[i]![p]} × ${l.name}` : ""))
                    .filter(Boolean)
                    .join(", "),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {mode === "item" && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span id="parts-label" className="text-sm font-medium">
              {t("split.partsLabel")}
            </span>
            <Button
              size="icon-touch"
              variant="outline"
              aria-label={`${t("split.partsLabel")} −`}
              onClick={() => setPartsTo(parts - 1)}
            >
              −
            </Button>
            <span
              aria-labelledby="parts-label"
              className="min-w-8 text-center text-lg font-semibold tabular-nums"
            >
              {parts}
            </span>
            <Button
              size="icon-touch"
              variant="outline"
              aria-label={`${t("split.partsLabel")} +`}
              onClick={() => setPartsTo(parts + 1)}
            >
              +
            </Button>
          </div>
          <ul className="flex max-h-[40dvh] flex-col gap-3 overflow-y-auto">
            {cart.lines.map((l, i) => (
              <li key={l.id} className="border-border flex flex-col gap-1 border-b pb-2">
                <span className="font-medium">
                  {t("split.itemRow", { name: l.name, qty: l.qty })}
                </span>
                <div className="flex flex-wrap gap-3">
                  {qtys[i]!.map((n, p) => (
                    <div
                      key={p}
                      className="flex items-center gap-2"
                      role="group"
                      aria-label={`${l.name}, ${t("split.partName", { n: p + 1 })}`}
                    >
                      <span className="text-xs">{t("split.partName", { n: p + 1 })}</span>
                      <Button
                        size="icon-touch"
                        variant="outline"
                        aria-label={`${l.name}, ${t("split.partName", { n: p + 1 })} −`}
                        onClick={() => step(i, p, -1)}
                      >
                        −
                      </Button>
                      <span className="min-w-6 text-center font-semibold tabular-nums">{n}</span>
                      <Button
                        size="icon-touch"
                        variant="outline"
                        aria-label={`${l.name}, ${t("split.partName", { n: p + 1 })} +`}
                        onClick={() => step(i, p, 1)}
                      >
                        +
                      </Button>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {mode === "even" && (
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-center gap-2">
            <span id="payers-label" className="font-medium">
              {t("split.payersLabel")}
            </span>
            <Button
              size="icon-touch"
              variant="outline"
              aria-label={`${t("split.payersLabel")} −`}
              onClick={() => setPayers((n) => Math.max(2, n - 1))}
            >
              −
            </Button>
            <span
              aria-labelledby="payers-label"
              className="min-w-8 text-center text-lg font-semibold tabular-nums"
            >
              {payers}
            </span>
            <Button
              size="icon-touch"
              variant="outline"
              aria-label={`${t("split.payersLabel")} +`}
              onClick={() => setPayers((n) => Math.min(10, n + 1))}
            >
              +
            </Button>
          </div>
          <p>
            {t("split.eachPays", {
              amount: formatCents(shares[0]!),
              last: formatCents(shares[shares.length - 1]!),
            })}
          </p>
          <p className="text-muted-foreground">{t("split.evenHint", { count: payers })}</p>
        </div>
      )}

      <p role="status" className="sr-only">
        {mode === "item" ? t("split.partsValue", { count: parts }) : ""}
        {mode === "even" ? t("split.payersValue", { count: payers }) : ""}
      </p>
      <p role="alert" className={error ? "text-destructive text-sm" : "sr-only"}>
        {error}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Cancel onClick={onClose} />
        <Button type="button" size="touch" onClick={go}>
          {mode === "even"
            ? t("split.pay")
            : t("split.go", { count: mode === "seat" ? seat.seats.length : parts })}
        </Button>
      </div>
    </Modal>
  );
}

/** Move a tab to a free table, or merge it into a table that has an order. */
export function MoveDialog({
  tableName,
  free,
  busy,
  onTransfer,
  onMerge,
  onClose,
}: {
  tableName: string;
  free: { id: string; label: string }[];
  busy: { id: string; label: string }[];
  onTransfer: (id: string) => void;
  onMerge: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={t("move.title", { name: tableName })} onClose={onClose}>
      <div className="flex max-h-[55dvh] flex-col gap-4 overflow-y-auto">
        <fieldset className="flex flex-col gap-2">
          <legend className="font-semibold">{t("move.transfer")}</legend>
          {free.length === 0 && <p className="text-muted-foreground text-sm">{t("move.none")}</p>}
          <div className="grid grid-cols-3 gap-2">
            {free.map((o) => (
              <Button
                key={o.id}
                type="button"
                size="touch"
                variant="outline"
                onClick={() => onTransfer(o.id)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="font-semibold">{t("move.merge")}</legend>
          {busy.length === 0 && <p className="text-muted-foreground text-sm">{t("move.none")}</p>}
          <div className="grid grid-cols-3 gap-2">
            {busy.map((o) => (
              <Button
                key={o.id}
                type="button"
                size="touch"
                variant="outline"
                onClick={() => onMerge(o.id)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </fieldset>
      </div>
      <Cancel onClick={onClose} />
    </Modal>
  );
}
