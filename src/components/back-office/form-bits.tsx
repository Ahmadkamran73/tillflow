"use client";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "cn";

type Errors = readonly string[] | undefined;

const describedBy = (id: string, errors: Errors, hint?: string) =>
  [hint ? `${id}-hint` : "", errors?.length ? `${id}-error` : ""].filter(Boolean).join(" ") ||
  undefined;

function Errors({ id, errors }: { id: string; errors: Errors }) {
  return errors?.length ? (
    <FieldError id={`${id}-error`} errors={errors.map((message) => ({ message }))} />
  ) : null;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  errors,
  hint,
  className,
  inputClassName,
  ...rest
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  errors?: Errors;
  hint?: string;
  className?: string;
  inputClassName?: string;
} & Omit<React.ComponentProps<"input">, "onChange" | "value" | "id">) {
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn("h-12", inputClassName)}
        aria-invalid={errors?.length ? true : undefined}
        aria-describedby={describedBy(id, errors, hint)}
        {...rest}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground text-sm">
          {hint}
        </p>
      ) : null}
      <Errors id={id} errors={errors} />
    </Field>
  );
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  errors,
  className,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  errors?: Errors;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={errors?.length ? true : undefined}
        aria-describedby={describedBy(id, errors)}
        className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive h-12 w-full rounded-lg border px-2.5 text-base outline-none focus-visible:ring-3 md:text-sm"
      >
        {children}
      </select>
      <Errors id={id} errors={errors} />
    </Field>
  );
}

export function CheckField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex min-h-12 cursor-pointer items-center gap-3 text-sm">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-ember size-5 shrink-0"
      />
      {label}
    </label>
  );
}
