"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { saveCustomerAction } from "@/lib/customer-actions";
import { t } from "@/lib/i18n";

const field =
  "border-input bg-background h-12 rounded-lg border px-3 text-base outline-none focus-visible:ring-3 md:text-sm";

type Values = {
  name: string;
  email: string;
  phone: string;
  vatNumber: string;
  address: string;
  notes: string;
};

type Key = "name" | "email" | "phone" | "vatNumber" | "address";
const KEYS: Key[] = ["name", "email", "phone", "vatNumber", "address"];

export function CustomerForm({
  orgId,
  customerId,
  initial,
}: {
  orgId: string;
  customerId?: string;
  initial: Values;
}) {
  const [state, action, pending] = useActionState(saveCustomerAction, {});
  // Controlled, so a refused save keeps what was typed (React resets uncontrolled fields).
  const [values, setValues] = useState<Values>(initial);
  const refs = useRef<Record<Key, HTMLInputElement | null>>({
    name: null,
    email: null,
    phone: null,
    vatNumber: null,
    address: null,
  });
  const errs: Partial<Record<string, string[]>> = state.fieldErrors ?? {};

  // Focus the first field with an error.
  useEffect(() => {
    const fe = state.fieldErrors ?? {};
    const first = KEYS.find((k) => fe[k]);
    if (first) refs.current[first]?.focus();
  }, [state]);

  const input = (
    k: Key,
    label: string,
    opts: { type?: string; hint?: string; max: number; required?: boolean },
  ) => {
    const err = errs[k]?.[0];
    const describedBy = [opts.hint ? `${k}-hint` : "", err ? `${k}-err` : ""]
      .filter(Boolean)
      .join(" ");
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={k} className="text-sm font-medium">
          {label}
          {opts.required ? ` ${t("customers.required")}` : ""}
        </label>
        <input
          ref={(el) => {
            refs.current[k] = el;
          }}
          id={k}
          name={k}
          type={opts.type ?? "text"}
          value={values[k]}
          onChange={(e) => setValues({ ...values, [k]: e.target.value })}
          maxLength={opts.max}
          required={opts.required}
          autoComplete="off"
          aria-invalid={err ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={field}
        />
        {opts.hint ? (
          <p id={`${k}-hint`} className="text-muted-foreground text-sm">
            {opts.hint}
          </p>
        ) : null}
        {err ? (
          <p id={`${k}-err`} className="text-destructive text-sm">
            {err}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <form action={action} className="surface-panel flex max-w-xl flex-col gap-4 p-5">
      <input type="hidden" name="orgId" value={orgId} />
      {customerId ? <input type="hidden" name="customerId" value={customerId} /> : null}
      {input("name", t("customers.field.name"), { max: 120, required: true })}
      {input("email", t("customers.field.email"), { type: "email", max: 254 })}
      {input("phone", t("customers.field.phone"), { type: "tel", max: 30 })}
      {input("vatNumber", t("customers.field.vat"), {
        max: 24,
        hint: t("customers.field.vatHint"),
      })}
      {input("address", t("customers.field.address"), { max: 300 })}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="notes" className="text-sm font-medium">
          {t("customers.field.notes")}
        </label>
        <textarea
          id="notes"
          name="notes"
          value={values.notes}
          onChange={(e) => setValues({ ...values, notes: e.target.value })}
          maxLength={500}
          rows={3}
          className="border-input bg-background rounded-lg border px-3 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"
        />
      </div>
      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="h-12 self-start px-6" aria-disabled={pending || undefined}>
        {pending ? t("customers.saving") : t("customers.save")}
      </Button>
    </form>
  );
}
