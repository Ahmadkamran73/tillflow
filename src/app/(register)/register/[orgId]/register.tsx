"use client";

import {
  CheckIcon,
  MinusIcon,
  PauseIcon,
  PercentIcon,
  PrinterIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { RegisterLayout } from "@/components/register/register-layout";
import { SyncStatusPill } from "@/components/sync-status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { presets } from "@/config/business-type-presets";
import { t } from "@/lib/i18n";
import { changeDue, formatCents, localDate, type Discount } from "@/lib/money";
import {
  cartReducer,
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
import { registerDb, type LocalSale, type RegisterDb } from "@/lib/register/db";
import type { InvoiceInput } from "@/lib/register/invoice";
import {
  defaultPrinter,
  loadPrinter,
  printLines,
  savePrinter,
  type PrinterSettings,
} from "@/lib/register/print";
import { buildReceipt, receiptLabels, receiptText } from "@/lib/register/receipt";
import { completeSale, setInvoice } from "@/lib/register/sale";
import type { FeedProduct, FeedVariant } from "@/lib/register/feed";
import { useCatalog, useCatalogRefresh } from "@/lib/register/use-catalog";
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
import {
  DoneDialog,
  EmailDialog,
  InvoiceDialog,
  PrinterDialog,
  TenderDialog,
  TillDialog,
} from "./sale-dialogs";

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
  | { kind: "tender" }
  | { kind: "till" }
  | { kind: "printer" }
  | { kind: "done"; sale: LocalSale; status: string }
  | { kind: "email"; sale: LocalSale; status: string; sending: boolean }
  | { kind: "invoice"; sale: LocalSale };

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
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [message, setMessage] = useState({ text: "", n: 0 });
  const [printer, setPrinter] = useState<PrinterSettings>(defaultPrinter);
  const [printJob, setPrintJob] = useState<{ n: number; lines: string[] } | null>(null);

  useEffect(() => {
    if (!db) return;
    void loadPrinter(db).then(setPrinter);
  }, [db]);

  const preset = data?.org ? presets[data.org.businessType] : null;

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

  useScanner(async (code) => {
    if (!db) return;
    setQuery(""); // the code may also have been typed into the search box
    try {
      const variant = await db.variants.where("barcode").equals(code).first();
      const product = variant && index.products.get(variant.productId);
      if (!variant || !product) say(t("register.scanNotFound", { code }));
      else startAdd(product, variant);
    } catch {
      say(t("register.scanError"));
    }
  }, dialog === null);

  async function park() {
    if (!db || cart.lines.length === 0) return;
    await db.parked.put({ id: uuidv7(), savedAt: Date.now(), cart });
    dispatch({ type: "load", cart: emptyCart });
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

  async function tender(tenderedCents: number) {
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
    let sale: LocalSale;
    try {
      sale = await completeSale(db, { registerId: till.id, cart, tenderedCents });
    } catch {
      say(t("register.saveFailed"));
      return;
    }
    // A cash sale: the drawer opens with the receipt.
    const status = `${t("register.saved")} ${await print(sale, { kick: true })}`;
    setDialog({ kind: "done", sale, status });
    say(status);
  }

  function newSale() {
    dispatch({ type: "load", cart: emptyCart });
    setDialog(null);
    focusCart();
  }

  function pay() {
    setDialog(till ? { kind: "tender" } : { kind: "till" });
  }

  const itemCount = cart.lines.reduce((n, l) => n + l.qty, 0);
  const due = priced ? priced.basket.amountDue : 0;
  const payLabel = t("register.pay", { amount: formatCents(due) });
  const canPay = !!priced && cart.lines.length > 0;
  const pill = sync.syncing ? "syncing" : sync.failed ? "offline" : "online";

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
    const close = () => setDialog(null);
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
            due={due}
            rounding={priced?.basket.cashRounding ?? 0}
            onClose={close}
            onTender={tender}
          />
        );
      case "till":
        return (
          <TillDialog
            tills={tills}
            onClose={close}
            onPick={async (id) => {
              await db?.meta.put({ key: "registerId", value: id });
              setDialog({ kind: "tender" });
            }}
          />
        );
      case "printer":
        return (
          <PrinterDialog
            value={printer}
            onClose={close}
            onSave={async (p) => {
              if (db) await savePrinter(db, p);
              setPrinter(p);
              close();
            }}
            onTest={async (p) => {
              const lines = ["Tillflow", "Test print", "EUR \u20ac"];
              if ((await printLines(p, lines, false)) === "printed") say(t("register.printed"));
              else {
                setPrintJob((j) => ({ n: (j?.n ?? 0) + 1, lines }));
                say(t("register.printFallback"));
              }
            }}
          />
        );
      case "done": {
        const { sale } = dialog;
        const change = ctx ? changeDue(sale.tenderedCents, priceSale(sale).basket.amountDue) : 0;
        return (
          <DoneDialog
            change={change}
            status={dialog.status}
            invoiceIssued={!!sale.invoice}
            onNewSale={newSale}
            onPrint={async () =>
              setDialog({ ...dialog, status: await print(sale, { asInvoice: !!sale.invoice }) })
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
                  expectedDueCents: priceSale(sale).basket.amountDue,
                  tenderedCents: sale.tenderedCents,
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
              onClick={() => setDialog({ kind: "printer" })}
            >
              <PrinterIcon aria-hidden /> {t("register.printer")}:{" "}
              {t(`register.printer.${printer.type}`)}
            </Button>
            <SyncStatusPill state={pill} waiting={0} />
          </>
        }
        tiles={
          <>
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
                            className="till-key flex h-24 w-full flex-col items-start justify-between rounded-xl p-3 text-left"
                          >
                            <span className="font-display leading-tight font-semibold">
                              {p.name}
                            </span>
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
            {message.text && (
              <p
                key={message.n}
                role="status"
                className="border-solid-border bg-paper mb-3 rounded-lg border-2 p-2 text-sm font-medium"
              >
                {message.text}
              </p>
            )}
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
                {priced && priced.basket.cashRounding !== 0 && (
                  <div className="text-muted-foreground flex justify-between">
                    <dt>{t("register.rounding")}</dt>
                    <dd>{formatCents(priced.basket.cashRounding)}</dd>
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
      <PrintArea job={printJob} cols={printer.cols} />
    </>
  );
}
