import { MinusIcon, PauseIcon, PercentIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { RegisterLayout } from "@/components/register/register-layout";
import { SyncStatusPill, type SyncState } from "@/components/sync-status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";

// Placeholder content for the skeleton. Amounts are pre-formatted display strings; real values
// come from src/lib/money (the server recalculates every price and total).
const categories = ["Hot drinks", "Cold drinks", "Food", "Bakery"];
// [name, price]
const tiles = [
  ["Flat white", "€3.40"],
  ["Americano", "€3.00"],
  ["Latte", "€3.60"],
  ["Cappuccino", "€3.60"],
  ["Hot chocolate", "€3.80"],
  ["Green tea", "€2.80"],
  ["Mocha", "€3.90"],
  ["Espresso", "€2.50"],
  ["Iced latte", "€3.90"],
  ["Sparkling water", "€2.20"],
  ["Almond croissant", "€3.60"],
  ["Toastie", "€6.50"],
] as const;
const lines = [
  { name: "Flat white", qty: 2, total: "€6.80" },
  { name: "Almond croissant", qty: 1, total: "€3.60" },
  { name: "Sparkling water", qty: 1, total: "€2.20" },
];

export function RegisterDemo({ state = "online" }: { state?: SyncState }) {
  const pay = t("register.pay", { amount: "€12.60" });
  return (
    <RegisterLayout
      header={
        <>
          <h1 className="text-heading font-semibold">{t("register.title")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("register.till", { number: 1 })} · {t("register.cashier", { name: "Aoife" })}
          </p>
          <SyncStatusPill state={state} waiting={state === "offline" ? 3 : 0} className="ml-auto" />
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
              className="h-12 pl-10 text-base md:text-base"
            />
          </div>
          <div role="group" aria-label={t("register.categories")} className="flex flex-wrap gap-2">
            {categories.map((c, i) => (
              <Button
                key={c}
                size="touch"
                variant={i === 0 ? "default" : "outline"}
                aria-pressed={i === 0}
              >
                {c}
              </Button>
            ))}
          </div>
          <ul
            aria-label={t("register.products")}
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
          >
            {tiles.map(([name, price]) => (
              <li key={name}>
                <button
                  type="button"
                  className="till-key flex h-24 w-full flex-col items-start justify-between rounded-xl p-3 text-left"
                >
                  <span className="font-display leading-tight font-semibold">{name}</span>
                  <span className="font-mono text-sm tabular-nums">{price}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      }
      cart={
        <>
          <p role="status" className="sr-only">
            {t("register.status", { count: 4, total: "€12.60" })}
          </p>
          <h2 id="register-cart-heading" className="mb-3 text-lg font-semibold">
            {t("register.cart")}
          </h2>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ul className="bg-paper receipt-edge border-input rounded-t-xl border border-b-0 font-mono">
              {lines.map((l) => (
                <li
                  key={l.name}
                  className="border-border flex flex-col gap-2 border-dashed p-3 not-last:border-b-2"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{l.name}</span>
                    <span
                      aria-hidden
                      className="border-muted-foreground/60 flex-1 border-b-2 border-dotted"
                    />
                    <span className="font-semibold tabular-nums">{l.total}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="icon-touch"
                      variant="outline"
                      aria-label={t("register.decrease", { name: l.name })}
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
                    >
                      <PlusIcon aria-hidden />
                    </Button>
                    <Button
                      size="icon-touch"
                      variant="ghost"
                      className="ml-auto"
                      aria-label={t("register.remove", { name: l.name })}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-3 flex flex-col gap-3">
            <dl className="flex flex-col gap-1 text-sm tabular-nums">
              <div className="text-muted-foreground flex justify-between">
                <dt>{t("register.vatIncluded")} 9%</dt>
                <dd>€0.86</dd>
              </div>
              <div className="text-muted-foreground flex justify-between">
                <dt>{t("register.vatIncluded")} 23%</dt>
                <dd>€0.41</dd>
              </div>
              <div className="border-solid-border flex items-baseline justify-between border-t-2 pt-2">
                <dt className="text-heading font-display font-semibold">{t("register.total")}</dt>
                <dd className="font-display text-amount font-semibold">€12.60</dd>
              </div>
            </dl>
            <div className="grid grid-cols-2 gap-2">
              <Button size="touch" variant="outline">
                <PauseIcon aria-hidden /> {t("register.park")}
              </Button>
              <Button size="touch" variant="outline">
                <PercentIcon aria-hidden /> {t("register.discount")}
              </Button>
            </div>
            <Button size="pay" className="hidden lg:inline-flex">
              {pay}
            </Button>
          </div>
        </>
      }
      bar={
        <>
          <p className="font-display text-title font-semibold tabular-nums">€12.60</p>
          <Button size="pay" className="flex-1">
            {pay}
          </Button>
        </>
      }
    />
  );
}
