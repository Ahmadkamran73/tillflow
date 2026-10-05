"use client";

import { z } from "zod";
import { useActionState, useEffect, useRef, useState } from "react";
import { BusinessTypeCards } from "@/components/back-office/business-type-cards";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { BusinessType } from "@/config/business-type-presets";
import type { FormState } from "@/lib/auth/schemas";
import { t } from "@/lib/i18n";
import { onboardingInput } from "@/lib/onboarding";
import { completeOnboardingAction } from "@/lib/org-actions";

type Values = {
  businessName: string;
  vatNumber: string;
  businessType: BusinessType | "";
  tills: string;
  products: "import" | "empty";
};
type Errors = Partial<Record<keyof Values, string[]>>;

const steps = [
  ["businessName", "vatNumber"],
  ["businessType"],
  ["tills"],
  ["products"],
] as const satisfies readonly (readonly (keyof Values)[])[];
const titles = [
  "onboarding.business",
  "onboarding.type",
  "onboarding.tills",
  "onboarding.products",
] as const;

function stepErrors(step: number, values: Values): Errors {
  const shape = Object.fromEntries(steps[step]!.map((k) => [k, true])) as Record<
    keyof Values,
    true
  >;
  const parsed = onboardingInput.pick(shape).safeParse(values);
  return parsed.success ? {} : (z.flattenError(parsed.error).fieldErrors as Errors);
}

/** Four steps in one form: every step's inputs stay mounted (hidden), so the last submit posts all. */
export function OnboardingWizard({ orgId, defaultName }: { orgId: string; defaultName: string }) {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Values>({
    businessName: defaultName,
    vatNumber: "",
    businessType: "",
    tills: "1",
    products: "empty",
  });
  const [errors, setErrors] = useState<Errors>({});
  const [state, formAction, pending] = useActionState(
    async (prev: FormState, formData: FormData) => {
      const result = await completeOnboardingAction(prev, formData);
      // A server-side field error sends the owner back to the step that has it.
      if (result.fieldErrors) {
        const fe = result.fieldErrors as Errors;
        setErrors(fe);
        const back = steps.findIndex((keys) => keys.some((k) => fe[k]));
        if (back >= 0) go(back);
      }
      return result;
    },
    {} as FormState,
  );
  const headings = useRef<(HTMLHeadingElement | null)[]>([]);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const moved = useRef(false);

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state]);

  // Focus the new step's heading so screen readers announce where they are.
  useEffect(() => {
    if (moved.current) headings.current[step]?.focus();
  }, [step]);

  function go(next: number) {
    moved.current = true;
    setStep(next);
  }

  function nextStep() {
    const found = stepErrors(step, values);
    setErrors(found);
    if (Object.keys(found).length === 0) return go(step + 1);
    // Send keyboard users to the first field that needs fixing.
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          "section:not([hidden]) [aria-invalid=true], section:not([hidden]) input",
        )
        ?.focus(),
    );
  }

  const err = (k: keyof Values) =>
    errors[k] ? (
      <FieldError id={`${k}-error`} errors={errors[k].map((message) => ({ message }))} />
    ) : null;
  const described = (k: keyof Values, hint?: boolean) =>
    [hint ? `${k}-hint` : "", errors[k] ? `${k}-error` : ""].filter(Boolean).join(" ") || undefined;
  const last = step === steps.length - 1;

  return (
    <form
      action={formAction}
      noValidate
      aria-busy={pending}
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        // Enter on an earlier step moves on instead of posting a half-filled form.
        if (!last || pending) {
          e.preventDefault();
          if (!last) nextStep();
        }
      }}
    >
      <input type="hidden" name="orgId" value={orgId} />

      {state.error ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      {steps.map((_, i) => (
        <section
          key={i}
          hidden={i !== step}
          aria-labelledby={`step-${i}`}
          className="flex flex-col gap-4"
        >
          <h2
            id={`step-${i}`}
            ref={(el) => {
              headings.current[i] = el;
            }}
            tabIndex={-1}
            className="text-title font-semibold tracking-tight outline-none"
          >
            <span className="text-muted-foreground block font-mono text-xs font-normal tracking-wide">
              {t("onboarding.step", { n: i + 1, total: steps.length })}
            </span>
            {t(titles[i]!)}
          </h2>

          {i === 0 ? (
            <>
              <Field>
                <FieldLabel htmlFor="businessName">{t("onboarding.name")}</FieldLabel>
                <Input
                  id="businessName"
                  name="businessName"
                  autoComplete="organization"
                  maxLength={120}
                  className="h-12"
                  value={values.businessName}
                  onChange={(e) => set("businessName", e.target.value)}
                  aria-invalid={errors.businessName ? true : undefined}
                  aria-describedby={described("businessName")}
                />
                {err("businessName")}
              </Field>
              <Field>
                <FieldLabel htmlFor="vatNumber">{t("onboarding.vat")}</FieldLabel>
                <Input
                  id="vatNumber"
                  name="vatNumber"
                  autoCapitalize="characters"
                  maxLength={30}
                  className="h-12 font-mono"
                  value={values.vatNumber}
                  onChange={(e) => set("vatNumber", e.target.value)}
                  aria-invalid={errors.vatNumber ? true : undefined}
                  aria-describedby={described("vatNumber", true)}
                />
                <p id="vatNumber-hint" className="text-muted-foreground text-sm">
                  {t("onboarding.vatHint")}
                </p>
                {err("vatNumber")}
              </Field>
            </>
          ) : null}

          {i === 1 ? (
            <fieldset className="flex flex-col gap-3" aria-labelledby={`step-${i}`}>
              <p id="businessType-hint" className="text-muted-foreground text-sm">
                {t("onboarding.typeHint")}
              </p>
              <BusinessTypeCards
                value={values.businessType}
                onValueChange={(type) => set("businessType", type)}
                describedBy={described("businessType", true)}
              />
              {err("businessType")}
            </fieldset>
          ) : null}

          {i === 2 ? (
            <Field>
              <FieldLabel htmlFor="tills">{t("onboarding.tillsLabel")}</FieldLabel>
              <Input
                id="tills"
                name="tills"
                type="number"
                inputMode="numeric"
                min={1}
                max={20}
                className="h-12 w-32 tabular-nums"
                value={values.tills}
                onChange={(e) => set("tills", e.target.value)}
                aria-invalid={errors.tills ? true : undefined}
                aria-describedby={described("tills", true)}
              />
              <p id="tills-hint" className="text-muted-foreground text-sm">
                {t("onboarding.tillsHint")}
              </p>
              {err("tills")}
            </Field>
          ) : null}

          {i === 3 ? (
            <fieldset className="grid gap-3 sm:grid-cols-2" aria-labelledby={`step-${i}`}>
              {(["import", "empty"] as const).map((choice) => (
                <label
                  key={choice}
                  className="surface-panel border-input has-[:checked]:border-ember has-[:focus-visible]:outline-ring flex min-h-24 cursor-pointer flex-col gap-1 border-2 p-4 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2"
                >
                  <span className="flex items-center gap-3 font-semibold">
                    <input
                      type="radio"
                      name="products"
                      value={choice}
                      className="accent-ember size-5"
                      checked={values.products === choice}
                      onChange={() => set("products", choice)}
                      aria-describedby={`products-${choice}-hint`}
                    />
                    {t(choice === "import" ? "onboarding.import" : "onboarding.empty")}
                  </span>
                  <span id={`products-${choice}-hint`} className="text-muted-foreground text-sm">
                    {t(choice === "import" ? "onboarding.importHint" : "onboarding.emptyHint")}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
        </section>
      ))}

      <div className="flex gap-3">
        {step > 0 ? (
          <Button
            type="button"
            variant="outline"
            className="h-12 px-5"
            onClick={() => go(step - 1)}
          >
            {t("onboarding.back")}
          </Button>
        ) : null}
        {/* Distinct keys: reusing one <button> would flip Next to submit mid-click and post the form. */}
        {last ? (
          <Button key="finish" type="submit" className="h-12 px-5" aria-disabled={pending}>
            {pending ? t("onboarding.wait") : t("onboarding.finish")}
          </Button>
        ) : (
          <Button key="next" type="button" className="h-12 px-5" onClick={nextStep}>
            {t("onboarding.next")}
          </Button>
        )}
      </div>
    </form>
  );
}
