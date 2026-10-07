"use client";

import { CheckIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import {
  cashDueOf,
  centsToInput,
  defaultNonCashAmount,
  formatCents,
  parseCents,
  quickCash,
  settleTenders,
  type TenderMethod,
} from "@/lib/money";
import type { LocalTender } from "@/lib/register/db";
import { tenderReference } from "@/lib/register/tender-input";
import { Cancel, Modal } from "./dialogs";

/** A way of taking payment offered on this till (`id` is null only for the built-in fallback). */
export type TenderOption = { id: string | null; method: TenderMethod; label: string };

const toLine = (x: LocalTender) => ({ method: x.method, amount: x.amountCents, tip: x.tipCents });

/**
 * Split tender. Card and voucher amounts are added first (the shop's own terminal takes the card;
 * Tillflow only records it), cash comes last and completes the sale, because change can only ever
 * come from cash. Everything shown comes from `settleTenders` in the money library; the server
 * re-checks the same sums.
 */
export function TenderDialog({
  total,
  options,
  tipsAllowed,
  roundCash,
  initial,
  onChange,
  onComplete,
  onClose,
}: {
  /** The sale total, VAT-inclusive, before any cash rounding. */
  total: number;
  options: TenderOption[];
  tipsAllowed: boolean;
  /** Cash is rounded to 5c (the shop's preset). */
  roundCash: boolean;
  /** Payments already taken for this same cart (restored after a reload). */
  initial: LocalTender[];
  /** Called whenever the list changes, so it can be kept across a reload. */
  onChange: (tenders: LocalTender[]) => void;
  onComplete: (tenders: LocalTender[]) => void;
  onClose: () => void;
}) {
  const [tenders, setTenders] = useState<LocalTender[]>(initial);
  const [panel, setPanel] = useState<TenderOption | null>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [tip, setTip] = useState("");
  const [error, setError] = useState("");
  // Which field the error belongs to, so only that field is marked invalid and gets focus.
  const [errorField, setErrorField] = useState<"amount" | "reference" | "tip">("amount");
  const [note, setNote] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDListElement>(null);
  const seen = useRef(initial.length);
  const fail = (message: string, field: "amount" | "reference" | "tip" = "amount") => {
    setErrorField(field);
    setError(message);
  };
  const invalid = (field: "amount" | "reference" | "tip") => error !== "" && errorField === field;

  const settlement = settleTenders(total, tenders.map(toLine), { roundCash });
  const left = defaultNonCashAmount(total, tenders.map(toLine)); // what card/voucher/cash still have to settle
  const hasCash = tenders.some((x) => x.method === "cash");

  useEffect(() => {
    onChange(tenders);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report changes only, not a new callback
  }, [tenders]);

  function choose(o: TenderOption) {
    setPanel(o);
    setError("");
    setReference("");
    setTip("");
    setAmount(o.method === "cash" ? "" : centsToInput(left));
  }

  // Focus follows what the cashier just did: into the fields of the chosen type, back to the
  // totals after a payment is added or removed (its button is gone), onto a field that is wrong.
  useEffect(() => {
    if (panel) panelRef.current?.querySelector<HTMLElement>("input")?.focus();
  }, [panel]);
  useEffect(() => {
    if (tenders.length !== seen.current) summaryRef.current?.focus();
    seen.current = tenders.length;
  }, [tenders.length]);
  useEffect(() => {
    if (error) document.getElementById(`tender-${errorField}`)?.focus();
  }, [error, errorField]);

  const add = (line: Omit<LocalTender, "id">) => {
    setTenders((ts) => [...ts, { id: uuidv7(), ...line }]);
    setPanel(null);
    setError("");
    setNote(t("tender.added", { label: line.label, amount: formatCents(line.amountCents) }));
  };

  function addNonCash(o: TenderOption) {
    const cents = parseCents(amount);
    if (cents === null || cents <= 0) return fail(t("tender.badAmount"));
    if (cents > left) return fail(t("tender.tooMuch", { amount: formatCents(left) }));
    const ref = tenderReference.safeParse(reference);
    if (!ref.success) {
      const cardLike = ref.error.issues.some((i) => i.message === "that looks like a card number");
      return fail(cardLike ? t("tender.cardNumber") : t("tender.badReference"), "reference");
    }
    let tipCents = 0;
    if (o.method === "card" && tipsAllowed && tip.trim() !== "") {
      const parsed = parseCents(tip);
      if (parsed === null || parsed < 0 || parsed > cents) return fail(t("tender.badTip"), "tip");
      tipCents = parsed;
    }
    add({
      typeId: o.id,
      method: o.method,
      amountCents: cents,
      tipCents,
      reference: ref.data || undefined,
      label: o.label,
    });
  }

  function takeCash(o: TenderOption, cents: number | null) {
    const cashDue = cashDueOf(left, roundCash);
    if (cents === null || cents <= 0 || cents < cashDue)
      return fail(t("tender.cashShort", { amount: formatCents(cashDue) }));
    const next = [
      ...tenders,
      {
        id: uuidv7(),
        typeId: o.id,
        method: "cash" as const,
        amountCents: cents,
        tipCents: 0,
        label: o.label,
      },
    ];
    if (!settleTenders(total, next.map(toLine), { roundCash }).ok)
      return fail(t("tender.cashShort", { amount: formatCents(cashDue) }));
    setTenders(next);
    onComplete(next);
  }

  function remove(x: LocalTender) {
    setTenders((ts) => ts.filter((y) => y.id !== x.id));
    setError("");
    setNote(
      x.method === "card"
        ? t("tender.removedCard", { label: x.label })
        : t("tender.removed", { label: x.label }),
    );
  }

  const cashDue = cashDueOf(left, roundCash);
  // Cash is offered only while something is left to pay and there is no cash tender yet.
  const offered = options.filter((o) => (o.method === "cash" ? !hasCash && left > 0 : left > 0));

  return (
    <Modal title={t("register.tenderTitle")} onClose={onClose}>
      <dl
        ref={summaryRef}
        tabIndex={-1}
        className="flex flex-col gap-1 tabular-nums outline-offset-4"
      >
        <div className="flex items-baseline justify-between">
          <dt className="text-heading font-semibold">{t("tender.total")}</dt>
          <dd className="font-display text-amount font-semibold">{formatCents(total)}</dd>
        </div>
        {settlement.nonCash > 0 && (
          <div className="text-muted-foreground flex justify-between text-sm">
            <dt>{t("tender.paid")}</dt>
            <dd>{formatCents(settlement.nonCash)}</dd>
          </div>
        )}
        <div className="flex justify-between font-semibold">
          <dt>{t("tender.left")}</dt>
          <dd>{formatCents(settlement.balance)}</dd>
        </div>
      </dl>

      {tenders.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label={t("tender.taken")}>
          {tenders.map((x) => (
            <li
              key={x.id}
              className="border-solid-border flex items-center justify-between gap-2 rounded-md border-2 p-2"
            >
              <span className="flex flex-col text-sm">
                <span className="font-semibold">
                  {x.label} {formatCents(x.amountCents)}
                </span>
                {x.tipCents > 0 && (
                  <span className="text-muted-foreground">
                    {t("tender.tipLine", { amount: formatCents(x.tipCents) })}
                  </span>
                )}
                {x.reference && (
                  <span className="text-muted-foreground">
                    {t("tender.refLine", { ref: x.reference })}
                  </span>
                )}
              </span>
              <Button
                type="button"
                size="touch"
                variant="outline"
                onClick={() => remove(x)}
                aria-label={t("tender.remove", {
                  label: x.label,
                  amount: formatCents(x.amountCents),
                })}
              >
                <Trash2Icon aria-hidden /> {t("tender.removeShort")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p role="status" className="text-muted-foreground text-sm">
        {note}
      </p>

      {left > 0 && (
        <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("tender.choose")}>
          {offered.map((o) => (
            <Button
              key={`${o.id}-${o.label}`}
              type="button"
              size="touch"
              variant={panel?.id === o.id && panel.label === o.label ? "default" : "outline"}
              aria-pressed={panel?.id === o.id && panel.label === o.label}
              onClick={() => choose(o)}
            >
              {panel?.id === o.id && panel.label === o.label && <CheckIcon aria-hidden />}
              {o.label}
            </Button>
          ))}
        </div>
      )}

      {panel && panel.method === "cash" && (
        <div ref={panelRef} className="flex flex-col gap-2">
          {settlement.rounding !== 0 || cashDue !== left ? (
            <p className="text-muted-foreground text-sm tabular-nums">
              {t("tender.cashDue", { amount: formatCents(cashDue) })}
              {cashDue !== left && ` (${t("register.rounding")} ${formatCents(cashDue - left)})`}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            {quickCash(cashDue).map((c, i) => (
              <Button
                key={c}
                type="button"
                size="touch"
                variant={i === 0 ? "default" : "outline"}
                onClick={() => takeCash(panel, c)}
              >
                {i === 0 ? `${t("register.exactCash")} ${formatCents(c)}` : formatCents(c)}
              </Button>
            ))}
          </div>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              takeCash(panel, parseCents(amount));
            }}
          >
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t("register.otherAmount")}
              <span className="text-muted-foreground text-xs font-normal">
                {t("register.otherAmountHint")}
              </span>
              <Input
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                id="tender-amount"
                aria-invalid={invalid("amount")}
                aria-describedby={invalid("amount") ? "tender-error" : undefined}
                className="h-12 text-base md:text-base"
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError("");
                }}
              />
            </label>
            <Button type="submit" size="touch">
              {t("tender.takeCash")}
            </Button>
          </form>
        </div>
      )}

      {panel && panel.method !== "cash" && (
        <div ref={panelRef}>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addNonCash(panel);
            }}
          >
            <label className="flex flex-col gap-1 text-sm font-medium">
              {panel.method === "card" ? t("tender.cardAmount") : t("tender.voucherAmount")}
              <span className="text-muted-foreground text-xs font-normal">
                {panel.method === "card" ? t("tender.cardHint") : t("tender.voucherHint")}
              </span>
              <Input
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                id="tender-amount"
                aria-invalid={invalid("amount")}
                aria-describedby={invalid("amount") ? "tender-error" : undefined}
                className="h-12 text-base md:text-base"
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError("");
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              {panel.method === "card" ? t("tender.reference") : t("tender.voucherNumber")}
              <span className="text-muted-foreground text-xs font-normal">
                {t("tender.referenceHint")}
              </span>
              <Input
                autoComplete="off"
                maxLength={40}
                value={reference}
                id="tender-reference"
                aria-invalid={invalid("reference")}
                aria-describedby={invalid("reference") ? "tender-error" : undefined}
                className="h-12 text-base md:text-base"
                onChange={(e) => {
                  setReference(e.target.value);
                  setError("");
                }}
              />
            </label>
            {panel.method === "card" && tipsAllowed && (
              <label className="flex flex-col gap-1 text-sm font-medium">
                {t("tender.tip")}
                <span className="text-muted-foreground text-xs font-normal">
                  {t("tender.tipHint")}
                </span>
                <Input
                  inputMode="decimal"
                  autoComplete="off"
                  id="tender-tip"
                  aria-invalid={invalid("tip")}
                  aria-describedby={invalid("tip") ? "tender-error" : undefined}
                  value={tip}
                  className="h-12 text-base md:text-base"
                  onChange={(e) => {
                    setTip(e.target.value);
                    setError("");
                  }}
                />
              </label>
            )}
            <Button type="submit" size="touch">
              {panel.method === "card" ? t("tender.approved") : t("tender.addVoucher")}
            </Button>
          </form>
        </div>
      )}

      {error && (
        <p id="tender-error" role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {!settlement.ok && (
        <p id="tender-finish-hint" className="text-muted-foreground text-sm">
          {t("tender.finishHint", { amount: formatCents(settlement.balance) })}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Cancel onClick={onClose} />
        <Button
          type="button"
          size="touch"
          aria-disabled={!settlement.ok}
          aria-describedby={settlement.ok ? undefined : "tender-finish-hint"}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          onClick={() => settlement.ok && onComplete(tenders)}
        >
          {t("register.completeSale")}
        </Button>
      </div>
    </Modal>
  );
}
