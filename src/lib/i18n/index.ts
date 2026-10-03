import { enIE, type MessageKey } from "./en-IE";

export type { MessageKey };
export type Locale = "en-IE" | "ga-IE";

/** Missing keys fall back to en-IE, so a partial ga-IE file is fine. */
const catalogues: Record<Locale, Partial<Record<MessageKey, string>>> = {
  "en-IE": enIE,
  "ga-IE": {},
};

// ponytail: one fixed locale. When ga-IE lands, read it from the user's setting and pass it in here.
const locale: Locale = "en-IE";

/** `t("register.pay", { amount: "€12.60" })`. `{name}` placeholders are replaced; no plural rules yet. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = catalogues[locale][key] ?? enIE[key];
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => String(vars[k] ?? m)) : text;
}
