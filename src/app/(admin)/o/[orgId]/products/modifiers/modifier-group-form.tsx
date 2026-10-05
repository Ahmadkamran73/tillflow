"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { TextField } from "@/components/back-office/form-bits";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import type { FormState } from "@/lib/auth/schemas";
import { saveModifierGroupAction } from "@/lib/catalog-actions";
import { t } from "@/lib/i18n";
import { parseModifierGroupForm, type RawModifierGroup } from "@/lib/modifier-schema";

export function ModifierGroupForm({
  orgId,
  initial,
}: {
  orgId: string;
  initial: RawModifierGroup;
}) {
  const [raw, setRaw] = useState(initial);
  const [state, formAction, pending] = useActionState(
    async (prev: FormState, formData: FormData): Promise<FormState> => {
      const checked = parseModifierGroupForm(raw);
      if (!checked.ok) return { fieldErrors: checked.fieldErrors };
      return saveModifierGroupAction(prev, formData);
    },
    {} as FormState,
  );
  const errors = state.fieldErrors ?? {};
  const errorRef = useRef<HTMLParagraphElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
    else if (state.fieldErrors) {
      document.querySelector<HTMLElement>("form [aria-invalid=true]")?.focus();
    }
  }, [state]);

  const setOption = (i: number, patch: Partial<RawModifierGroup["options"][number]>) =>
    setRaw((r) => ({ ...r, options: r.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));

  return (
    <form
      action={formAction}
      noValidate
      aria-busy={pending}
      className="flex max-w-3xl flex-col gap-6"
    >
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="payload" value={JSON.stringify(raw)} />

      {state.error || errors.form ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-destructive text-sm">
          {state.error ?? errors.form?.[0]}
        </p>
      ) : null}

      <div className="surface-panel flex flex-col gap-4 p-5">
        <TextField
          id="group-name"
          label={t("modifiers.field.name")}
          value={raw.name}
          onChange={(v) => setRaw((r) => ({ ...r, name: v }))}
          errors={errors.name}
          maxLength={60}
          autoComplete="off"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="group-min"
            label={t("modifiers.field.min")}
            value={raw.min}
            onChange={(v) => setRaw((r) => ({ ...r, min: v }))}
            errors={errors.min}
            inputMode="numeric"
          />
          <TextField
            id="group-max"
            label={t("modifiers.field.max")}
            value={raw.max}
            onChange={(v) => setRaw((r) => ({ ...r, max: v }))}
            errors={errors.max}
            inputMode="numeric"
          />
        </div>
      </div>

      <fieldset className="surface-panel flex flex-col gap-4 p-5">
        <legend className="text-heading mb-1 font-semibold">{t("modifiers.options")}</legend>
        {errors.options ? (
          <FieldError errors={errors.options.map((message) => ({ message }))} />
        ) : null}
        <ul className="flex flex-col gap-4">
          {raw.options.map((o, i) => (
            <li key={o.id} className="flex flex-wrap items-start gap-3">
              <TextField
                id={`option-${i}-name`}
                label={t("modifiers.option.name")}
                value={o.name}
                onChange={(v) => setOption(i, { name: v })}
                errors={errors[`options.${i}.name`]}
                maxLength={60}
                autoComplete="off"
                className="min-w-48 flex-1"
              />
              <TextField
                id={`option-${i}-price`}
                label={t("modifiers.option.price")}
                value={o.price}
                onChange={(v) => setOption(i, { price: v })}
                errors={errors[`options.${i}.price`]}
                inputMode="decimal"
                autoComplete="off"
                className="w-48"
                inputClassName="font-mono tabular-nums"
              />
              <Button
                type="button"
                variant="outline"
                className="mt-7 h-12 px-4"
                disabled={raw.options.length <= 1}
                onClick={() => {
                  setRaw((r) => ({ ...r, options: r.options.filter((_, j) => j !== i) }));
                  addRef.current?.focus();
                }}
              >
                {t("modifiers.removeOption", { n: i + 1 })}
              </Button>
            </li>
          ))}
        </ul>
        <Button
          ref={addRef}
          type="button"
          variant="outline"
          className="h-12 w-fit px-5"
          disabled={raw.options.length >= 50}
          onClick={() =>
            setRaw((r) => ({
              ...r,
              options: [...r.options, { id: uuidv7(), name: "", price: "" }],
            }))
          }
        >
          {t("modifiers.addOption")}
        </Button>
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} className="h-12 px-6">
          {pending ? t("catalog.saving") : t("modifiers.save")}
        </Button>
        <Link
          href={`/o/${orgId}/products/modifiers`}
          className="min-h-12 px-3 py-3 text-sm underline underline-offset-4"
        >
          {t("onboarding.back")}
        </Link>
      </div>
    </form>
  );
}
