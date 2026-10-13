"use client";

import { ArrowLeftIcon, CheckIcon, MinusIcon, PlusIcon, ScanLineIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RegisterOptions } from "@/config/business-type-presets";
import { t } from "@/lib/i18n";
import {
  cashDueOf,
  centsToInput,
  formatCents,
  localDate,
  parseCents,
  refundNeedsOverride,
  settleRefund,
  suggestRefundLegs,
  type RateRow,
  type RefundLeg,
} from "@/lib/money";
import { priceCart } from "@/lib/register/cart";
import type { LocalRefund, LocalRefundLeg, LocalSale, RegisterDb } from "@/lib/register/db";
import type { Feed } from "@/lib/register/feed";
import {
  applyLocalRefunds,
  completeRefund,
  type RefundInput,
  detailOfLocalSale,
  findLocalSale,
  lookupOnServer,
  pendingRefunds,
  recentLocalSales,
  refundsOfSale,
  saleIdOfCode,
} from "@/lib/register/refund";
import { receiptNo } from "@/lib/register/sale";
import {
  canApprove,
  type PinResult,
  type RefundBind,
  type StaffMember,
} from "@/lib/register/staff";
import { tenderReference } from "@/lib/register/tender-input";
import { useScanner } from "@/lib/register/use-scanner";
import { availableOf, isServiceLine, type SaleDetail } from "@/lib/sync/refund-detail";
import { priceRefundLines, type RefundPick } from "@/lib/sync/refund-price";
import { refundReasonCodes, type RefundReasonCode } from "@/lib/sync/refund-protocol";
import { Cancel, Modal } from "./dialogs";
import { OverrideDialog } from "./override-dialog";
import type { TenderOption } from "./tender-dialog";

/** Shown after a refund is saved: what to hand back, and the receipt. */
export function RefundDoneDialog({
  refund,
  status,
  onPrint,
  onNewSale,
}: {
  refund: LocalRefund;
  status: string;
  onPrint: () => void;
  onNewSale: () => void;
}) {
  const out = refund.legs.reduce((n, l) => n + l.amountCents, 0);
  return (
    <Modal
      title={t(refund.kind === "void" ? "refund.doneVoid" : "refund.done")}
      onClose={() => {}}
    >
      <p role="status" className="text-heading font-semibold tabular-nums">
        {out > 0
          ? t("refund.doneAmount", { amount: formatCents(out) })
          : t("refund.doneNothing")}
      </p>
      {refund.legs.length > 0 && (
        <ul className="flex flex-col gap-1">
          {refund.legs.map((l) => (
            <li key={l.id} className="flex justify-between">
              <span>{l.label}</span>
              <span className="font-mono tabular-nums">{formatCents(l.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
      <p role="status" className="text-muted-foreground text-sm">
        {status}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" size="touch" variant="outline" onClick={onPrint}>
          {t("refund.printAgain")}
        </Button>
        {/* Focus starts here, not on "Print again": a committing screen must not reprint by accident. */}
        <Button type="button" size="touch" autoFocus onClick={onNewSale}>
          {t("refund.newSale")}
        </Button>
      </div>
    </Modal>
  );
}

type Step = "find" | "lines" | "pay" | "approve";
type Role = StaffMember["role"];

/** What the cashier chose to give back by card; cash is always the remainder. */
type Pay = {
  card: string;
  cardType: string | null;
  cashType: string | null;
  cardRef: string;
  tip: string;
};

const methodOptions = (options: TenderOption[], method: "cash" | "card") =>
  options.filter((o) => o.method === method);

/**
 * Refund or void a sale (docs/specs/refunds.md). Find the sale (scan the receipt, pick a recent
 * one, type its number or a serial), choose the lines and a reason, choose how the money goes back
 * (each method up to what it took), and a manager approves when it is above the shop's limit or is
 * a void. Everything is saved on the device first and synced like a sale; the original sale is
 * never edited. All amounts come from the money library; the server recomputes them.
 */
export function RefundDialog({
  db,
  orgId,
  tillId,
  tillName,
  org,
  rates,
  register,
  role,
  cashierId,
  servingToken,
  staff,
  offline,
  tenderOptions,
  roundCash,
  refundLimitCents,
  cartTotalCents,
  verify,
  initialCode,
  onClose,
  onDone,
  onExchange,
}: {
  db: RegisterDb;
  orgId: string;
  tillId: string;
  tillName: (registerId: string) => string;
  org: Feed["org"];
  rates: RateRow[];
  register: RegisterOptions;
  role: Role;
  cashierId: string;
  /** The server's signed proof of who is serving (online unlock); sent with the refund and the lookup. */
  servingToken?: string;
  staff: StaffMember[];
  offline: boolean;
  tenderOptions: TenderOption[];
  roundCash: boolean;
  refundLimitCents: number;
  /** What the cart on screen comes to (0 when empty): an exchange spends returned goods on it. */
  cartTotalCents: number;
  /** Checks a manager's PIN; a refund approval is for this one sale and up to this value. */
  verify: (member: StaffMember, pin: string, bind: RefundBind) => Promise<PinResult>;
  /** A receipt code scanned on the main screen, to look up straight away. */
  initialCode?: string;
  onClose: () => void;
  onDone: (refund: LocalRefund) => void;
  /** An exchange was saved: the sale to ring up next, and the credit it takes. */
  onExchange: (e: { input: RefundInput; saleId: string; creditCents: number }) => void;
}) {
  const [step, setStep] = useState<Step>("find");
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [found, setFound] = useState<SaleDetail[]>([]);
  const [recent, setRecent] = useState<SaleDetail[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [numberText, setNumberText] = useState("");
  const [serialText, setSerialText] = useState("");

  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [restock, setRestock] = useState<Record<number, boolean>>({});
  const [whole, setWhole] = useState(false);
  // An exchange: the returned goods become credit on the sale in the cart.
  const [exchange, setExchange] = useState(false);
  // The new sale's id is made now because the exchange refund names it.
  const [exchangeSaleId] = useState(() => uuidv7());
  const [exchangeRefundId] = useState(() => uuidv7());
  const [reason, setReason] = useState<RefundReasonCode | "">("");
  const [note, setNote] = useState("");
  const [pay, setPay] = useState<Pay | null>(null);

  // The window's content changes in place from step to step, so the focused button disappears:
  // put focus on the new step's heading, which a screen reader then reads out.
  useEffect(() => {
    if (step === "find" || step === "approve") return;
    const frame = requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>(
        '[role="dialog"] [data-slot="dialog-title"]',
      );
      heading?.setAttribute("tabindex", "-1");
      heading?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [step]);
  const [payError, setPayError] = useState("");

  /** A sale held on this device, as the server would describe it (rates of the day it was sold). */
  const localDetail = useCallback(
    async (sale: LocalSale): Promise<SaleDetail | null> => {
      try {
        const priced = priceCart(sale.cart, {
          country: org.country,
          date: localDate(new Date(sale.completedAt), org.timezone),
          rates,
        });
        const base = detailOfLocalSale(sale, priced, tillName(sale.registerId));
        return applyLocalRefunds(base, await refundsOfSale(db, sale.id));
      } catch {
        return null; // cannot be priced here (a missing rate): the server lookup may still find it
      }
    },
    [db, org.country, org.timezone, rates, tillName],
  );

  // Recent sales on this device: the quick way in, and it works offline.
  useEffect(() => {
    let live = true;
    void (async () => {
      const sales = await recentLocalSales(db, 12);
      const details = (await Promise.all(sales.map(localDetail))).filter(
        (d): d is SaleDetail => d !== null,
      );
      if (live) setRecent(details);
    })();
    return () => {
      live = false;
    };
  }, [db, localDetail]);

  const search = useCallback(
    async (
      q:
        | { by: "id"; id: string }
        | { by: "receipt"; seq: number }
        | { by: "serial"; serial: string },
    ) => {
      setBusy(true);
      setMessage(t("refund.searching"));
      const results = new Map<string, SaleDetail>();
      const local = await findLocalSale(
        db,
        q.by === "receipt" ? { by: "receipt", registerId: tillId, seq: q.seq } : q,
      );
      for (const sale of local) {
        const d = await localDetail(sale);
        if (d) results.set(d.sale.id, d);
      }
      let note = "";
      if (!offline) {
        const server = await lookupOnServer(
          orgId,
          q.by === "receipt" ? { by: "receipt", registerId: tillId, seq: q.seq } : q,
          servingToken,
        );
        if (server.status === "ok") {
          // The server's copy knows refunds made at other tills; add only this device's unsent ones.
          const unsent = await pendingRefunds(db);
          for (const s of server.sales) results.set(s.sale.id, applyLocalRefunds(s, unsent));
        } else if (server.status === "unpaired") note = t("refund.unpaired");
        else if (server.status === "failed") note = t("refund.lookupFailed");
      }
      const list = [...results.values()];
      setFound(list);
      setMessage(
        note ||
          (list.length === 0 ? t(offline ? "refund.notFoundOffline" : "refund.notFound") : ""),
      );
      setBusy(false);
      if (list.length === 1 && q.by === "id") choose(list[0]!);
    },
    [db, localDetail, offline, orgId, tillId, servingToken],
  );

  // A code scanned while this window is open, or handed in from the main screen.
  const onCode = useCallback(
    (code: string) => {
      const id = saleIdOfCode(code);
      if (id) void search({ by: "id", id });
      else setMessage(t("refund.notFound"));
    },
    [search],
  );
  useScanner(onCode, step === "find" && !busy);
  useEffect(() => {
    // Only once, when the window opens with a scanned code (after this render, not during it).
    if (initialCode) void Promise.resolve().then(() => onCode(initialCode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function choose(d: SaleDetail) {
    const left = d.lines.some((l) => l.refunded_qty < l.qty);
    if (!left) {
      setMessage(t("refund.nothingLeft"));
      return;
    }
    setDetail(d);
    setQtys({});
    setRestock({});
    setWhole(false);
    setReason("");
    setNote("");
    setPay(null);
    setMessage("");
    setStep("lines");
  }

  // ------------------------------------------------------------------ the lines
  // Service-charge lines are not offered on their own: they go back with the item they were charged on.
  const items = useMemo(
    () => detail?.lines.filter((l) => l.kind === "item" && !isServiceLine(l)) ?? [],
    [detail],
  );

  /** Void is allowed for a whole, untouched sale from this till, on the day it was made. */
  const voidable =
    !!detail &&
    (() => {
      const sameDay =
        localDate(new Date(detail.sale.completed_at), org.timezone) ===
        localDate(new Date(), org.timezone);
      return (
        sameDay &&
        detail.sale.register_id === tillId &&
        detail.lines.every((l) => l.refunded_qty === 0)
      );
    })();

  const picks: RefundPick[] = useMemo(() => {
    if (!detail) return [];
    if (whole) {
      return detail.lines.map((l) => ({
        lineNo: l.line_no,
        qty: l.qty,
        restock: restock[l.line_no] ?? true,
      }));
    }
    const out: RefundPick[] = [];
    for (const l of detail.lines) {
      if (l.kind !== "item" || isServiceLine(l)) continue;
      const qty = qtys[l.line_no] ?? 0;
      if (qty < 1) continue;
      out.push({ lineNo: l.line_no, qty, restock: restock[l.line_no] ?? true });
      // The Re-turn deposit goes back with its item: it is the very next line on the sale.
      const next = detail.lines.find((d) => d.line_no === l.line_no + 1);
      if (next?.kind === "deposit" && next.name === l.name) {
        out.push({
          lineNo: next.line_no,
          qty: Math.min(qty, next.qty - next.refunded_qty),
          restock: false,
        });
      }
      // The service charge on this item is stored right after it (and its deposit): the same share
      // of it goes back for the same units, so the charge is returned pro rata.
      const following = detail.lines.filter((d) => d.line_no > l.line_no).slice(0, 2);
      const service = following.find(
        (d, i) => isServiceLine(d) && (i === 0 || following[0]!.kind === "deposit"),
      );
      if (service) {
        out.push({
          lineNo: service.line_no,
          qty: Math.min(qty, service.qty - service.refunded_qty),
          restock: false,
        });
      }
    }
    return out.filter((p) => p.qty >= 1);
  }, [detail, qtys, restock, whole]);

  const priced = useMemo(
    () => (detail && picks.length > 0 ? priceRefundLines(detail, picks) : null),
    [detail, picks],
  );
  const total = priced?.ok ? priced.totals.total : 0;
  const kind = whole ? "void" : exchange ? "exchange" : "refund";
  // Credit is what the new sale can take of the returned value; any rest goes back as money.
  const credit = exchange ? Math.min(total, cartTotalCents) : 0;
  const noteNeeded = reason === "other" && note.trim().length === 0;
  const linesReady = !!priced?.ok && !!reason && !noteNeeded;

  function setQty(lineNo: number, qty: number, max: number) {
    setQtys((q) => ({ ...q, [lineNo]: Math.max(0, Math.min(max, qty)) }));
  }

  // ------------------------------------------------------------------ paying back
  const available = detail ? availableOf(detail) : { cash: 0, card: 0 };
  const cardOptions = methodOptions(tenderOptions, "card");
  const cashOptions = methodOptions(tenderOptions, "cash");

  function startPay() {
    if (!detail || !priced?.ok) return;
    const legs = suggestRefundLegs(priced.totals.total, available, { roundCash, credit });
    const amount = (m: "card") =>
      centsToInput(legs.find((l) => l.method === m)?.amount ?? 0);
    const originalTip = detail.payments.reduce((n, p) => n + (p.method === "card" ? p.tip : 0), 0);
    setPay({
      card: amount("card") === "0.00" ? "" : amount("card"),
      cardType: cardOptions[0]?.id ?? null,
      cashType: cashOptions[0]?.id ?? null,
      cardRef: "",
      tip: kind === "void" && originalTip > 0 ? centsToInput(originalTip) : "",
    });
    setPayError("");
    setStep("pay");
  }

  const cardCents = pay ? (parseCents(pay.card) ?? 0) : 0;
  const tipCents = pay && kind === "void" && register.tips ? (parseCents(pay.tip) ?? 0) : 0;
  const cashShare = Math.max(total - credit - cardCents, 0);
  const cashCents = cashDueOf(cashShare, roundCash);

  const legs: RefundLeg[] = [];
  if (cardCents > 0) legs.push({ method: "card", amount: cardCents, tip: tipCents });
  if (cashCents > 0) legs.push({ method: "cash", amount: cashCents });
  const settlement = pay && priced?.ok ? settleRefund(total, legs, available, {
          roundCash,
          credit,
          cashSlack: 2 * (1 + detail!.refunded.cash_refunds),
        })
      : null;

  const needsManager =
    refundNeedsOverride(total + (detail?.refunded.value ?? 0), refundLimitCents, role) || (kind === "void" && role === "cashier");

  function labelOf(options: TenderOption[], id: string | null, fallback: string) {
    return options.find((o) => o.id === id)?.label ?? fallback;
  }

  function buildLegs(): LocalRefundLeg[] | null {
    if (!pay || !settlement?.ok) return null;
    const out: LocalRefundLeg[] = [];
    for (const l of legs) {
      const isCard = l.method === "card";
      const refText = isCard ? pay.cardRef : "";
      const ref = refText.trim() ? tenderReference.safeParse(refText) : null;
      if (ref && !ref.success) {
        setPayError(t("refund.error.invalid"));
        return null;
      }
      const typeId = isCard ? pay.cardType : pay.cashType;
      const options = isCard ? cardOptions : cashOptions;
      out.push({
        id: uuidv7(),
        typeId,
        method: l.method,
        amountCents: l.amount,
        tipCents: l.tip ?? 0,
        ...(ref?.success && ref.data ? { reference: ref.data } : {}),
        label: labelOf(options, typeId, t(`refund.method.${l.method}`)),
      });
    }
    return out;
  }

  async function save(approver?: { userId: string; approvalId?: string }) {
    if (!detail || !priced?.ok || !settlement?.ok || !reason) return;
    const refundLegs = buildLegs();
    if (!refundLegs) return;
    setBusy(true);
    try {
      const input: RefundInput = {
        registerId: tillId,
        cashierUserId: cashierId,
        servingToken,
        approvalId: approver?.approvalId,
        claimedApprover: approver?.approvalId ? undefined : approver?.userId,
        originalSaleId: detail.sale.id,
        originalReceiptNo: receiptNo(
          detail.sale.register_name ?? tillName(detail.sale.register_id),
          detail.sale.receipt_seq,
        ),
        kind,
        reasonCode: reason,
        reasonNote: note.trim() || undefined,
        lines: priced.lines,
        legs: refundLegs,
        creditCents: credit,
        exchangeSaleId: kind === "exchange" ? exchangeSaleId : undefined,
        roundCash,
        roundingCents: settlement.rounding,
        expectedAmountCents: settlement.payout + settlement.rounding,
      };
      if (kind === "exchange") {
        // Nothing is recorded yet: the refund is saved together with the sale that spends its credit.
        onExchange({
          input: { ...input, id: exchangeRefundId, completedAt: new Date().toISOString() },
          saleId: exchangeSaleId,
          creditCents: credit,
        });
        return;
      }
      onDone(await completeRefund(db, input));
    } catch {
      setBusy(false);
      setPayError(t("refund.saveFailed"));
      setStep("pay");
    }
  }

  function complete() {
    if (!settlement?.ok) return;
    if (needsManager) setStep("approve");
    else void save();
  }

  // ------------------------------------------------------------------ approval
  if (step === "approve") {
    return (
      <OverrideDialog
        reason={t("override.refund", { amount: formatCents(refundLimitCents) })}
        staff={staff.filter((m) => canApprove(m.role))}
        offline={offline}
        verify={(member, pin) =>
          verify(member, pin, {
            saleId: detail!.sale.id,
            maxCents: total,
          })
        }
        onClose={() => setStep("pay")}
        onApproved={({ userId, approvalId }) => void save({ userId, approvalId })}
      />
    );
  }

  const saleLabel = (d: SaleDetail) =>
    t("refund.saleOf", {
      no: receiptNo(d.sale.register_name ?? tillName(d.sale.register_id), d.sale.receipt_seq),
      when: new Intl.DateTimeFormat("en-IE", {
        timeZone: org.timezone,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(d.sale.completed_at)),
    });

  const SaleButton = ({ d }: { d: SaleDetail }) => (
    <Button
      type="button"
      size="touch"
      variant="outline"
      className="w-full justify-between"
      onClick={() => choose(d)}
    >
      <span>{saleLabel(d)}</span>
      <span className="font-mono tabular-nums">{formatCents(d.sale.amount_due)}</span>
    </Button>
  );

  // ------------------------------------------------------------------ find
  if (step === "find") {
    const receiptSeq = /^\d{1,8}$/.test(numberText.trim()) ? Number(numberText.trim()) : null;
    return (
      <Modal title={t("refund.findTitle")} description={t("refund.scanHint")} onClose={onClose}>
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <ScanLineIcon aria-hidden className="size-5 shrink-0" />
          {t("refund.scanHint")}
        </p>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (receiptSeq) void search({ by: "receipt", seq: receiptSeq });
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-sm font-medium">
            {t("refund.receiptNumber")}
            <Input
              inputMode="numeric"
              autoComplete="off"
              value={numberText}
              aria-describedby="refund-number-hint"
              onChange={(e) => setNumberText(e.target.value)}
              className="h-12 text-base"
            />
          </label>
          <Button type="submit" size="touch" disabled={busy || !receiptSeq}>
            {t("refund.find")}
          </Button>
        </form>
        <p id="refund-number-hint" className="text-muted-foreground -mt-2 text-xs">
          {t("refund.receiptNumberHint")}
        </p>
        {register.serialPrompt && (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (serialText.trim().length >= 3)
                void search({ by: "serial", serial: serialText.trim() });
            }}
          >
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium">
              {t("refund.serial")}
              <Input
                autoComplete="off"
                value={serialText}
                onChange={(e) => setSerialText(e.target.value)}
                className="h-12 text-base"
              />
            </label>
            <Button type="submit" size="touch" disabled={busy || serialText.trim().length < 3}>
              {t("refund.find")}
            </Button>
          </form>
        )}
        <p role="status" className="min-h-6 text-sm">
          {message}
        </p>
        {found.length > 0 && (
          <ul
            className="flex max-h-[28dvh] flex-col gap-2 overflow-y-auto"
            aria-label={t("refund.findTitle")}
          >
            {found.map((d) => (
              <li key={d.sale.id}>
                <SaleButton d={d} />
              </li>
            ))}
          </ul>
        )}
        <h3 className="text-sm font-semibold">{t("refund.recent")}</h3>
        {recent.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("refund.recentNone")}</p>
        ) : (
          <ul className="flex max-h-[28dvh] flex-col gap-2 overflow-y-auto">
            {recent.map((d) => (
              <li key={d.sale.id}>
                <SaleButton d={d} />
              </li>
            ))}
          </ul>
        )}
        <Cancel onClick={onClose} />
      </Modal>
    );
  }

  if (!detail) return null;

  // ------------------------------------------------------------------ lines
  if (step === "lines") {
    return (
      <Modal title={t("refund.linesTitle")} description={saleLabel(detail)} onClose={onClose}>
        {whole ? (
          <p role="status" className="font-semibold">
            {t("refund.voiding")}
          </p>
        ) : (
          <ul className="flex max-h-[34dvh] flex-col gap-2 overflow-y-auto">
            {items.map((l) => {
              const left = l.qty - l.refunded_qty;
              const qty = qtys[l.line_no] ?? 0;
              const hasDeposit = detail.lines.some(
                (d) => d.line_no === l.line_no + 1 && d.kind === "deposit",
              );
              return (
                <li key={l.line_no} className="flex flex-col gap-1 rounded-lg border-2 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{l.name}</span>
                    <span className="font-mono text-sm tabular-nums">
                      {formatCents(l.gross)} · {t("refund.left", { count: left })}
                    </span>
                  </div>
                  {l.serial && (
                    <span className="text-muted-foreground text-xs">S/N {l.serial}</span>
                  )}
                  {left === 0 ? (
                    <span className="text-muted-foreground text-sm">{t("refund.nothingLeft")}</span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="icon-touch"
                        variant="outline"
                        aria-label={t("refund.less", { name: l.name })}
                        aria-disabled={qty === 0}
                        className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                        onClick={() => setQty(l.line_no, qty - 1, left)}
                      >
                        <MinusIcon aria-hidden />
                      </Button>
                      <span role="status" className="min-w-24 text-center font-mono tabular-nums">
                        {t("refund.returning", { count: qty })}
                      </span>
                      <Button
                        type="button"
                        size="icon-touch"
                        variant="outline"
                        aria-label={t("refund.more", { name: l.name })}
                        disabled={qty >= left}
                        onClick={() => setQty(l.line_no, qty + 1, left)}
                      >
                        <PlusIcon aria-hidden />
                      </Button>
                      <label className="ml-auto flex min-h-12 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-6"
                          checked={restock[l.line_no] ?? true}
                          onChange={(e) =>
                            setRestock((r) => ({ ...r, [l.line_no]: e.target.checked }))
                          }
                        />
                        {t("refund.restock")}
                      </label>
                    </div>
                  )}
                  {hasDeposit && qty > 0 && (
                    <span className="text-muted-foreground text-xs">
                      {t("refund.depositIncluded")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {voidable && (
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              size="touch"
              variant="outline"
              onClick={() => {
                setWhole((w) => !w);
                setQtys({});
                if (!whole && !reason) setReason("void_mistake");
              }}
            >
              {whole && <CheckIcon aria-hidden />}
              {whole ? t("refund.keepPicking") : t("refund.voidWhole")}
            </Button>
            {!whole && <p className="text-muted-foreground text-xs">{t("refund.voidHint")}</p>}
          </div>
        )}
        {register.exchangeFlow && !whole && cartTotalCents > 0 && (
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              size="touch"
              variant="outline"
              aria-pressed={exchange}
              onClick={() => setExchange((x) => !x)}
            >
              {exchange && <CheckIcon aria-hidden />}
              {t("refund.exchange")}
            </Button>
            <p className="text-muted-foreground text-xs">{t("refund.exchangeHint")}</p>
          </div>
        )}
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("refund.reason")}
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as RefundReasonCode | "")}
            className="border-input bg-background h-12 rounded-lg border-2 px-3 text-base"
          >
            <option value="">{t("refund.pickReason")}</option>
            {refundReasonCodes
              .filter((c) => whole || c !== "void_mistake")
              .map((c) => (
                <option key={c} value={c}>
                  {t(`refund.reason.${c}`)}
                </option>
              ))}
          </select>
        </label>
        {reason === "other" && (
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("refund.note")}
            <Input
              value={note}
              maxLength={200}
              aria-invalid={noteNeeded}
              aria-describedby={noteNeeded ? "refund-note-error" : undefined}
              onChange={(e) => setNote(e.target.value)}
              className="h-12 text-base"
            />
          </label>
        )}
        <p id="refund-total" role="status" className="text-heading font-semibold tabular-nums">
          {priced?.ok
            ? `${t("refund.total")}: ${formatCents(total)} (${t("refund.vatIncluded")} ${formatCents(priced.totals.vatTotal)})`
            : t("refund.pickLines")}
        </p>
        {noteNeeded && (
          <p id="refund-note-error" role="alert" className="text-sm">
            {t("refund.noteRequired")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            size="touch"
            variant="outline"
            onClick={() => {
              setDetail(null);
              setStep("find");
            }}
          >
            <ArrowLeftIcon aria-hidden /> {t("refund.back")}
          </Button>
          <Button
            type="button"
            size="touch"
            aria-disabled={!linesReady}
            aria-describedby={linesReady ? undefined : "refund-total"}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => linesReady && startPay()}
          >
            {t("refund.next")}
          </Button>
        </div>
      </Modal>
    );
  }

  // ------------------------------------------------------------------ pay back
  if (!pay || !priced?.ok || !settlement) return null;
  const set = (patch: Partial<Pay>) => setPay((p) => (p ? { ...p, ...patch } : p));
  const error = settlement.error;

  return (
    <Modal title={t("refund.payTitle")} description={t("refund.payBody")} onClose={onClose}>
      <p className="text-heading font-semibold tabular-nums">
        {t("refund.total")}: {formatCents(total)}
      </p>
      {credit > 0 && (
        <p className="font-semibold tabular-nums">
          {t("refund.credit")}: {formatCents(credit)}
        </p>
      )}

      {available.card > 0 && (
        <fieldset className="flex flex-col gap-2 rounded-lg border-2 p-2">
          <legend className="px-1 text-sm font-semibold">
            {t("refund.method.card")} ·{" "}
            {t("refund.available", { amount: formatCents(available.card) })}
          </legend>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("refund.amountFor", { label: t("refund.method.card") })}
            <Input
              inputMode="decimal"
              value={pay.card}
              onChange={(e) => set({ card: e.target.value })}
              className="h-12 font-mono text-base tabular-nums"
            />
          </label>
          {cardOptions.length > 1 && (
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t("refund.type", { method: t("refund.method.card") })}
              <select
                value={pay.cardType ?? ""}
                onChange={(e) => set({ cardType: e.target.value || null })}
                className="border-input bg-background h-12 rounded-lg border-2 px-3 text-base"
              >
                {cardOptions.map((o) => (
                  <option key={o.id ?? "card"} value={o.id ?? ""}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("refund.reference")}
            <Input
              autoComplete="off"
              maxLength={40}
              value={pay.cardRef}
              onChange={(e) => set({ cardRef: e.target.value })}
              aria-describedby="refund-ref-hint"
              className="h-12 text-base"
            />
            <span id="refund-ref-hint" className="text-muted-foreground text-xs font-normal">
              {t("refund.referenceHint")}
            </span>
          </label>
          {cardCents > 0 && <p className="text-muted-foreground text-xs">{t("refund.cardNote")}</p>}
          {kind === "void" && register.tips && cardCents > 0 && (
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t("refund.tipBack")}
              <Input
                inputMode="decimal"
                value={pay.tip}
                onChange={(e) => set({ tip: e.target.value })}
                className="h-12 font-mono text-base tabular-nums"
              />
            </label>
          )}
        </fieldset>
      )}

      <div className="rounded-lg border-2 p-2">
        <p className="flex justify-between font-semibold">
          <span>{t("refund.cashDue")}</span>
          <span className="font-mono tabular-nums">{formatCents(cashCents)}</span>
        </p>
        {settlement.rounding !== 0 && (
          <p className="text-muted-foreground flex justify-between text-sm">
            <span>{t("refund.rounding")}</span>
            <span className="font-mono tabular-nums">{formatCents(settlement.rounding)}</span>
          </p>
        )}
        <p role="status" className="mt-1 text-sm">
          {settlement.ok
            ? t("refund.settled")
            : error && error !== "short"
              ? t(`refund.error.${error}`)
              : t("refund.toAllocate", { amount: formatCents(settlement.balance) })}
        </p>
      </div>
      {payError && (
        <p role="alert" className="text-sm font-semibold">
          {payError}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" size="touch" variant="outline" onClick={() => setStep("lines")}>
          <ArrowLeftIcon aria-hidden /> {t("refund.back")}
        </Button>
        <Button type="button" size="touch" disabled={!settlement.ok || busy} onClick={complete}>
          {busy ? t("refund.saving") : t("refund.complete", { kind: t(`refund.kind.${kind}`) })}
        </Button>
      </div>
    </Modal>
  );
}
