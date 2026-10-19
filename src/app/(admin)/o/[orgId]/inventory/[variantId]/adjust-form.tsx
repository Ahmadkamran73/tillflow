"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { adjustStockAction } from "@/lib/inventory-actions";
import { adjustReasons } from "@/lib/inventory-schema";
import { t } from "@/lib/i18n";

const field =
  "border-input bg-background h-12 rounded-lg border px-3 text-base outline-none focus-visible:ring-3 md:text-sm";

export function AdjustForm({ orgId, variantId }: { orgId: string; variantId: string }) {
  const [state, action, pending] = useActionState(adjustStockAction, {});
  const [reason, setReason] = useState<(typeof adjustReasons)[number]>("received");
  // Controlled, so a refused submit keeps what was typed (React resets uncontrolled fields).
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const qtyRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const qtyErr = state.fieldErrors?.qty?.[0];
  const noteErr = state.fieldErrors?.note?.[0];

  useEffect(() => {
    if (qtyErr) qtyRef.current?.focus();
    else if (noteErr) noteRef.current?.focus();
  }, [state, qtyErr, noteErr]);

  return (
    <form action={action} className="surface-panel flex max-w-xl flex-col gap-4 p-5">
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="variantId" value={variantId} />
      <h2 className="text-heading font-semibold">{t("inventory.adjust.title")}</h2>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="reason" className="text-sm font-medium">
          {t("inventory.adjust.reason")}
        </label>
        <select
          id="reason"
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value as typeof reason)}
          className={field}
        >
          {adjustReasons.map((r) => (
            <option key={r} value={r}>
              {t(`inventory.reason.${r}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="qty" className="text-sm font-medium">
          {t(`inventory.adjust.qty.${reason}`)}
        </label>
        <input
          ref={qtyRef}
          id="qty"
          name="qty"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          // A negative correction needs a minus sign, which numeric keypads lack.
          inputMode={reason === "adjustment" ? "text" : "numeric"}
          autoComplete="off"
          required
          aria-invalid={qtyErr ? true : undefined}
          aria-describedby={
            [qtyErr ? "qty-err" : "", reason === "count" ? "qty-hint" : ""]
              .filter(Boolean)
              .join(" ") || undefined
          }
          className={field}
        />
        {reason === "count" ? (
          <p id="qty-hint" className="text-muted-foreground text-sm">
            {t("inventory.adjust.hint.count")}
          </p>
        ) : null}
        {qtyErr ? (
          <p id="qty-err" className="text-destructive text-sm">
            {qtyErr}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="note" className="text-sm font-medium">
          {t("inventory.adjust.note")}
        </label>
        <input
          ref={noteRef}
          id="note"
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          autoComplete="off"
          aria-invalid={noteErr ? true : undefined}
          aria-describedby={noteErr ? "note-err" : undefined}
          className={field}
        />
        {noteErr ? (
          <p id="note-err" className="text-destructive text-sm">
            {noteErr}
          </p>
        ) : null}
      </div>

      <div role="status">
        {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      </div>
      <Button
        type="submit"
        size="touch"
        aria-disabled={pending}
        onClick={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        {pending ? t("inventory.adjust.working") : t("inventory.adjust.submit")}
      </Button>
    </form>
  );
}
