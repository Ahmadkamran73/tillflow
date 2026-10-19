import { z } from "zod";
import { businessTypes } from "@/config/business-type-presets";
import { businessName } from "@/lib/auth/schemas";

const CHECK = "WABCDEFGHIJKLMNOPQRSTUV"; // index = remainder mod 23

/** Revenue's mod-23 check: 7 digits, check letter, optional second letter (A-I, or W = 0). */
function validNewFormat(v: string) {
  const m = /^(\d{7})([A-W])([A-IW])?$/.exec(v);
  if (!m) return false;
  let sum = [...m[1]!].reduce((s, d, i) => s + Number(d) * (8 - i), 0);
  if (m[3]) sum += CHECK.indexOf(m[3]) * 9;
  return CHECK[sum % 23] === m[2];
}

/**
 * Irish VAT number, stored as "IE" + digits/letters. Accepts spaces, lower case and a missing
 * "IE" prefix. Old format 1A23456B is checked by rewriting it as 0234561B.
 */
export const irishVatNumber = z
  .string()
  .transform((v) =>
    v
      .replace(/[\s.-]/g, "")
      .toUpperCase()
      .replace(/^IE/, ""),
  )
  .refine((v) => {
    const old = /^(\d)[A-Z+*](\d{5})([A-W])$/.exec(v);
    return validNewFormat(old ? `0${old[2]}${old[1]}${old[3]}` : v);
  }, "Enter a valid Irish VAT number, e.g. IE1234567T.")
  .transform((v) => `IE${v}`);

const optionalVat = z
  .string()
  .trim()
  .max(30)
  .transform((v) => (v === "" ? null : v))
  .pipe(irishVatNumber.nullable());

export const onboardingInput = z.object({
  businessName,
  vatNumber: optionalVat,
  businessType: z.enum(businessTypes, "Choose a business type."),
  tills: z.coerce.number().int().min(1, "At least 1 till.").max(20, "At most 20 tills."),
  products: z.enum(["import", "empty"]),
});

export const businessTypeInput = z.object({ businessType: z.enum(businessTypes) });
