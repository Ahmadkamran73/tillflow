"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { CheckField, SelectField, TextField } from "@/components/back-office/form-bits";
import { rateLabel, rateToday, VatPreview } from "@/components/back-office/vat-preview";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { allergens, presets, type BusinessType } from "@/config/business-type-presets";
import type { FormState } from "@/lib/auth/schemas";
import { saveProductAction } from "@/lib/catalog-actions";
import {
  COURSES,
  emptyVariant,
  parseProductForm,
  showsTakeaway,
  type RawProduct,
  type RawVariant,
} from "@/lib/catalog-schema";
import { t } from "@/lib/i18n";
import { TAX_CATEGORIES, type RateRow } from "@/lib/money";

type Props = {
  orgId: string;
  businessType: BusinessType;
  initial: RawProduct;
  isNew: boolean;
  categories: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  rates: RateRow[];
  timeZone: string;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Every size x colour pair is one variant; rows that already exist keep their values. */
function rebuild(sizes: string[], colours: string[], prev: RawVariant[]): RawVariant[] {
  return sizes.flatMap((size) =>
    colours.map(
      (colour) =>
        prev.find((v) => same(v.size, size) && same(v.colour, colour)) ?? {
          ...emptyVariant(uuidv7()),
          size,
          colour,
          price: prev[0]?.price ?? "",
        },
    ),
  );
}

const unique = (values: string[]) =>
  values.filter((v, i) => values.findIndex((w) => same(v, w)) === i);

function Chips({
  id,
  label,
  hint,
  addLabel,
  values,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  addLabel: string;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim().slice(0, 60);
    if (v && !values.some((x) => same(x, v))) onChange([...values, v]);
    setDraft("");
  };
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <input
          id={id}
          value={draft}
          maxLength={60}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-12 min-w-0 flex-1 rounded-lg border px-2.5 text-base outline-none focus-visible:ring-3 md:text-sm"
        />
        <Button type="button" variant="outline" className="h-12 px-4" onClick={add}>
          {addLabel}
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-muted-foreground text-sm">
        {hint}
      </p>
      <ul className="flex flex-wrap gap-2">
        {values.map((v) => (
          <li
            key={v}
            className="border-border bg-card flex items-center gap-1 rounded-full border py-1 pr-1 pl-3 text-sm"
          >
            {v}
            <button
              type="button"
              aria-label={t("catalog.remove", { name: v })}
              onClick={() => {
                onChange(values.filter((x) => x !== v));
                document.getElementById(id)?.focus();
              }}
              className="hover:bg-muted flex size-8 items-center justify-center rounded-full"
            >
              <span aria-hidden>×</span>
            </button>
          </li>
        ))}
      </ul>
    </Field>
  );
}

export function ProductForm({
  orgId,
  businessType,
  initial,
  isNew,
  categories,
  groups,
  rates,
  timeZone,
}: Props) {
  const fields = new Set<string>(presets[businessType].productFields);
  const matrix = fields.has("variantMatrix");
  const [raw, setRaw] = useState<RawProduct>(initial);
  const [sizes, setSizes] = useState(() => unique(initial.variants.map((v) => v.size)));
  const [colours, setColours] = useState(() => unique(initial.variants.map((v) => v.colour)));

  const [state, formAction, pending] = useActionState(
    async (prev: FormState, formData: FormData): Promise<FormState> => {
      const checked = parseProductForm(businessType, raw, { isNew });
      if (!checked.ok) return { fieldErrors: checked.fieldErrors };
      return saveProductAction(prev, formData);
    },
    {} as FormState,
  );
  const errors = state.fieldErrors ?? {};
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Send the keyboard to the first problem after a failed save.
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
    else if (state.fieldErrors) {
      document.querySelector<HTMLElement>("form [aria-invalid=true]")?.focus();
    }
  }, [state]);

  const set = <K extends keyof RawProduct>(key: K, value: RawProduct[K]) =>
    setRaw((r) => ({ ...r, [key]: value }));
  const setVariant = (i: number, patch: Partial<RawVariant>) =>
    setRaw((r) => ({
      ...r,
      variants: r.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)),
    }));
  const changeMatrix = (nextSizes: string[], nextColours: string[]) => {
    setSizes(nextSizes);
    setColours(nextColours);
    setRaw((r) => ({ ...r, variants: rebuild(nextSizes, nextColours, r.variants) }));
  };

  const taxLabel = (code: string) => {
    const bp = rateToday(rates, code, timeZone);
    return `${t(`tax.${code}` as "tax.STANDARD")}${bp === null ? "" : ` (${rateLabel(bp)})`}`;
  };
  const takeawayShown = showsTakeaway(businessType, raw.taxCategory);
  const stockShown = isNew && raw.trackStock;
  const single = raw.variants[0];
  // Warning only (the manager decides): age-restricted goods and Drinks/Tobacco categories are 23%.
  const categoryName = categories.find((c) => c.id === raw.categoryId)?.name ?? "";
  const rateWarning =
    raw.taxCategory !== "STANDARD" &&
    (raw.ageRestricted || ["drinks", "tobacco"].includes(categoryName.trim().toLowerCase()));

  return (
    <form
      action={formAction}
      noValidate
      aria-busy={pending}
      className="flex max-w-4xl flex-col gap-8"
    >
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="payload" value={JSON.stringify(raw)} />

      {state.error || errors.form ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-destructive text-sm">
          {state.error ?? errors.form?.[0]}
        </p>
      ) : null}

      <section aria-labelledby="sec-basics" className="surface-panel flex flex-col gap-4 p-5">
        <h2 id="sec-basics" className="text-heading font-semibold">
          {t("catalog.section.basics")}
        </h2>
        <TextField
          id="name"
          label={t("catalog.field.name")}
          value={raw.name}
          onChange={(v) => set("name", v)}
          errors={errors.name}
          maxLength={120}
          autoComplete="off"
        />
        <SelectField
          id="categoryId"
          label={t("catalog.field.category")}
          value={raw.categoryId}
          onChange={(v) => set("categoryId", v)}
          errors={errors.categoryId}
        >
          <option value="">{t("catalog.noCategory")}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
      </section>

      <section aria-labelledby="sec-price" className="surface-panel flex flex-col gap-4 p-5">
        <h2 id="sec-price" className="text-heading font-semibold">
          {t("catalog.section.price")}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="taxCategory"
            label={t("catalog.field.taxCategory")}
            value={raw.taxCategory}
            onChange={(v) => set("taxCategory", v)}
            errors={errors.taxCategory}
          >
            {TAX_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {taxLabel(c)}
              </option>
            ))}
          </SelectField>
          {takeawayShown ? (
            <SelectField
              id="takeawayTaxCategory"
              label={t("catalog.field.takeawayTaxCategory")}
              value={raw.takeawayTaxCategory}
              onChange={(v) => set("takeawayTaxCategory", v)}
              errors={errors.takeawayTaxCategory}
            >
              <option value="">{t("catalog.field.sameAsEatIn")}</option>
              {TAX_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {taxLabel(c)}
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>

        {rateWarning ? (
          <p role="note" className="rounded-lg border p-3 text-sm">
            {t("catalog.warn.drinkRate")}
          </p>
        ) : null}

        {!matrix && single ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <TextField
                id="v-0-price"
                label={t("catalog.field.price")}
                value={single.price}
                onChange={(v) => setVariant(0, { price: v })}
                errors={errors["variants.0.price"]}
                inputMode="decimal"
                autoComplete="off"
                inputClassName="font-mono tabular-nums"
              />
              <VatPreview
                id="v-0-vat"
                price={single.price}
                category={raw.taxCategory}
                takeawayCategory={takeawayShown ? raw.takeawayTaxCategory : undefined}
                rates={rates}
                timeZone={timeZone}
              />
            </div>
            <TextField
              id="v-0-cost"
              label={t("catalog.field.cost")}
              value={single.cost}
              onChange={(v) => setVariant(0, { cost: v })}
              errors={errors["variants.0.cost"]}
              inputMode="decimal"
              autoComplete="off"
              inputClassName="font-mono tabular-nums"
            />
          </div>
        ) : null}

        <CheckField
          id="trackStock"
          label={t("catalog.field.trackStock")}
          checked={raw.trackStock}
          onChange={(v) => set("trackStock", v)}
        />
        {!matrix && single && stockShown ? (
          <TextField
            id="v-0-openingStock"
            label={t("catalog.field.openingStock")}
            value={single.openingStock}
            onChange={(v) => setVariant(0, { openingStock: v })}
            errors={errors["variants.0.openingStock"]}
            inputMode="numeric"
            autoComplete="off"
            className="sm:max-w-xs"
          />
        ) : null}
      </section>

      <section aria-labelledby="sec-details" className="surface-panel flex flex-col gap-4 p-5">
        <h2 id="sec-details" className="text-heading font-semibold">
          {t("catalog.section.details")}
        </h2>
        {!matrix && single && fields.has("barcode") ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id="v-0-barcode"
              label={t("catalog.field.barcode")}
              value={single.barcode}
              onChange={(v) => setVariant(0, { barcode: v })}
              errors={errors["variants.0.barcode"]}
              maxLength={32}
              autoComplete="off"
              inputClassName="font-mono"
            />
            <TextField
              id="v-0-sku"
              label={t("catalog.field.sku")}
              value={single.sku}
              onChange={(v) => setVariant(0, { sku: v })}
              errors={errors["variants.0.sku"]}
              maxLength={40}
              autoComplete="off"
              inputClassName="font-mono"
            />
          </div>
        ) : null}

        {businessType === "general" ? (
          <>
            <CheckField
              id="ageRestricted"
              label={t("catalog.field.ageRestricted")}
              checked={raw.ageRestricted}
              onChange={(v) => set("ageRestricted", v)}
            />
            <TextField
              id="deposit"
              label={t("catalog.field.deposit")}
              value={raw.deposit}
              onChange={(v) => set("deposit", v)}
              errors={errors.deposit}
              inputMode="decimal"
              autoComplete="off"
              className="sm:max-w-xs"
              inputClassName="font-mono tabular-nums"
            />
          </>
        ) : null}

        {businessType === "electronics" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id="brand"
                label={t("catalog.field.brand")}
                value={raw.brand}
                onChange={(v) => set("brand", v)}
                errors={errors.brand}
                maxLength={60}
              />
              <TextField
                id="model"
                label={t("catalog.field.model")}
                value={raw.model}
                onChange={(v) => set("model", v)}
                errors={errors.model}
                maxLength={60}
              />
              <TextField
                id="warrantyMonths"
                label={t("catalog.field.warrantyMonths")}
                value={raw.warrantyMonths}
                onChange={(v) => set("warrantyMonths", v)}
                errors={errors.warrantyMonths}
                inputMode="numeric"
              />
            </div>
            <CheckField
              id="serialRequired"
              label={t("catalog.field.serialRequired")}
              checked={raw.serialRequired}
              onChange={(v) => set("serialRequired", v)}
            />
          </>
        ) : null}

        {businessType === "clothing" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id="season"
              label={t("catalog.field.season")}
              value={raw.season}
              onChange={(v) => set("season", v)}
              errors={errors.season}
              maxLength={60}
            />
            <TextField
              id="styleCode"
              label={t("catalog.field.styleCode")}
              value={raw.styleCode}
              onChange={(v) => set("styleCode", v)}
              errors={errors.styleCode}
              maxLength={60}
              inputClassName="font-mono"
            />
          </div>
        ) : null}

        {fields.has("courses") ? (
          <SelectField
            id="course"
            label={t("catalog.field.course")}
            value={raw.course}
            onChange={(v) => set("course", v)}
            errors={errors.course}
            className="sm:max-w-xs"
          >
            <option value="" />
            {COURSES.map((c) => (
              <option key={c} value={c}>
                {t(`course.${c}`)}
              </option>
            ))}
          </SelectField>
        ) : null}
      </section>

      {matrix ? (
        <section aria-labelledby="sec-variants" className="surface-panel flex flex-col gap-4 p-5">
          <h2 id="sec-variants" className="text-heading font-semibold">
            {t("catalog.section.variants")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Chips
              id="sizes"
              label={t("catalog.field.sizes")}
              hint={t("catalog.field.sizesHelp")}
              addLabel={t("catalog.addSize")}
              values={sizes}
              onChange={(v) => changeMatrix(v, colours)}
            />
            <Chips
              id="colours"
              label={t("catalog.field.colours")}
              hint={t("catalog.field.coloursHelp")}
              addLabel={t("catalog.addColour")}
              values={colours}
              onChange={(v) => changeMatrix(sizes, v)}
            />
          </div>
          {errors.variants ? (
            <FieldError errors={errors.variants.map((message) => ({ message }))} />
          ) : null}
          {raw.variants.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("catalog.matrixEmpty")}</p>
          ) : (
            <div
              role="region"
              tabIndex={0}
              aria-label={t("catalog.matrixCaption")}
              className="overflow-x-auto"
            >
              <table className="w-full min-w-[56rem] text-sm">
                <caption className="sr-only">{t("catalog.matrixCaption")}</caption>
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t("catalog.variant")}
                    </th>
                    <th scope="col" className="px-1.5 py-2 font-medium">
                      {t("catalog.field.price")}
                    </th>
                    <th scope="col" className="px-1.5 py-2 font-medium">
                      {t("catalog.field.cost")}
                    </th>
                    <th scope="col" className="px-1.5 py-2 font-medium">
                      {t("catalog.field.sku")}
                    </th>
                    <th scope="col" className="px-1.5 py-2 font-medium">
                      {t("catalog.field.barcode")}
                    </th>
                    {stockShown ? (
                      <th scope="col" className="px-1.5 py-2 font-medium">
                        {t("catalog.field.openingStock")}
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {raw.variants.map((v, i) => {
                    const cell = (
                      field: "price" | "cost" | "sku" | "barcode" | "openingStock",
                      mode: "decimal" | "numeric" | "text",
                    ) => (
                      <td className="px-1.5 py-1.5 align-top">
                        <input
                          id={`v-${i}-${field}`}
                          aria-label={`${t(`catalog.field.${field}`)}, ${v.size} / ${v.colour}`}
                          value={v[field]}
                          inputMode={mode}
                          autoComplete="off"
                          onChange={(e) => setVariant(i, { [field]: e.target.value })}
                          aria-invalid={errors[`variants.${i}.${field}`] ? true : undefined}
                          aria-describedby={
                            errors[`variants.${i}.${field}`] ? `v-${i}-${field}-error` : undefined
                          }
                          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive h-12 w-full min-w-24 rounded-lg border px-2 font-mono outline-none focus-visible:ring-3"
                        />
                        {errors[`variants.${i}.${field}`] ? (
                          <p id={`v-${i}-${field}-error`} className="text-destructive text-xs">
                            {errors[`variants.${i}.${field}`]![0]}
                          </p>
                        ) : null}
                        {field === "price" ? (
                          <VatPreview
                            id={`v-${i}-vat`}
                            price={v.price}
                            category={raw.taxCategory}
                            rates={rates}
                            timeZone={timeZone}
                          />
                        ) : null}
                      </td>
                    );
                    return (
                      <tr key={v.id} className="border-border border-t">
                        <th scope="row" className="py-1.5 pr-3 text-left align-top font-medium">
                          <span className="flex min-h-11 items-center">
                            {v.size} / {v.colour}
                          </span>
                          {errors[`variants.${i}.size`] ? (
                            <span
                              role="alert"
                              className="text-destructive block text-xs font-normal"
                            >
                              {errors[`variants.${i}.size`]![0]}
                            </span>
                          ) : null}
                        </th>
                        {cell("price", "decimal")}
                        {cell("cost", "decimal")}
                        {cell("sku", "text")}
                        {cell("barcode", "text")}
                        {stockShown ? cell("openingStock", "numeric") : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {fields.has("allergens") ? (
        <section className="surface-panel p-5">
          <fieldset aria-describedby="allergen-help" className="flex flex-col gap-3">
            <legend className="text-heading mb-1 font-semibold">
              {t("catalog.section.allergens")}
            </legend>
            <p id="allergen-help" className="text-muted-foreground text-sm">
              {t("allergen.help")}
            </p>
            {errors.allergens ? (
              <FieldError errors={errors.allergens.map((message) => ({ message }))} />
            ) : null}
            <div className="grid gap-x-4 sm:grid-cols-2">
              {allergens.map((a) => (
                <CheckField
                  key={a}
                  id={`allergen-${a}`}
                  label={t(`allergen.${a}`)}
                  checked={raw.allergens.includes(a)}
                  onChange={(on) =>
                    set(
                      "allergens",
                      on ? [...raw.allergens, a] : raw.allergens.filter((x) => x !== a),
                    )
                  }
                />
              ))}
            </div>
          </fieldset>
        </section>
      ) : null}

      {fields.has("modifiers") ? (
        <section className="surface-panel p-5">
          <fieldset className="flex flex-col gap-3">
            <legend className="text-heading mb-1 font-semibold">
              {t("catalog.section.modifiers")}
            </legend>
            {errors.modifierGroupIds ? (
              <FieldError errors={errors.modifierGroupIds.map((message) => ({ message }))} />
            ) : null}
            {groups.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("modifiers.none")}</p>
            ) : (
              <div className="grid gap-x-4 sm:grid-cols-2">
                {groups.map((g) => (
                  <CheckField
                    key={g.id}
                    id={`group-${g.id}`}
                    label={g.name}
                    checked={raw.modifierGroupIds.includes(g.id)}
                    onChange={(on) =>
                      set(
                        "modifierGroupIds",
                        on
                          ? [...raw.modifierGroupIds, g.id]
                          : raw.modifierGroupIds.filter((x) => x !== g.id),
                      )
                    }
                  />
                ))}
              </div>
            )}
            <Link
              href={`/o/${orgId}/products/modifiers`}
              className="min-h-11 w-fit py-2 text-sm underline underline-offset-4"
            >
              {t("modifiers.manage")}
            </Link>
          </fieldset>
        </section>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} className="h-12 px-6">
          {pending ? t("catalog.saving") : t("catalog.save")}
        </Button>
        <Link
          href={`/o/${orgId}/products`}
          className="min-h-12 px-3 py-3 text-sm underline underline-offset-4"
        >
          {t("onboarding.back")}
        </Link>
      </div>
    </form>
  );
}
