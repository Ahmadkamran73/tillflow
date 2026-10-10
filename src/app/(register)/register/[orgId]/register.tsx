"use client";

import {
  ArchiveIcon,
  CheckIcon,
  ClockIcon,
  LockIcon,
  MinusIcon,
  ChefHatIcon,
  PauseIcon,
  UserRoundIcon,
  PercentIcon,
  PrinterIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WheatIcon,
} from "lucide-react";
import Link from "next/link";
import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { RegisterLayout } from "@/components/register/register-layout";
import { SyncStatusPill } from "@/components/sync-status-pill";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { presets } from "@/config/business-type-presets";
import { t } from "@/lib/i18n";
import {
  discountNeedsOverride,
  formatCents,
  localDate,
  settleTenders,
  type Discount,
} from "@/lib/money";
import {
  cartReducer,
  ORDER_NAME_MAX,
  allergensOf,
  depositOf,
  warrantyOf,
  emptyCart,
  lineTotal,
  priceCart,
  promptsFor,
  safePriceCart,
  unitWithModifiers,
  variantLabel,
  type Cart,
  type CartLine,
  type LineModifier,
  type Prompt,
} from "@/lib/register/cart";
import {
  registerDb,
  type CurrentShift,
  type ExchangeDraft,
  type LocalRefund,
  type LocalSale,
  type LocalTender,
  type RegisterDb,
} from "@/lib/register/db";
import { completeExchange } from "@/lib/register/refund";
import { buildRefundReceipt, refundReceiptText } from "@/lib/register/refund-receipt";
import { saleIdOfCode } from "@/lib/register/refund";
import { toWireTender } from "@/lib/register/tender-input";
import { checkPin, type ApprovalFor, type StaffMember } from "@/lib/register/staff";
import type { InvoiceInput } from "@/lib/register/invoice";
import {
  defaultPrinter,
  loadPrinter,
  loadStations,
  noStations,
  printLines,
  savePrinter,
  saveStations,
  type PrinterSettings,
  type StationSetup,
} from "@/lib/register/print";
import { buildReceipt, receiptLabels, receiptText } from "@/lib/register/receipt";
import { allergenListLines, buildTickets, type Station } from "@/lib/register/ticket";
import { AllergenBadge, AllergenListDialog, allergenName, StationsDialog } from "./cafe-dialogs";
import { completeSale, receiptNo, setInvoice } from "@/lib/register/sale";
import {
  addCashMove,
  closeShift,
  currentShift,
  openShift,
  summariseShift,
  type ClosedShift,
  type ShiftSummary,
} from "@/lib/register/shift";
import { shiftReportLines } from "@/lib/register/shift-receipt";
import {
  discountLimitOf,
  refundLimitOf,
  type FeedProduct,
  type FeedVariant,
} from "@/lib/register/feed";
import { useCatalog, useCatalogRefresh } from "@/lib/register/use-catalog";
import { useSync } from "@/lib/sync/use-sync";
import { useScanner } from "@/lib/register/use-scanner";
import { PrintArea } from "@/components/register/print-area";
import { emailReceipt } from "./actions";
import {
  AgeCheck,
  DiscountDialog,
  ModifierPicker,
  ParkedList,
  SerialPrompt,
  VariantPicker,
  type ModifierGroupView,
} from "./dialogs";
import { CustomerDialog, type TillCustomer } from "./customer-dialog";
import { DoneDialog, EmailDialog, InvoiceDialog, PrinterDialog } from "./sale-dialogs";
import { RefundDialog, RefundDoneDialog } from "./refund-dialog";
import { TenderDialog, type TenderOption } from "./tender-dialog";
import { LockScreen, type Cashier } from "./lock-screen";
import {
  CashMoveDialog,
  CloseShiftDialog,
  OpenShiftDialog,
  ShiftClosedDialog,
  ShiftMenuDialog,
  XReportDialog,
} from "./shift-dialogs";
import { OverrideDialog } from "./override-dialog";

/** Nobody touches the till for this long and it locks itself. */
const IDLE_LOCK_MS = 5 * 60_000;

/** What the manager is being asked to approve. */
type OverrideAsk = { kind: "discount"; key: string; percent: string } | { kind: "noSale" };

type Flow = {
  product: FeedProduct;
  variant: FeedVariant;
  queue: Prompt[];
  modifiers: LineModifier[];
  serial?: string;
};

type Dialog =
  | null
  | { kind: "variant"; product: FeedProduct }
  | { kind: "flow"; flow: Flow }
  | { kind: "discount"; target: "basket" | string }
  | { kind: "parked" }
  | { kind: "customer" }
  | { kind: "tender" }
  | { kind: "override"; ask: OverrideAsk }
  | { kind: "printer"; station?: Station }
  | { kind: "stations" }
  | { kind: "allergens" }
  | { kind: "done"; sale: LocalSale; status: string }
  | { kind: "email"; sale: LocalSale; status: string; sending: boolean }
  | { kind: "invoice"; sale: LocalSale }
  | { kind: "refund"; code?: string }
  | { kind: "refundDone"; refund: LocalRefund; status: string }
  | { kind: "shiftMenu" }
  | { kind: "cashMove"; movement: "in" | "out" }
  | { kind: "xReport"; summary: ShiftSummary; status: string }
  | { kind: "closeShift"; summary: ShiftSummary }
  | { kind: "shiftClosed"; closed: ClosedShift; status: string };

/** A sale in progress older than this is dropped rather than restored. */
const CART_KEEP_MS = 12 * 3_600_000;

/**
 * The saved sale in progress, if it is recent and well-formed; otherwise undefined. The age check
 * is asked again (ageChecked false) because a different person may be serving by now.
 */
function restorableCart(value: unknown): Cart | undefined {
  const v = value as { cart?: Cart; savedAt?: number } | undefined;
  const cart = v?.cart;
  if (!cart || typeof v?.savedAt !== "number" || Date.now() - v.savedAt > CART_KEEP_MS) return;
  if (!Array.isArray(cart.lines) || cart.lines.length === 0 || cart.lines.length > 100) return;
  const sane = cart.lines.every(
    (l) =>
      typeof l?.id === "string" &&
      typeof l.variantId === "string" &&
      Number.isInteger(l.qty) &&
      l.qty >= 1 &&
      Number.isInteger(l.unitPriceCents) &&
      Array.isArray(l.modifiers),
  );
  return sane ? { ...cart, ageChecked: false } : undefined;
}

const ratePercent = (bp: number) => `${bp / 100}%`; // display only

export function Register({ orgId }: { orgId: string }) {
  // Browser only: IndexedDB does not exist while the server renders this component.
  const db = useMemo<RegisterDb | null>(
    () => (typeof window === "undefined" ? null : registerDb(orgId)),
    [orgId],
  );

  const data = useCatalog(db);
  const sync = useCatalogRefresh(db, orgId);
  const [cart, dispatch] = useReducer(cartReducer, emptyCart);
  const [dialog, setDialog] = useState<Dialog>(null);
  // The customer picked for this sale: memory only, never stored on the device (only the id is sent).
  const [customer, setCustomer] = useState<TillCustomer | null>(null);
  const customerButton = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [message, setMessage] = useState({ text: "", n: 0 });
  const [printer, setPrinter] = useState<PrinterSettings>(defaultPrinter);
  // Print results shown inside the open dialog (the cart pane's status is behind its scrim).
  const [dialogStatus, setDialogStatus] = useState({ text: "", n: 0 });
  const [stationSetup, setStationSetup] = useState<StationSetup>(noStations);
  const [printJob, setPrintJob] = useState<{ n: number; lines: string[] } | null>(null);
  // Who is serving. Memory only: a reload locks the till.
  const [cashier, setCashier] = useState<Cashier | null>(null);
  // The shift open on this till: `null` while it is being read from IndexedDB, `undefined` when none
  // is open (selling is blocked until one is).
  const [shift, setShift] = useState<CurrentShift | undefined | null>(null);
  useEffect(() => {
    if (!db) return;
    let live = true;
    void currentShift(db).then((s) => live && setShift(s));
    return () => {
      live = false;
    };
  }, [db]);
  // A manager's approval of the discounts as they are now (void as soon as they change).
  // approvalId is the server's proof (online); without it the sale is held for a manager on sync.
  const [approval, setApproval] = useState<{
    userId: string;
    approvalId?: string;
    key: string;
  } | null>(null);
  const [online, setOnline] = useState(true);
  // An exchange in progress: the returned goods are credit on the sale being rung up. NOTHING is
  // recorded until that sale is complete: then the refund and the sale are saved together in one
  // transaction, so an exchange can be cancelled with no trace and never half-exists. Kept in
  // IndexedDB so a reload keeps it.
  const [exchangeDraft, setExchangeDraft] = useState<ExchangeDraft | null>(null);
  useEffect(() => {
    if (!db) return;
    let live = true;
    void db.meta.get("exchangeDraft").then((row) => {
      const v = row?.value as typeof exchangeDraft;
      if (live && v && typeof v.refundId === "string") setExchangeDraft(v);
    });
    return () => {
      live = false;
    };
  }, [db]);
  // Payments already taken for the cart on screen (e.g. a card approved on the terminal), kept in
  // IndexedDB so a reload does not lose them. Tied to the exact cart, never to a different one.
  const [draft, setDraft] = useState<LocalTender[]>([]);
  // The sale in progress is kept in IndexedDB, so a reload, a crash or a sleeping tablet does not
  // lose it (a card already approved on the terminal would otherwise have no sale to belong to).
  const [cartRestored, setCartRestored] = useState(false);
  useEffect(() => {
    if (!db) return;
    let live = true;
    void db.meta.get("currentCart").then((row) => {
      if (!live) return;
      const saved = restorableCart(row?.value);
      if (saved) dispatch({ type: "load", cart: saved });
      setCartRestored(true);
    });
    return () => {
      live = false;
    };
  }, [db]);
  useEffect(() => {
    if (!db || !cartRestored) return;
    if (cart.lines.length === 0) void db.meta.delete("currentCart");
    else void db.meta.put({ key: "currentCart", value: { cart, savedAt: Date.now() } });
  }, [db, cart, cartRestored]);

  useEffect(() => {
    if (!db) return;
    void loadPrinter(db).then(setPrinter);
    void loadStations(db).then(setStationSetup);
  }, [db]);

  useEffect(() => {
    // Reading navigator.onLine once on mount; the events keep it current after that.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  // Lock after a few minutes without a touch or key press.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!cashier) return;
    const arm = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setCashier(null), IDLE_LOCK_MS);
    };
    arm();
    const events = ["pointerdown", "keydown"] as const;
    for (const e of events) window.addEventListener(e, arm);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      for (const e of events) window.removeEventListener(e, arm);
    };
  }, [cashier]);

  const verify = useCallback(
    (purpose: "unlock" | "override", approvalFor?: ApprovalFor) =>
      (member: StaffMember, pin: string) =>
        db
          ? checkPin(db, member, pin, purpose, { approvalFor })
          : Promise.resolve({ status: "invalid" } as const),
    [db],
  );

  const preset = data?.org ? presets[data.org.businessType] : null;
  // Cash is rounded to 5c only in shops whose preset says so.
  const roundCash = preset?.register.cashRounding5c ?? true;

  // Lookups over the local catalogue.
  const index = useMemo(() => {
    const variantsOf = new Map<string, FeedVariant[]>();
    for (const v of [...(data?.variants ?? [])].sort((a, b) => a.sort - b.sort)) {
      variantsOf.set(v.productId, [...(variantsOf.get(v.productId) ?? []), v]);
    }
    const products = new Map((data?.products ?? []).map((p) => [p.id, p]));
    const optionsOf = new Map<string, LineModifier[]>();
    for (const m of [...(data?.modifiers ?? [])].sort((a, b) => a.sort - b.sort)) {
      optionsOf.set(m.groupId, [
        ...(optionsOf.get(m.groupId) ?? []),
        { id: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents },
      ]);
    }
    const groups = new Map((data?.modifierGroups ?? []).map((g) => [g.id, g]));
    const groupsOf = new Map<string, ModifierGroupView[]>();
    for (const pg of [...(data?.productGroups ?? [])].sort((a, b) => a.sort - b.sort)) {
      const g = groups.get(pg.groupId);
      if (!g) continue;
      groupsOf.set(pg.productId, [
        ...(groupsOf.get(pg.productId) ?? []),
        { id: g.id, name: g.name, min: g.min, max: g.max, options: optionsOf.get(g.id) ?? [] },
      ]);
    }
    return { variantsOf, products, groupsOf };
  }, [data]);

  const tiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...index.products.values()]
      .filter((p) => !categoryId || p.categoryId === categoryId)
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          (index.variantsOf.get(p.id) ?? []).some(
            (v) => v.sku?.toLowerCase() === q || v.barcode?.toLowerCase() === q,
          ),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [index, query, categoryId]);

  // The shop-local day, re-read every minute so a till left open past midnight (or a rate
  // change) never prices with yesterday's rates.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Prices. The money library does all the maths; a missing VAT rate is shown, not guessed.
  const ctx = useMemo(
    () =>
      data?.org
        ? {
            country: data.org.country,
            date: localDate(now, data.org.timezone),
            rates: data.taxRates,
          }
        : null,
    [data, now],
  );
  const pricing = useMemo(() => {
    if (!ctx) return null;
    try {
      return safePriceCart(cart, ctx);
    } catch {
      return "error" as const;
    }
  }, [cart, ctx]);
  const priced = pricing && pricing !== "error" ? pricing.priced : null;
  const stripped = pricing && pricing !== "error" ? pricing.stripped : false;

  // `n` makes the same text twice in a row a new message, so it is announced again.
  const say = useCallback((text: string) => setMessage((m) => ({ text, n: m.n + 1 })), []);
  const focusCart = () =>
    requestAnimationFrame(() => document.getElementById("register-cart-heading")?.focus());

  useEffect(() => {
    if (!stripped) return;
    dispatch({ type: "stripAmountDiscounts" });
    // Announces the change to screen readers; the effect only fires when the cart changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    say(t("register.discountStripped"));
  }, [stripped, say]);

  function commit(flow: Flow) {
    const { product, variant } = flow;
    const label = variantLabel(variant);
    const line: CartLine = {
      id: uuidv7(),
      variantId: variant.id,
      productId: product.id,
      name: label ? `${product.name} – ${label}` : product.name,
      unitPriceCents: variant.priceCents,
      modifiers: flow.modifiers,
      qty: 1,
      taxCategory: product.taxCategory,
      takeawayTaxCategory: product.takeawayTaxCategory,
      depositCents: depositOf(variant.attributes),
      serial: flow.serial,
      warrantyMonths: warrantyOf(variant.attributes),
      allergens: allergensOf(variant.attributes),
    };
    dispatch({ type: "add", line });
    say(t("register.added", { name: line.name }));
    setDialog(null);
  }

  function advance(flow: Flow) {
    if (flow.queue.length === 0) commit(flow);
    else setDialog({ kind: "flow", flow });
  }

  function startAdd(product: FeedProduct, variant: FeedVariant) {
    if (!preset) return;
    const groups = index.groupsOf.get(product.id) ?? [];
    advance({
      product,
      variant,
      modifiers: [],
      queue: promptsFor(variant.attributes, groups.length > 0, preset.register, cart.ageChecked),
    });
  }

  function tapProduct(product: FeedProduct) {
    const variants = index.variantsOf.get(product.id) ?? [];
    if (variants.length === 0) return;
    if (variants.length > 1) setDialog({ kind: "variant", product });
    else startAdd(product, variants[0]!);
  }

  useScanner(
    async (code) => {
      if (!db) return;
      setQuery(""); // the code may also have been typed into the search box
      // A receipt's own barcode starts a refund for that sale.
      if (saleIdOfCode(code)) {
        setDialog({ kind: "refund", code });
        return;
      }
      try {
        const variant = await db.variants.where("barcode").equals(code).first();
        const product = variant && index.products.get(variant.productId);
        if (!variant || !product) say(t("register.scanNotFound", { code }));
        else startAdd(product, variant);
      } catch {
        say(t("register.scanError"));
      }
    },
    dialog === null && cashier !== null && !!shift,
  );

  async function park() {
    if (!db || cart.lines.length === 0) return;
    await db.parked.put({ id: uuidv7(), savedAt: Date.now(), cart });
    dispatch({ type: "load", cart: emptyCart });
    setCustomer(null);
    say(t("register.parkedDone"));
    focusCart();
  }

  async function recall(id: string) {
    if (!db) return;
    const sale = await db.parked.get(id);
    if (!sale) return;
    await db.transaction("rw", db.parked, async () => {
      // Recalling over a sale in progress parks that one, so nothing is lost.
      if (cart.lines.length) await db.parked.put({ id: uuidv7(), savedAt: Date.now(), cart });
      await db.parked.delete(id);
    });
    dispatch({ type: "load", cart: sale.cart });
    setDialog(null);
  }

  // The till this device is: the one it picked, or the shop's only till.
  const tills = data?.registers ?? [];
  const till =
    tills.find((r) => r.id === data?.registerId) ?? (tills.length === 1 ? tills[0] : undefined);
  const tillName = (id: string) => tills.find((r) => r.id === id)?.name ?? "Till";
  // The outbox: sales wait here until the server has confirmed them.
  const outbox = useSync(db, orgId, till?.id, sync.failed);

  /** Prices a finished sale with the VAT rates of the day it was sold, never today's. */
  const priceSale = (sale: LocalSale) =>
    priceCart(sale.cart, {
      ...ctx!,
      date: localDate(new Date(sale.completedAt), data!.org!.timezone),
    });

  function receiptOf(sale: LocalSale, asInvoice = false) {
    if (!ctx || !data?.org || !preset) return null;
    return buildReceipt({
      sale,
      priced: priceSale(sale),
      registerName: tillName(sale.registerId),
      header: data.org,
      options: preset.receipt,
      asInvoice,
    });
  }

  /** Prints on the configured printer; browser mode or a failure opens the browser print window. */
  async function print(
    sale: LocalSale,
    opts: { asInvoice?: boolean; kick?: boolean } = {},
  ): Promise<string> {
    const receipt = receiptOf(sale, opts.asInvoice);
    if (!receipt) return "";
    const lines = receiptText(receipt, printer.cols, receiptLabels());
    const result = await printLines(printer, lines, opts.kick ?? false);
    if (result === "printed") return t("register.printed");
    setPrintJob((j) => ({ n: (j?.n ?? 0) + 1, lines }));
    return result === "failed" ? t("register.printFallback") : t("register.printed");
  }

  /**
   * Prints the kitchen and bar tickets of a sale, each on its station's printer. A station with no
   * printer prints nothing; a browser-mode or failed one goes to the browser print window.
   */
  async function printTickets(sale: LocalSale): Promise<string> {
    if (!preset?.register.kitchenTickets || !data?.org) return "";
    const tickets = buildTickets({
      cart: sale.cart,
      number: receiptNo(tillName(sale.registerId), sale.receiptSeq),
      time: new Intl.DateTimeFormat("en-IE", {
        timeZone: data.org.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(sale.completedAt)),
      colsOf: (s) => stationSetup.printers[s]?.cols ?? 42,
      stationOf: (l) =>
        stationSetup.categories[index.products.get(l.productId)?.categoryId ?? ""] ?? "kitchen",
      labels: {
        order: t("ticket.order"),
        eatIn: t("ticket.eatIn"),
        takeAway: t("receipt.takeAway"),
        allergens: t("ticket.allergens"),
        allergen: allergenName,
      },
    });
    const fallback: string[] = [];
    let printed = 0;
    let failed = false;
    for (const ticket of tickets) {
      const p = stationSetup.printers[ticket.station];
      if (!p) continue;
      const result = await printLines(p, ticket.lines, false);
      if (result === "printed") printed++;
      else {
        fallback.push(...ticket.lines, "");
        failed ||= result === "failed";
      }
    }
    // Flushed now: the receipt prints next and would replace a job that was only queued.
    if (fallback.length)
      flushSync(() => setPrintJob((j) => ({ n: (j?.n ?? 0) + 1, lines: fallback })));
    if (printed === 0 && fallback.length === 0)
      return tickets.length ? t("register.ticketsNone") : "";
    return failed ? t("register.ticketsFailed") : t("register.ticketsPrinted");
  }

  // The shop's discount limit (basis points): above it, a manager's PIN is needed.
  const needsApproval =
    !!priced && !!data?.org
      ? discountNeedsOverride(
          cart.lines.map((l, i) => ({
            unitPrice: unitWithModifiers(l),
            qty: l.qty,
            gross: lineTotal(priced, priced.itemIndex[i]!),
          })),
          discountLimitOf(data.org),
        )
      : false;
  const discountKey = JSON.stringify([
    cart.discount ?? null,
    cart.lines.map((l) => [l.id, l.qty, l.discount ?? null]),
  ]);
  const overrideAsk: OverrideAsk = {
    kind: "discount",
    key: discountKey,
    percent: `${discountLimitOf(data?.org) / 100}%`,
  };

  /** Queues what a manager approved outside a sale (it becomes an audit row on the server). */
  async function queueEvent(kind: "no_sale", approver: { userId: string; approvalId?: string }) {
    if (!db || !cashier) return;
    await db.events.add({
      id: uuidv7(),
      kind,
      at: new Date().toISOString(),
      cashierUserId: cashier.userId,
      // Verified by the server when there is an approvalId; otherwise only a claim, logged as one.
      approvalId: approver.approvalId,
      claimedApprover: approver.approvalId ? undefined : approver.userId,
      detail: {},
      syncState: "pending",
    });
    outbox.kick();
  }

  async function openDrawer(approver: { userId: string; approvalId?: string }) {
    await queueEvent("no_sale", approver);
    if (printer.type === "browser") return say(t("register.drawerNoPrinter"));
    const r = await printLines(printer, [], true);
    say(r === "printed" ? t("register.drawerOpened") : t("register.drawerFailed"));
  }

  /** Prints a refund, void or exchange receipt; the drawer opens when cash goes back. */
  async function printRefund(refund: LocalRefund, kick: boolean): Promise<string> {
    if (!data?.org) return "";
    const receipt = buildRefundReceipt({
      refund,
      registerName: tillName(refund.registerId),
      header: data.org,
    });
    const lines = refundReceiptText(receipt, printer.cols);
    const result = await printLines(printer, lines, kick);
    if (result === "printed") return t("refund.printed");
    setPrintJob((j) => ({ n: (j?.n ?? 0) + 1, lines }));
    return result === "failed" ? t("register.printFallback") : t("refund.printed");
  }

  /** An exchange refund is saved: print its slip, then take payment for the new items. */
  async function exchanged(e: {
    input: ExchangeDraft["input"];
    saleId: string;
    creditCents: number;
  }) {
    if (!db || !e.input.id) return;
    const next: ExchangeDraft = {
      refundId: e.input.id,
      saleId: e.saleId,
      creditCents: e.creditCents,
      input: e.input,
    };
    await db.meta.put({ key: "exchangeDraft", value: next });
    setExchangeDraft(next);
    say(t("refund.exchangeDone", { amount: formatCents(e.creditCents) }));
    await openTender(next); // the state above has not re-rendered yet
  }

  /** Abandons an exchange: nothing was recorded, so there is nothing to undo. */
  async function cancelExchange() {
    if (!db) return;
    await db.meta.delete("exchangeDraft");
    await db.meta.delete("tenderDraft");
    setExchangeDraft(null);
    say(t("refund.exchangeCancelled"));
  }

  async function refunded(refund: LocalRefund) {
    const status = await printRefund(
      refund,
      refund.legs.some((l) => l.method === "cash"),
    );
    setDialog({ kind: "refundDone", refund, status });
    say(status);
    outbox.kick(); // only after the receipt: the refund never waits for the network
  }

  /** Keeps (or clears) the payments taken so far for this exact cart. */
  function saveDraft(tenders: LocalTender[]) {
    if (!db) return;
    if (tenders.length === 0) void db.meta.delete("tenderDraft");
    else
      void db.meta.put({ key: "tenderDraft", value: { cartKey: JSON.stringify(cart), tenders } });
  }

  async function openTender(exchange = exchangeDraft) {
    const saved = (await db?.meta.get("tenderDraft"))?.value as
      { cartKey: string; tenders: LocalTender[] } | undefined;
    const base = saved && saved.cartKey === JSON.stringify(cart) ? saved.tenders : [];
    // The exchange credit is the first payment on the sale, and cannot be removed.
    const withCredit: LocalTender[] =
      exchange && !base.some((x) => x.method === "exchange")
        ? [
            {
              id: uuidv7(),
              typeId: null,
              method: "exchange",
              amountCents: exchange.creditCents,
              tipCents: 0,
              refundId: exchange.refundId,
              label: t("refund.credit"),
            },
            ...base,
          ]
        : base;
    setDraft(withCredit);
    setDialog({ kind: "tender" });
  }

  async function tender(tenders: LocalTender[]) {
    if (!db || !till || !priced || !ctx || !data?.org) return;
    // The sale is stamped with the real time: if the day changed since the cart was priced, the
    // amount may differ, so show the new amount instead of taking cash against the old one.
    const nowDate = new Date();
    const today = localDate(nowDate, data.org.timezone);
    if (today !== ctx.date) {
      setNow(nowDate);
      setDialog(null);
      say(t("register.ratesChanged"));
      return;
    }
    // A discount above the shop's limit needs the manager's PIN for the discounts as they are now.
    if (needsApproval && approval?.key !== discountKey) {
      setDialog({ kind: "override", ask: overrideAsk });
      return;
    }
    if (!cashier) return;
    let sale: LocalSale;
    let exchangeRefund: LocalRefund | undefined;
    const saleInput = {
      registerId: till.id,
      cashierUserId: cashier.userId,
      approvalId: needsApproval ? approval?.approvalId : undefined,
      id: exchangeDraft?.saleId,
      exchangeRefundId: exchangeDraft?.refundId,
      customerId: customer?.id,
      cart,
      tenders,
      roundCash,
      expectedDueCents: settleTenders(
        priced.basket.total,
        tenders.map((x) => ({ method: x.method, amount: x.amountCents, tip: x.tipCents })),
        { roundCash },
      ).amountDue,
      expectedVatCents: priced.basket.vatTotal,
    };
    try {
      if (exchangeDraft) {
        // The refund of the returned goods and the sale that spends its credit are saved together.
        const both = await completeExchange(db, {
          refund: { ...exchangeDraft.input, registerId: till.id, cashierUserId: cashier.userId },
          sale: saleInput,
        });
        sale = both.sale;
        exchangeRefund = both.refund;
      } else {
        sale = await completeSale(db, saleInput);
      }
    } catch {
      say(t("register.saveFailed"));
      return;
    }
    if (exchangeDraft) setExchangeDraft(null); // spent: completeSale cleared it from IndexedDB
    if (exchangeRefund) {
      await printRefund(
        exchangeRefund,
        exchangeRefund.legs.some((l) => l.method === "cash"),
      );
    }
    // The tickets go first: the kitchen can start while the receipt prints.
    const ticketStatus = await printTickets(sale);
    // The drawer opens with the receipt only when cash was taken.
    const status =
      `${t("register.saved")} ${await print(sale, { kick: tenders.some((x) => x.method === "cash") })} ${ticketStatus}`.trim();
    setDialog({ kind: "done", sale, status });
    say(status);
    outbox.kick(); // only now, after the receipt: the sale never waits for the network
  }

  /** Prints report lines; browser mode or a failure opens the browser print window. */
  async function printText(lines: string[]): Promise<string> {
    const result = await printLines(printer, lines, false);
    if (result === "printed") return t("shift.printed");
    setPrintJob((j) => ({ n: (j?.n ?? 0) + 1, lines }));
    return result === "failed" ? t("register.printFallback") : t("shift.printed");
  }

  async function openShiftNow(floatCents: number) {
    if (!db || !till || !cashier) return;
    setShift(
      await openShift(db, { registerId: till.id, cashierUserId: cashier.userId, floatCents }),
    );
    outbox.kick();
    focusCart();
  }

  async function saveCashMove(movement: "in" | "out", amountCents: number, note: string) {
    if (!db || !shift || !cashier) return;
    await addCashMove(db, shift, { cashierUserId: cashier.userId, movement, amountCents, note });
    outbox.kick();
    setDialog(null);
    say(t("shift.moveSaved"));
  }

  const reportLines = (
    kind: "X" | "Z",
    sh: { registerId: string; openedAt: string },
    summary: ShiftSummary,
    extra: { closedAt?: string; countedCents?: number; overShortCents?: number } = {},
  ) =>
    data?.org
      ? shiftReportLines(
          {
            kind,
            businessName: data.org.legalName || data.org.name,
            tillName: tillName(sh.registerId),
            timezone: data.org.timezone,
            openedAt: sh.openedAt,
            summary,
            ...extra,
          },
          printer.cols,
        )
      : [];

  async function closeShiftNow(countedCents: number) {
    if (!db || !shift || !cashier) return;
    const closed = await closeShift(db, shift, { cashierUserId: cashier.userId, countedCents });
    setShift(undefined);
    outbox.kick();
    const status = await printText(
      reportLines("Z", closed, closed.summary, {
        closedAt: closed.closedAt,
        countedCents: closed.countedCents,
        overShortCents: closed.overShortCents,
      }),
    );
    setDialog({ kind: "shiftClosed", closed, status });
  }

  function newSale() {
    dispatch({ type: "load", cart: emptyCart });
    setCustomer(null);
    setDialog(null);
    focusCart();
  }

  function pay() {
    if (!till || !shift) return;
    if (needsApproval && approval?.key !== discountKey) {
      setDialog({ kind: "override", ask: overrideAsk });
    } else void openTender();
  }

  // The location's payment types; before the first pull a till offers the plain three.
  const tenderOptions: TenderOption[] = data?.tenderTypes.length
    ? [...data.tenderTypes]
        .sort((a, b) => a.sort - b.sort)
        .map((x) => ({ id: x.id, method: x.method, label: x.label }))
    : [
        { id: null, method: "cash", label: t("tender.cashLabel") },
        { id: null, method: "card", label: t("tender.cardLabel") },
      ];

  const itemCount = cart.lines.reduce((n, l) => n + l.qty, 0);
  const due = priced ? priced.basket.amountDue : 0;
  const payLabel = t("register.pay", { amount: formatCents(due) });
  const canPay = !!priced && cart.lines.length > 0;

  // `valid` for the discount dialog: would the cart still price with this discount?
  const discountTarget = dialog?.kind === "discount" ? dialog.target : null;
  const withDiscount = (d: Discount | undefined): Cart =>
    discountTarget === "basket"
      ? { ...cart, discount: d }
      : {
          ...cart,
          lines: cart.lines.map((l) => (l.id === discountTarget ? { ...l, discount: d } : l)),
        };
  const discountValid = (d: Discount) => {
    if (!ctx) return false;
    try {
      priceCart(withDiscount(d), ctx);
      return true;
    } catch {
      return false;
    }
  };

  function renderDialog() {
    if (!dialog) return null;
    const close = () => {
      setDialogStatus({ text: "", n: 0 });
      setDialog(null);
    };
    // A new object each time, so identical text is announced again.
    const announce = (text: string) => setDialogStatus((s) => ({ text, n: s.n + 1 }));
    switch (dialog.kind) {
      case "variant": {
        const { product } = dialog;
        return (
          <VariantPicker
            name={product.name}
            options={(index.variantsOf.get(product.id) ?? []).map((v) => ({
              id: v.id,
              label: variantLabel(v) || product.name,
              priceCents: v.priceCents,
            }))}
            onClose={close}
            onPick={(id) => {
              const variant = index.variantsOf.get(product.id)?.find((v) => v.id === id);
              if (variant) startAdd(product, variant);
            }}
          />
        );
      }
      case "flow": {
        const { flow } = dialog;
        const [step, ...rest] = flow.queue;
        const next = (patch: Partial<Flow>) => advance({ ...flow, ...patch, queue: rest });
        if (step === "modifiers")
          return (
            <ModifierPicker
              name={flow.product.name}
              groups={index.groupsOf.get(flow.product.id) ?? []}
              onClose={close}
              onDone={(modifiers) => next({ modifiers })}
            />
          );
        if (step === "serial")
          return <SerialPrompt onClose={close} onDone={(serial) => next({ serial })} />;
        return (
          <AgeCheck
            onClose={close}
            onDone={() => {
              dispatch({ type: "ageChecked" });
              next({});
            }}
          />
        );
      }
      case "discount": {
        const line = cart.lines.find((l) => l.id === dialog.target);
        return (
          <DiscountDialog
            title={
              dialog.target === "basket"
                ? t("register.discountWhole")
                : t("register.discountFor", { name: line?.name ?? "" })
            }
            current={dialog.target === "basket" ? cart.discount : line?.discount}
            valid={discountValid}
            onClose={close}
            onApply={(d) => {
              dispatch(
                dialog.target === "basket"
                  ? { type: "basketDiscount", discount: d }
                  : { type: "lineDiscount", id: dialog.target, discount: d },
              );
              close();
            }}
          />
        );
      }
      case "customer":
        return (
          <CustomerDialog
            orgId={orgId}
            onClose={close}
            onPick={(c) => {
              setCustomer(c);
              setDialog(null);
              say(t("till.customer.picked", { name: c.name }));
            }}
          />
        );
      case "parked":
        return (
          <ParkedList
            onClose={close}
            onRecall={recall}
            items={(data?.parked ?? []).map((p) => ({
              id: p.id,
              count: p.cart.lines.reduce((n, l) => n + l.qty, 0),
              time: new Date(p.savedAt).toLocaleTimeString("en-IE", {
                hour: "2-digit",
                minute: "2-digit",
              }),
            }))}
          />
        );
      case "tender":
        return (
          <TenderDialog
            total={priced?.basket.total ?? 0}
            options={tenderOptions}
            tipsAllowed={!!preset?.register.tips}
            roundCash={roundCash}
            initial={draft}
            onChange={saveDraft}
            onClose={close}
            onComplete={tender}
          />
        );
      case "override":
        return (
          <OverrideDialog
            reason={
              dialog.ask.kind === "discount"
                ? t("override.discount", { percent: dialog.ask.percent })
                : t("override.noSale")
            }
            staff={data?.staff ?? []}
            offline={!online}
            verify={verify("override", dialog.ask.kind === "discount" ? "discount" : "no_sale")}
            onClose={close}
            onApproved={async ({ userId, name, approvalId }) => {
              if (dialog.ask.kind === "discount") {
                setApproval({ userId, approvalId, key: dialog.ask.key });
                say(t("override.approved", { name }));
                void openTender();
              } else {
                close();
                await openDrawer({ userId, approvalId });
              }
            }}
          />
        );
      case "refund":
        if (!db || !till || !data?.org || !cashier) return null;
        return (
          <RefundDialog
            db={db}
            orgId={orgId}
            tillId={till.id}
            tillName={tillName}
            org={data.org}
            rates={data.taxRates}
            register={preset!.register}
            role={cashier.role}
            cashierId={cashier.userId}
            servingToken={cashier.servingToken}
            cartTotalCents={exchangeDraft ? 0 : (priced?.basket.total ?? 0)}
            staff={data.staff}
            offline={!online}
            tenderOptions={tenderOptions}
            roundCash={roundCash}
            refundLimitCents={refundLimitOf(data.org)}
            verify={(member, pin, bind) =>
              checkPin(db, member, pin, "override", { approvalFor: "refund", bind })
            }
            initialCode={dialog.code}
            onClose={close}
            onDone={(refund) => void refunded(refund)}
            onExchange={(e) => void exchanged(e)}
          />
        );
      case "refundDone":
        return (
          <RefundDoneDialog
            refund={dialog.refund}
            status={dialog.status}
            onPrint={async () =>
              setDialog({
                ...dialog,
                status: await printRefund(
                  dialog.refund,
                  dialog.refund.legs.some((l) => l.method === "cash"),
                ),
              })
            }
            onNewSale={() => {
              // Back to the till as it was: a sale in progress is not cleared by a refund.
              close();
              focusCart();
            }}
          />
        );
      case "shiftMenu":
        if (!shift || !data?.org) return null;
        return (
          <ShiftMenuDialog
            shift={shift}
            time={new Intl.DateTimeFormat("en-IE", {
              timeZone: data.org.timezone,
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            }).format(new Date(shift.openedAt))}
            onClose={close}
            onCash={(movement) => setDialog({ kind: "cashMove", movement })}
            onReport={async () =>
              db &&
              setDialog({ kind: "xReport", summary: await summariseShift(db, shift), status: "" })
            }
            onCloseShift={async () =>
              db && setDialog({ kind: "closeShift", summary: await summariseShift(db, shift) })
            }
          />
        );
      case "cashMove":
        return (
          <CashMoveDialog
            movement={dialog.movement}
            onClose={() => setDialog({ kind: "shiftMenu" })}
            onSave={(amount, note) => void saveCashMove(dialog.movement, amount, note)}
          />
        );
      case "xReport": {
        const { summary } = dialog;
        return (
          <XReportDialog
            summary={summary}
            status={dialog.status}
            onClose={close}
            onPrint={async () => {
              if (!shift) return;
              const status = await printText(reportLines("X", shift, summary));
              setDialog({ kind: "xReport", summary, status });
            }}
          />
        );
      }
      case "closeShift":
        return (
          <CloseShiftDialog
            summary={dialog.summary}
            onClose={() => setDialog({ kind: "shiftMenu" })}
            onConfirm={(counted) => void closeShiftNow(counted)}
          />
        );
      case "shiftClosed": {
        const { closed } = dialog;
        return (
          <ShiftClosedDialog
            closed={closed}
            status={dialog.status}
            onDone={close}
            onPrint={async () => {
              const status = await printText(
                reportLines("Z", closed, closed.summary, {
                  closedAt: closed.closedAt,
                  countedCents: closed.countedCents,
                  overShortCents: closed.overShortCents,
                }),
              );
              setDialog({ kind: "shiftClosed", closed, status });
            }}
          />
        );
      }
      case "printer": {
        const station = dialog.station;
        return (
          <PrinterDialog
            value={station ? (stationSetup.printers[station] ?? printer) : printer}
            status={dialogStatus.text}
            onClose={
              station
                ? () => {
                    setDialogStatus({ text: "", n: 0 });
                    setDialog({ kind: "stations" });
                  }
                : close
            }
            onSave={async (p) => {
              if (station) {
                const next = {
                  ...stationSetup,
                  printers: { ...stationSetup.printers, [station]: p },
                };
                if (db) await saveStations(db, next);
                setStationSetup(next);
                setDialogStatus({ text: "", n: 0 });
                setDialog({ kind: "stations" });
                return;
              }
              if (db) await savePrinter(db, p);
              setPrinter(p);
              close();
            }}
            onTest={async (p) => {
              const lines = ["Tillflow", "Test print", "EUR \u20ac"];
              if ((await printLines(p, lines, false)) === "printed")
                announce(t("register.printed"));
              else {
                setPrintJob((j) => ({ n: (j?.n ?? 0) + 1, lines }));
                announce(t("register.printFallback"));
              }
            }}
          />
        );
      }
      case "stations":
        return (
          <StationsDialog
            value={stationSetup}
            categories={data?.categories ?? []}
            onChange={async (next) => {
              if (db) await saveStations(db, next);
              setStationSetup(next);
            }}
            onSetUp={(station) => setDialog({ kind: "printer", station })}
            onClose={close}
          />
        );
      case "allergens": {
        const items = (data?.variants ?? []).flatMap((v) => {
          const allergens = allergensOf(v.attributes);
          const p = index.products.get(v.productId);
          return p && allergens.length
            ? [{ id: v.id, name: [p.name, variantLabel(v)].filter(Boolean).join(" – "), allergens }]
            : [];
        });
        return (
          <AllergenListDialog
            items={items}
            status={dialogStatus.text}
            onClose={close}
            onPrint={async () => {
              const lines = allergenListLines(
                items,
                printer.cols,
                t("register.allergensTitle"),
                allergenName,
              );
              if ((await printLines(printer, lines, false)) === "printed")
                announce(t("register.printed"));
              else {
                setPrintJob((j) => ({ n: (j?.n ?? 0) + 1, lines }));
                announce(t("register.printFallback"));
              }
            }}
          />
        );
      }
      case "done": {
        const { sale } = dialog;
        const change = ctx
          ? settleTenders(
              priceSale(sale).basket.total,
              sale.tenders.map((x) => ({
                method: x.method,
                amount: x.amountCents,
                tip: x.tipCents,
              })),
              { roundCash: sale.roundCash ?? true },
            ).change
          : 0;
        return (
          <DoneDialog
            change={change}
            status={dialog.status}
            invoiceIssued={!!sale.invoice}
            onNewSale={newSale}
            onPrint={async () =>
              setDialog({ ...dialog, status: await print(sale, { asInvoice: !!sale.invoice }) })
            }
            onTickets={
              preset?.register.kitchenTickets
                ? async () => setDialog({ ...dialog, status: await printTickets(sale) })
                : undefined
            }
            onEmail={() => setDialog({ kind: "email", sale, status: "", sending: false })}
            onInvoice={() => setDialog({ kind: "invoice", sale })}
          />
        );
      }
      case "email": {
        const { sale } = dialog;
        return (
          <EmailDialog
            status={dialog.status}
            sending={dialog.sending}
            onClose={() => setDialog({ kind: "done", sale, status: "" })}
            onSend={async (to) => {
              if (!ctx) return;
              if (!navigator.onLine)
                return setDialog({ ...dialog, status: t("register.emailOffline") });
              setDialog({ ...dialog, sending: true, status: "" });
              let ok = false;
              try {
                const r = await emailReceipt(orgId, {
                  lines: sale.cart.lines.map((l) => ({
                    variantId: l.variantId,
                    qty: l.qty,
                    modifierIds: l.modifiers.map((m) => m.id),
                    serial: l.serial,
                    discount: l.discount,
                  })),
                  basketDiscount: sale.cart.discount,
                  mode: sale.cart.mode ?? "eat_in",
                  expectedDueCents: settleTenders(
                    priceSale(sale).basket.total,
                    sale.tenders.map((x) => ({
                      method: x.method,
                      amount: x.amountCents,
                      tip: x.tipCents,
                    })),
                    { roundCash: sale.roundCash ?? true },
                  ).amountDue,
                  roundCash: sale.roundCash ?? true,
                  tenders: sale.tenders.map(toWireTender),
                  receiptSeq: sale.receiptSeq,
                  registerName: tillName(sale.registerId),
                  completedAt: sale.completedAt,
                  to,
                  invoice: sale.invoice,
                });
                ok = r.ok;
              } catch {
                ok = false; // offline, or the server could not be reached
              }
              if (ok) setDialog({ kind: "done", sale, status: t("register.emailSent") });
              else
                setDialog({
                  kind: "email",
                  sale,
                  sending: false,
                  status: t("register.emailFailed"),
                });
            }}
          />
        );
      }
      case "invoice": {
        const { sale } = dialog;
        return (
          <InvoiceDialog
            shopHasVat={!!data?.org?.vatNumber}
            initial={sale.invoice}
            onClose={() => setDialog({ kind: "done", sale, status: "" })}
            onDone={async (invoice: InvoiceInput) => {
              if (db) await setInvoice(db, sale.id, invoice);
              const issued = { ...sale, invoice };
              setDialog({
                kind: "done",
                sale: issued,
                status: await print(issued, { asInvoice: true }),
              });
            }}
          />
        );
      }
    }
  }

  const parkedCount = data?.parked.length ?? 0;

  if (sync.unpaired) {
    return (
      <main className="surface-solid bg-background text-foreground flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-heading font-semibold">{t("register.unpairedTitle")}</h1>
        <p className="max-w-md">{t("register.unpairedBody")}</p>
        <Link href="/register/pair" className={buttonVariants({ size: "touch" })}>
          {t("register.unpairedAction")}
        </Link>
      </main>
    );
  }
  if (!cashier) {
    return (
      <LockScreen
        staff={data?.staff ?? []}
        ready={!!data?.org}
        offline={!online}
        verify={verify("unlock")}
        onUnlock={(c) => {
          setApproval(null);
          setCashier(c);
          say(t("lock.serving", { name: c.name }));
          focusCart();
        }}
      />
    );
  }

  return (
    <>
      <RegisterLayout
        header={
          <>
            <h1 className="text-heading font-semibold">{t("register.title")}</h1>
            <Button
              size="touch"
              variant="outline"
              className="ml-auto"
              onClick={() => setCashier(null)}
            >
              <LockIcon aria-hidden /> {t("lock.lockTill")}
              <span className="sr-only"> ({t("lock.serving", { name: cashier.name })})</span>
            </Button>
            <Button
              size="touch"
              variant="outline"
              onClick={() => setDialog({ kind: "override", ask: { kind: "noSale" } })}
            >
              <ArchiveIcon aria-hidden /> {t("register.openDrawer")}
            </Button>
            <Button
              size="touch"
              variant="outline"
              aria-disabled={!shift}
              onClick={() =>
                shift ? setDialog({ kind: "shiftMenu" }) : say(t("shift.needOpenShift"))
              }
            >
              <ClockIcon aria-hidden /> {t("shift.button")}
            </Button>
            <Button
              size="touch"
              variant="outline"
              aria-disabled={!till || !data?.org || !preset || !shift}
              onClick={() =>
                till && data?.org && preset && shift
                  ? setDialog({ kind: "refund" })
                  : say(t("shift.needOpenShift"))
              }
            >
              <RotateCcwIcon aria-hidden /> {t("register.refund")}
            </Button>
            <Button size="touch" variant="outline" onClick={() => setDialog({ kind: "printer" })}>
              <PrinterIcon aria-hidden /> {t("register.printer")}:{" "}
              {t(`register.printer.${printer.type}`)}
            </Button>
            {preset?.register.kitchenTickets && (
              <Button
                size="touch"
                variant="outline"
                onClick={() => setDialog({ kind: "stations" })}
              >
                <ChefHatIcon aria-hidden /> {t("register.stations")}
              </Button>
            )}
            {preset?.receipt.allergens && (
              <Button
                size="touch"
                variant="outline"
                onClick={() => setDialog({ kind: "allergens" })}
              >
                <WheatIcon aria-hidden /> {t("register.allergens")}
              </Button>
            )}
            <SyncStatusPill state={outbox.pill} waiting={outbox.waiting} />
          </>
        }
        tiles={
          <>
            {/* One live region that is always on the page, so notices that appear are announced. */}
            <div role="status" className="flex flex-col gap-2">
              {outbox.staleHours !== null && (
                <p className="border-warning bg-warning text-warning-foreground flex items-center gap-2 rounded-lg border-2 p-3 text-sm font-semibold">
                  <TriangleAlertIcon aria-hidden className="size-5 shrink-0" />
                  {t("register.staleWarning", { count: outbox.waiting, hours: outbox.staleHours })}
                </p>
              )}
              {exchangeDraft && (
                <div className="border-solid-border bg-paper flex flex-wrap items-center gap-2 rounded-lg border-2 p-3 text-sm font-semibold">
                  <RotateCcwIcon aria-hidden className="size-5 shrink-0" />
                  <span className="flex-1">
                    {t("refund.exchangeDone", { amount: formatCents(exchangeDraft.creditCents) })}
                    {priced && priced.basket.total < exchangeDraft.creditCents && (
                      <span className="block">{t("refund.exchangeTooSmall")}</span>
                    )}
                  </span>
                  <Button size="touch" variant="outline" onClick={() => void cancelExchange()}>
                    {t("refund.exchangeCancel")}
                  </Button>
                </div>
              )}
              {outbox.signedOut && (
                <p className="border-solid-border bg-paper flex items-center gap-2 rounded-lg border-2 p-3 text-sm font-semibold">
                  <TriangleAlertIcon aria-hidden className="size-5 shrink-0" />
                  {t("register.signedOutNotice")}
                </p>
              )}
              {outbox.rejected > 0 && (
                <p className="border-solid-border bg-paper flex items-center gap-2 rounded-lg border-2 p-3 text-sm font-semibold">
                  <TriangleAlertIcon aria-hidden className="size-5 shrink-0" />
                  {t("register.rejectedNotice", { count: outbox.rejected })}
                </p>
              )}
            </div>
            <div className="relative">
              <SearchIcon
                aria-hidden
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2"
              />
              <Input
                type="search"
                aria-label={t("register.search")}
                placeholder={t("register.search")}
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-12 pl-10 text-base md:text-base"
              />
            </div>
            {!data ? (
              <p>{t("register.loading")}</p>
            ) : !data.org ? (
              <p role="status">{sync.failed ? t("register.noCatalogue") : t("register.loading")}</p>
            ) : (
              <>
                <div
                  role="group"
                  aria-label={t("register.categories")}
                  className="flex flex-wrap gap-2"
                >
                  <Button
                    size="touch"
                    variant={categoryId === null ? "default" : "outline"}
                    aria-pressed={categoryId === null}
                    onClick={() => setCategoryId(null)}
                  >
                    {categoryId === null && <CheckIcon aria-hidden />}
                    {t("register.all")}
                  </Button>
                  {[...data.categories]
                    .sort((a, b) => a.sort - b.sort)
                    .map((c) => (
                      <Button
                        key={c.id}
                        size="touch"
                        variant={categoryId === c.id ? "default" : "outline"}
                        aria-pressed={categoryId === c.id}
                        onClick={() => setCategoryId(c.id)}
                      >
                        {categoryId === c.id && <CheckIcon aria-hidden />}
                        {c.name}
                      </Button>
                    ))}
                </div>
                {tiles.length === 0 ? (
                  <p>{t("register.noProducts")}</p>
                ) : (
                  <ul
                    aria-label={t("register.products")}
                    className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
                  >
                    {tiles.map((p) => {
                      const vs = index.variantsOf.get(p.id) ?? [];
                      const prices = vs.map((v) => v.priceCents);
                      const low = prices.length ? Math.min(...prices) : null;
                      return (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => tapProduct(p)}
                            className="till-key flex min-h-24 w-full flex-col items-start justify-between rounded-xl p-3 text-left"
                          >
                            <span className="font-display leading-tight font-semibold">
                              {p.name}
                            </span>
                            {preset?.receipt.allergens && (
                              <AllergenBadge
                                codes={[...new Set(vs.flatMap((v) => allergensOf(v.attributes)))]}
                              />
                            )}
                            {low !== null && (
                              <span className="font-mono text-sm tabular-nums">
                                {vs.length > 1
                                  ? t("register.from", { price: formatCents(low) })
                                  : formatCents(low)}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </>
        }
        cart={
          <>
            <p
              role="status"
              className={
                message.text
                  ? "border-solid-border bg-paper mb-3 rounded-lg border-2 p-2 text-sm font-medium"
                  : "sr-only"
              }
            >
              {message.text}
            </p>
            <p role="status" className="sr-only">
              {priced &&
                t("register.status", { count: itemCount, total: formatCents(priced.basket.total) })}
            </p>
            <h2
              id="register-cart-heading"
              tabIndex={-1}
              className="mb-3 text-lg font-semibold outline-offset-4"
            >
              {t("register.cart")}
            </h2>
            {preset?.register.eatInToggle && (
              <div
                role="group"
                aria-label={t("register.serviceMode")}
                className="mb-3 grid grid-cols-2 gap-2"
              >
                {(["eat_in", "take_away"] as const).map((m) => {
                  const on = (cart.mode ?? "eat_in") === m;
                  return (
                    <Button
                      key={m}
                      size="touch"
                      variant={on ? "default" : "outline"}
                      aria-pressed={on}
                      onClick={() => dispatch({ type: "mode", mode: m })}
                    >
                      {on && <CheckIcon aria-hidden />}
                      {t(m === "eat_in" ? "register.eatIn" : "register.takeAway")}
                    </Button>
                  );
                })}
              </div>
            )}
            {preset?.register.orderName && (
              <div className="mb-3 flex flex-col gap-1 text-sm">
                <label htmlFor="order-name" className="font-medium">
                  {t("register.orderName")}
                </label>
                <Input
                  id="order-name"
                  className="h-12"
                  maxLength={ORDER_NAME_MAX}
                  autoComplete="off"
                  aria-describedby="order-name-hint"
                  value={cart.orderName ?? ""}
                  onChange={(e) => dispatch({ type: "orderName", name: e.target.value })}
                />
                <span id="order-name-hint" className="text-muted-foreground text-xs">
                  {t("register.orderNameHint")}
                </span>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {cart.lines.length === 0 ? (
                <p className="text-muted-foreground">{t("register.cartEmpty")}</p>
              ) : (
                <ul className="bg-paper receipt-edge border-input rounded-t-xl border border-b-0 font-mono">
                  {cart.lines.map((l, i) => (
                    <li
                      key={l.id}
                      className="border-border flex flex-col gap-2 border-dashed p-3 not-last:border-b-2"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium">{l.name}</span>
                        <span
                          aria-hidden
                          className="border-muted-foreground/60 flex-1 border-b-2 border-dotted"
                        />
                        <span className="font-semibold tabular-nums">
                          {priced ? formatCents(lineTotal(priced, priced.itemIndex[i]!)) : ""}
                        </span>
                      </div>
                      {(l.modifiers.length > 0 || l.serial || l.discount) && (
                        <p className="text-muted-foreground text-xs">
                          {[
                            ...l.modifiers.map((m) => m.name),
                            l.serial ? `${t("register.serialTitle")}: ${l.serial}` : "",
                            l.discount ? t("register.line.discounted") : "",
                            l.qty > 1 ? `${l.qty} × ${formatCents(unitWithModifiers(l))}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}
                      <AllergenBadge codes={l.allergens ?? []} />
                      <div className="flex items-center gap-2">
                        <Button
                          size="icon-touch"
                          variant="outline"
                          aria-label={t("register.decrease", { name: l.name })}
                          onClick={() => dispatch({ type: "qty", id: l.id, delta: -1 })}
                        >
                          <MinusIcon aria-hidden />
                        </Button>
                        <span className="min-w-8 text-center text-lg font-semibold tabular-nums">
                          <span aria-hidden>{l.qty}</span>
                          <span className="sr-only">
                            {t("register.qty", { name: l.name })} {l.qty}
                          </span>
                        </span>
                        <Button
                          size="icon-touch"
                          variant="outline"
                          aria-label={t("register.increase", { name: l.name })}
                          onClick={() => dispatch({ type: "qty", id: l.id, delta: 1 })}
                        >
                          <PlusIcon aria-hidden />
                        </Button>
                        <Button
                          size="icon-touch"
                          variant="outline"
                          className="ml-auto"
                          aria-label={t("register.discountLine", { name: l.name })}
                          onClick={() => setDialog({ kind: "discount", target: l.id })}
                        >
                          <PercentIcon aria-hidden />
                        </Button>
                        <Button
                          size="icon-touch"
                          variant="ghost"
                          aria-label={t("register.remove", { name: l.name })}
                          onClick={() => {
                            dispatch({ type: "remove", id: l.id });
                            say(t("register.removed", { name: l.name }));
                            focusCart();
                          }}
                        >
                          <Trash2Icon aria-hidden />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-3 flex flex-col gap-3">
              {pricing === "error" && (
                <p role="alert" className="text-destructive text-sm">
                  {t("register.noCatalogue")}
                </p>
              )}
              <dl className="flex flex-col gap-1 text-sm tabular-nums">
                {priced?.basket.vatByRate.map((r) => (
                  <div key={r.rateBp} className="text-muted-foreground flex justify-between">
                    <dt>
                      {t("register.vatIncluded")} {ratePercent(r.rateBp)}
                    </dt>
                    <dd>{formatCents(r.vat)}</dd>
                  </div>
                ))}
                {priced && priced.basket.nonVatTotal !== 0 && (
                  <div className="text-muted-foreground flex justify-between">
                    <dt>{t("register.deposit")}</dt>
                    <dd>{formatCents(priced.basket.nonVatTotal)}</dd>
                  </div>
                )}
                <div className="border-solid-border flex items-baseline justify-between border-t-2 pt-2">
                  <dt className="text-heading font-display font-semibold">{t("register.total")}</dt>
                  <dd className="font-display text-amount font-semibold">{formatCents(due)}</dd>
                </div>
              </dl>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  size="touch"
                  variant="outline"
                  disabled={cart.lines.length === 0}
                  onClick={park}
                >
                  <PauseIcon aria-hidden /> {t("register.park")}
                </Button>
                <Button
                  size="touch"
                  variant="outline"
                  onClick={() => setDialog({ kind: "parked" })}
                >
                  {parkedCount > 0
                    ? t("register.recallCount", { count: parkedCount })
                    : t("register.recall")}
                </Button>
                <Button
                  size="touch"
                  variant="outline"
                  disabled={cart.lines.length === 0}
                  onClick={() => setDialog({ kind: "discount", target: "basket" })}
                >
                  <PercentIcon aria-hidden /> {t("register.discount")}
                </Button>
              </div>
              <div className="flex gap-2">
                <Button
                  size="touch"
                  variant="outline"
                  className="min-w-0 flex-1 justify-start"
                  ref={customerButton}
                  aria-haspopup="dialog"
                  title={customer ? customer.name : undefined}
                  onClick={() => setDialog({ kind: "customer" })}
                >
                  <UserRoundIcon aria-hidden />
                  <span className="truncate">
                    {customer
                      ? t("till.customer.buttonNamed", { name: customer.name })
                      : t("till.customer.button")}
                  </span>
                </Button>
                {customer ? (
                  <Button
                    size="touch"
                    variant="outline"
                    onClick={() => {
                      setCustomer(null);
                      say(t("till.customer.cleared"));
                      customerButton.current?.focus(); // the Remove button is about to unmount
                    }}
                  >
                    {t("till.customer.remove")}
                  </Button>
                ) : null}
              </div>
              <Button size="pay" className="hidden lg:inline-flex" disabled={!canPay} onClick={pay}>
                {payLabel}
              </Button>
            </div>
          </>
        }
        bar={
          <>
            <p className="font-display text-title font-semibold tabular-nums">{formatCents(due)}</p>
            <Button size="pay" className="flex-1" disabled={!canPay} onClick={pay}>
              {payLabel}
            </Button>
          </>
        }
      />
      {renderDialog()}
      {shift === undefined && dialog === null && !!till && (
        <OpenShiftDialog onOpen={(f) => void openShiftNow(f)} onLock={() => setCashier(null)} />
      )}
      <PrintArea job={printJob} cols={printer.cols} />
    </>
  );
}
