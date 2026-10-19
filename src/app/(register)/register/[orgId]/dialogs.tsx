"use client";

import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { formatCents, parseCents, type Discount } from "@/lib/money";
import type { LineModifier } from "@/lib/register/cart";

// Register dialogs. The default close button is under 48 px, so each dialog has its own Cancel.

export function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="surface-solid max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="text-heading">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export const Cancel = ({ onClick }: { onClick: () => void }) => (
  <Button type="button" size="touch" variant="outline" onClick={onClick}>
    {t("common.cancel")}
  </Button>
);

export function VariantPicker({
  name,
  options,
  onPick,
  onClose,
}: {
  name: string;
  options: { id: string; label: string; priceCents: number }[];
  onPick: (variantId: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={t("register.chooseVariant", { name })} onClose={onClose}>
      <ul className="flex max-h-[50dvh] flex-col gap-2 overflow-y-auto">
        {options.map((o) => (
          <li key={o.id}>
            <Button
              type="button"
              size="touch"
              variant="outline"
              className="w-full justify-between"
              onClick={() => onPick(o.id)}
            >
              <span>{o.label}</span>
              <span className="font-mono tabular-nums">{formatCents(o.priceCents)}</span>
            </Button>
          </li>
        ))}
      </ul>
      <Cancel onClick={onClose} />
    </Modal>
  );
}

export type ModifierGroupView = {
  id: string;
  name: string;
  min: number;
  max: number;
  options: LineModifier[];
};

export function ModifierPicker({
  name,
  groups,
  onDone,
  onClose,
}: {
  name: string;
  groups: ModifierGroupView[];
  onDone: (chosen: LineModifier[]) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const count = (g: ModifierGroupView) => chosen[g.id]?.length ?? 0;
  const missing = groups.find((g) => count(g) < g.min);

  function toggle(g: ModifierGroupView, id: string) {
    setChosen((c) => {
      const now = c[g.id] ?? [];
      if (now.includes(id)) return { ...c, [g.id]: now.filter((x) => x !== id) };
      // A single-choice group swaps; a multi-choice group stops at its maximum.
      if (g.max === 1) return { ...c, [g.id]: [id] };
      return now.length >= g.max ? c : { ...c, [g.id]: [...now, id] };
    });
  }

  return (
    <Modal title={t("register.chooseModifiers", { name })} onClose={onClose}>
      <div className="flex max-h-[55dvh] flex-col gap-4 overflow-y-auto">
        {groups.map((g) => (
          <fieldset key={g.id} className="flex flex-col gap-2">
            <legend className="font-semibold">{g.name}</legend>
            <p className="text-muted-foreground text-sm">
              {g.min > 0
                ? t("register.modifierRule", { min: g.min, max: g.max })
                : t("register.modifierMax", { max: g.max })}
            </p>
            <div className="flex flex-wrap gap-2">
              {g.options.map((o) => (
                <Button
                  key={o.id}
                  type="button"
                  size="touch"
                  variant={chosen[g.id]?.includes(o.id) ? "default" : "outline"}
                  aria-pressed={chosen[g.id]?.includes(o.id) ?? false}
                  // At the maximum the rest are switched off, so a tap is never silently ignored.
                  disabled={g.max > 1 && count(g) >= g.max && !chosen[g.id]?.includes(o.id)}
                  onClick={() => toggle(g, o.id)}
                >
                  {chosen[g.id]?.includes(o.id) && <CheckIcon aria-hidden />}
                  {o.name}
                  {o.priceDeltaCents !== 0 && (
                    <span className="ml-1 font-mono tabular-nums">
                      {o.priceDeltaCents > 0 ? "+" : ""}
                      {formatCents(o.priceDeltaCents)}
                    </span>
                  )}
                </Button>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      {missing && (
        <p role="status" className="text-destructive text-sm">
          {t("register.modifierNeed", { min: missing.min, group: missing.name })}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Cancel onClick={onClose} />
        <Button
          type="button"
          size="touch"
          disabled={!!missing}
          onClick={() =>
            onDone(groups.flatMap((g) => g.options.filter((o) => chosen[g.id]?.includes(o.id))))
          }
        >
          {t("register.addToSale")}
        </Button>
      </div>
    </Modal>
  );
}

const SERIAL = /^[A-Za-z0-9-]{4,40}$/;

export function SerialPrompt({
  onDone,
  onClose,
}: {
  onDone: (serial: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  return (
    <Modal title={t("register.serialTitle")} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          if (SERIAL.test(v)) onDone(v);
          else setError(true);
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("register.serialLabel")}
          <Input
            autoFocus
            autoComplete="off"
            value={value}
            aria-invalid={error}
            aria-describedby={error ? "serial-error" : undefined}
            className="h-12 text-base md:text-base"
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {error && (
          <p id="serial-error" role="alert" className="text-destructive text-sm">
            {t("register.serialInvalid")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Cancel onClick={onClose} />
          <Button type="submit" size="touch">
            {t("register.addToSale")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function AgeCheck({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  return (
    <Modal title={t("register.ageTitle")} description={t("register.ageBody")} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        <Cancel onClick={onClose} />
        <Button type="button" size="touch" onClick={onDone}>
          {t("register.ageConfirm")}
        </Button>
      </div>
    </Modal>
  );
}

/** `valid(candidate)` is true when the cart can still be priced with it (the library rejects the rest). */
export function DiscountDialog({
  title,
  current,
  valid,
  onApply,
  onClose,
}: {
  title: string;
  current: Discount | undefined;
  valid: (d: Discount) => boolean;
  onApply: (d: Discount | undefined) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"percent" | "amount">(
    current && "amount" in current ? "amount" : "percent",
  );
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // "12.5" parses as 1250 cents, which is also 12.5% in basis points.
    const n = parseCents(value);
    const d: Discount | null =
      n === null || n === 0 ? null : kind === "percent" ? { percentBp: n } : { amount: n };
    if (!d || ("percentBp" in d && d.percentBp > 10000) || !valid(d)) setError(true);
    else onApply(d);
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div
          role="group"
          aria-label={t("register.discountTitle")}
          className="grid grid-cols-2 gap-2"
        >
          {(["percent", "amount"] as const).map((k) => (
            <Button
              key={k}
              type="button"
              size="touch"
              variant={kind === k ? "default" : "outline"}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
            >
              {kind === k && <CheckIcon aria-hidden />}
              {t(k === "percent" ? "register.discountPercent" : "register.discountAmount")}
            </Button>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {kind === "percent" ? t("register.discountPercent") : t("register.discountAmount")}
          <Input
            autoFocus
            inputMode="decimal"
            autoComplete="off"
            value={value}
            aria-invalid={error}
            aria-describedby={error ? "discount-error" : undefined}
            className="h-12 text-base tabular-nums md:text-base"
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {error && (
          <p id="discount-error" role="alert" className="text-destructive text-sm">
            {t("register.discountInvalid")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Cancel onClick={onClose} />
          <Button type="submit" size="touch">
            {t("register.discountApply")}
          </Button>
        </div>
        {current && (
          <Button type="button" size="touch" variant="outline" onClick={() => onApply(undefined)}>
            {t("register.discountRemove")}
          </Button>
        )}
      </form>
    </Modal>
  );
}

export function ParkedList({
  items,
  onRecall,
  onClose,
}: {
  items: { id: string; count: number; time: string }[];
  onRecall: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={t("register.parkedTitle")} onClose={onClose}>
      {items.length === 0 ? (
        <p className="text-muted-foreground">{t("register.parkedEmpty")}</p>
      ) : (
        <ul className="flex max-h-[50dvh] flex-col gap-2 overflow-y-auto">
          {items.map((p) => (
            <li key={p.id}>
              <Button
                type="button"
                size="touch"
                variant="outline"
                className="w-full justify-between"
                onClick={() => onRecall(p.id)}
              >
                <span>{t("register.parkedItem", { count: p.count, time: p.time })}</span>
                <span>{t("register.recall")}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Cancel onClick={onClose} />
    </Modal>
  );
}
