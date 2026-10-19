"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { formatCents, overShort, parseCents } from "@/lib/money";
import type { CurrentShift } from "@/lib/register/db";
import type { ClosedShift, ShiftSummary } from "@/lib/register/shift";
import { Cancel, Modal } from "./dialogs";

// Shift dialogs (docs/specs/shifts.md): open with a float, cash in/out, X-report, close with a count.

/** An amount field in euros; empty or unreadable is `null`. Zero is a valid amount (a float of 0). */
function AmountField({
  label,
  value,
  onChange,
  onBlur,
  invalid,
  errorId,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  invalid: boolean;
  errorId: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <Input
        autoFocus={autoFocus}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        className="h-12 text-base tabular-nums md:text-base"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
    </label>
  );
}

/** One status line that is always on the page, so text put in it later is announced. */
const Status = ({ text }: { text: string }) => (
  <p role="status" className={text ? "text-sm" : "sr-only"}>
    {text}
  </p>
);

/** Selling is blocked until this is done, so it cannot be dismissed; the cashier can lock the till. */
export function OpenShiftDialog({
  onOpen,
  onLock,
}: {
  onOpen: (floatCents: number) => void | Promise<void>;
  onLock: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // a second tap must not open a second shift
    const n = parseCents(value);
    if (n === null || n > 10_000_000) return setError(true);
    setBusy(true);
    try {
      await onOpen(n);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={t("shift.openTitle")} description={t("shift.openBody")} onClose={() => {}}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <AmountField
          autoFocus
          label={t("shift.float")}
          value={value}
          onChange={(v) => {
            setValue(v);
            setError(false);
          }}
          invalid={error}
          errorId="float-error"
        />
        {error && (
          <p id="float-error" role="alert" className="text-destructive text-sm">
            {t("shift.floatInvalid")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" size="touch" variant="outline" onClick={onLock}>
            {t("lock.lockTill")}
          </Button>
          <Button type="submit" size="touch" aria-disabled={busy}>
            {busy ? t("shift.opening") : t("shift.open")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ShiftMenuDialog({
  shift,
  time,
  onCash,
  onReport,
  onCloseShift,
  onClose,
}: {
  shift: CurrentShift;
  time: string;
  onCash: (movement: "in" | "out") => void;
  onReport: () => void;
  onCloseShift: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={t("shift.menuTitle")}
      description={t("shift.menuBody", { time, float: formatCents(shift.floatCents) })}
      onClose={onClose}
    >
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" size="touch" variant="outline" onClick={() => onCash("in")}>
          {t("shift.cashIn")}
        </Button>
        <Button type="button" size="touch" variant="outline" onClick={() => onCash("out")}>
          {t("shift.cashOut")}
        </Button>
        <Button type="button" size="touch" variant="outline" onClick={onReport}>
          {t("shift.xReport")}
        </Button>
        <Button type="button" size="touch" onClick={onCloseShift}>
          {t("shift.close")}
        </Button>
      </div>
      <Cancel onClick={onClose} />
    </Modal>
  );
}

export function CashMoveDialog({
  movement,
  onSave,
  onClose,
}: {
  movement: "in" | "out";
  onSave: (amountCents: number, note: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [amountError, setAmountError] = useState(false);
  const [noteError, setNoteError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // a second tap must not record the movement twice
    const n = parseCents(amount);
    const badAmount = n === null || n < 1 || n > 10_000_000;
    const badNote = note.trim().length === 0;
    setAmountError(badAmount);
    setNoteError(badNote);
    if (badAmount || badNote || n === null) return;
    setBusy(true);
    try {
      await onSave(n, note.trim());
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={t(movement === "in" ? "shift.cashIn" : "shift.cashOut")} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <AmountField
          autoFocus
          label={t("shift.amount")}
          value={amount}
          onChange={(v) => {
            setAmount(v);
            setAmountError(false);
          }}
          invalid={amountError}
          errorId="amount-error"
        />
        {amountError && (
          <p id="amount-error" role="alert" className="text-destructive text-sm">
            {t("shift.amountInvalid")}
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("shift.note")}
          <Input
            autoComplete="off"
            maxLength={200}
            value={note}
            aria-invalid={noteError}
            aria-describedby={noteError ? "note-error move-hint" : "move-hint"}
            className="h-12 text-base md:text-base"
            onChange={(e) => {
              setNote(e.target.value);
              setNoteError(false);
            }}
          />
          <span id="move-hint" className="text-muted-foreground text-xs font-normal">
            {t("shift.noteHint")}
          </span>
        </label>
        {noteError && (
          <p id="note-error" role="alert" className="text-destructive text-sm">
            {t("shift.noteInvalid")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Cancel onClick={onClose} />
          <Button type="submit" size="touch" aria-disabled={busy}>
            {t("shift.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The figures of a shift as a list; reused by the X-report and the close step. */
function Figures({ s }: { s: ShiftSummary }) {
  const rows: [string, string][] = [
    [`${t("shift.sales")} (${s.saleCount})`, formatCents(s.salesCents)],
    [t("shift.cashSales"), formatCents(s.cashSalesCents)],
    [t("shift.cardSales"), formatCents(s.cardSalesCents)],
    [t("shift.tips"), formatCents(s.tipsCents)],
    [`${t("shift.refunds")} (${s.refundCount})`, formatCents(s.refundCents)],
    [t("shift.floatLabel"), formatCents(s.floatCents)],
    [t("shift.cashInLabel"), formatCents(s.cashInCents)],
    [t("shift.cashOutLabel"), formatCents(s.cashOutCents)],
    [t("shift.expected"), formatCents(s.expectedCents)],
  ];
  return (
    <>
      <dl className="flex flex-col gap-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt>{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {s.rejectedCount > 0 && (
        <p role="note" className="text-sm font-semibold">
          {t("shift.waiting", { count: s.rejectedCount })}
        </p>
      )}
    </>
  );
}

const overShortText = (cents: number) =>
  cents === 0
    ? t("shift.balanced")
    : `${t(cents > 0 ? "shift.over" : "shift.short")} ${formatCents(Math.abs(cents))}`;

export function XReportDialog({
  summary,
  status,
  onPrint,
  onClose,
}: {
  summary: ShiftSummary;
  status: string;
  onPrint: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={t("shift.xTitle")} description={t("shift.xBody")} onClose={onClose}>
      <Figures s={summary} />
      <Status text={status} />
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" size="touch" variant="outline" onClick={onPrint}>
          {t("shift.print")}
        </Button>
        <Button type="button" size="touch" onClick={onClose}>
          {t("shift.done")}
        </Button>
      </div>
    </Modal>
  );
}

export function CloseShiftDialog({
  summary,
  onConfirm,
  onClose,
}: {
  summary: ShiftSummary;
  onConfirm: (countedCents: number) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  // Shown as you type, announced once when you leave the field (not on every digit).
  const [announced, setAnnounced] = useState("");
  const counted = parseCents(value);
  const overShortLine =
    counted !== null && counted <= 100_000_000
      ? `${t("shift.overShort")}: ${overShortText(overShort(counted, summary.expectedCents))}`
      : "";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // a second tap must not close the shift twice
    if (counted === null || counted > 100_000_000) return setError(true);
    setBusy(true);
    try {
      await onConfirm(counted);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={t("shift.closeTitle")} description={t("shift.closeBody")} onClose={onClose}>
      <Figures s={summary} />
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <AmountField
          autoFocus
          label={t("shift.counted")}
          value={value}
          onChange={(v) => {
            setValue(v);
            setError(false);
            setAnnounced("");
          }}
          onBlur={() => setAnnounced(overShortLine)}
          invalid={error}
          errorId="counted-error"
        />
        {error && (
          <p id="counted-error" role="alert" className="text-destructive text-sm">
            {t("shift.countedInvalid")}
          </p>
        )}
        <p aria-hidden className="text-sm font-semibold">
          {overShortLine}
        </p>
        <p role="status" className="sr-only">
          {announced}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Cancel onClick={onClose} />
          <Button type="submit" size="touch" aria-disabled={busy}>
            {busy ? t("shift.closing") : t("shift.confirmClose")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ShiftClosedDialog({
  closed,
  status,
  onPrint,
  onDone,
}: {
  closed: ClosedShift;
  status: string;
  onPrint: () => void;
  onDone: () => void;
}) {
  return (
    <Modal title={t("shift.closedTitle")} description={t("shift.closedBody")} onClose={() => {}}>
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex justify-between gap-4">
          <dt>{t("shift.expected")}</dt>
          <dd className="font-mono tabular-nums">{formatCents(closed.summary.expectedCents)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>{t("shift.countedLabel")}</dt>
          <dd className="font-mono tabular-nums">{formatCents(closed.countedCents)}</dd>
        </div>
        <div className="flex justify-between gap-4 font-semibold">
          <dt>{t("shift.overShort")}</dt>
          <dd className="font-mono tabular-nums">{overShortText(closed.overShortCents)}</dd>
        </div>
      </dl>
      <Status text={status} />
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" size="touch" variant="outline" onClick={onPrint}>
          {t("shift.print")}
        </Button>
        <Button type="button" size="touch" autoFocus onClick={onDone}>
          {t("shift.done")}
        </Button>
      </div>
    </Modal>
  );
}
