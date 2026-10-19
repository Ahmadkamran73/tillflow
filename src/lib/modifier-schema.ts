import { z } from "zod";
import { t, type MessageKey } from "@/lib/i18n";
import { parseCents } from "@/lib/money";
import type { FieldErrors } from "./catalog-schema";

export type RawModifierGroup = {
  groupId: string;
  name: string;
  min: string;
  max: string;
  options: { id: string; name: string; price: string }[];
};

export type ModifierGroupData = {
  group: { id: string; name: string; min_choices: number; max_choices: number };
  options: { id: string; name: string; price_delta_cents: number }[];
};

export const rawModifierGroupSchema = z.object({
  groupId: z.uuid(),
  name: z.string().max(500),
  min: z.string().max(10),
  max: z.string().max(10),
  options: z
    .array(z.object({ id: z.uuid(), name: z.string().max(500), price: z.string().max(40) }))
    .max(200),
});

export function parseModifierGroupForm(
  input: unknown,
): { ok: true; data: ModifierGroupData } | { ok: false; fieldErrors: FieldErrors } {
  const shape = rawModifierGroupSchema.safeParse(input);
  if (!shape.success) return { ok: false, fieldErrors: { form: [t("catalog.errors.fix")] } };
  const raw = shape.data;
  const errors: FieldErrors = {};
  const fail = (key: string, message: MessageKey) => {
    (errors[key] ??= []).push(t(message));
  };

  const name = raw.name.trim();
  if (name.length < 1 || name.length > 60) fail("name", "modifiers.err.name");
  const whole = (s: string) => (/^\d{1,2}$/.test(s.trim()) ? Number(s) : null);
  const min = whole(raw.min);
  const max = whole(raw.max);
  if (min === null || min > 20) fail("min", "modifiers.err.min");
  if (max === null || max > 20 || (min !== null && max < min)) fail("max", "modifiers.err.max");
  if (raw.options.length < 1 || raw.options.length > 50) fail("options", "modifiers.err.options");

  const names = new Map<string, number>();
  const options = raw.options.map((o, i) => {
    const optionName = o.name.trim();
    if (optionName.length < 1 || optionName.length > 60) {
      fail(`options.${i}.name`, "modifiers.err.optionName");
    } else if (names.has(optionName.toLowerCase())) {
      fail(`options.${i}.name`, "modifiers.err.optionDup");
    }
    names.set(optionName.toLowerCase(), i);
    const price = o.price.trim() === "" ? 0 : parseCents(o.price, { allowNegative: true });
    if (price === null || Math.abs(price) > 100_000)
      fail(`options.${i}.price`, "modifiers.err.optionPrice");
    return { id: o.id, name: optionName, price_delta_cents: price ?? 0 };
  });

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    data: {
      group: { id: raw.groupId, name, min_choices: min!, max_choices: max! },
      options,
    },
  };
}
