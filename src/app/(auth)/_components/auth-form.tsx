"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/auth/schemas";

export type AuthField = {
  name: string;
  label: string;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  inputMode?: "numeric" | "text";
  maxLength?: number;
  hint?: string;
  /** Pre-filled value for the first render (never a secret). */
  defaultValue?: string;
};

type Props = {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  fields: AuthField[];
  submitLabel: string;
  /** Extra non-secret values posted with the form (e.g. the post-login destination). */
  hidden?: Record<string, string>;
};

/**
 * One form for every auth screen. Server action does the validation; this only shows the result.
 * Text fields keep what was typed after an error, password fields are cleared.
 */
export function AuthForm({ action, fields, submitLabel, hidden }: Props) {
  // Inputs stay uncontrolled so text typed before hydration is never wiped. React 19 resets a form
  // after its action runs, so remember the submitted non-secret values and use them as defaults.
  const [saved, setSaved] = useState<{ attempt: number; values: Record<string, string> }>({
    attempt: 0,
    values: {},
  });
  const [state, formAction, pending] = useActionState(
    async (prev: FormState, formData: FormData) => {
      setSaved((prev) => ({
        attempt: prev.attempt + 1,
        values: Object.fromEntries(
          fields
            .filter((f) => f.type !== "password")
            .map((f) => [f.name, String(formData.get(f.name) ?? "")]),
        ),
      }));
      return action(prev, formData);
    },
    {} as FormState,
  );

  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Inputs remount after each attempt, which drops focus. Put it back on the first invalid field,
  // or on the form-level error, so keyboard and screen-reader users land on what needs fixing.
  useEffect(() => {
    if (!state.error && !state.fieldErrors) return;
    const invalid = formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]");
    (invalid ?? errorRef.current)?.focus();
  }, [state]);

  if (state.ok) {
    return (
      <p role="status" tabIndex={-1} className="rounded-lg border p-3 text-sm">
        {state.message}
      </p>
    );
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-4"
      noValidate
      aria-busy={pending}
    >
      <p className="text-muted-foreground text-sm">All fields are required.</p>
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {state.error ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      {fields.map((f) => {
        const errors = state.fieldErrors?.[f.name];
        const id = `field-${f.name}`;
        return (
          <Field key={f.name}>
            <FieldLabel htmlFor={id}>{f.label}</FieldLabel>
            <Input
              id={id}
              name={f.name}
              type={f.type ?? "text"}
              autoComplete={f.autoComplete}
              inputMode={f.inputMode}
              maxLength={f.maxLength}
              required
              className="h-12"
              aria-invalid={errors ? true : undefined}
              aria-describedby={
                [f.hint ? `${id}-hint` : "", errors ? `${id}-error` : ""]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              key={saved.attempt}
              defaultValue={saved.values[f.name] ?? f.defaultValue ?? ""}
            />
            {f.hint ? (
              <p id={`${id}-hint`} className="text-muted-foreground text-sm">
                {f.hint}
              </p>
            ) : null}
            {errors ? (
              <FieldError id={`${id}-error`} errors={errors.map((message) => ({ message }))} />
            ) : null}
          </Field>
        );
      })}

      <Button
        type="submit"
        className="h-12"
        aria-disabled={pending}
        onClick={(e) => pending && e.preventDefault()}
      >
        {pending ? "Please wait…" : submitLabel}
      </Button>
    </form>
  );
}
