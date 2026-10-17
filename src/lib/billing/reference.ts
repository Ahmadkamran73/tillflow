/**
 * Payment references: `TF-7K3Q-0925-X`. A bank transfer is matched by this text, so it must be
 * short, typeable and self-checking.
 *
 * - `7K3Q` four random characters from an alphabet without 0, 1, I, L, O (no look-alikes).
 * - `0925` the invoice month and year (shop-local), so a reference also dates the invoice.
 * - `X` a check character over the eight characters before it: a weighted sum modulo 33 whose
 *   weights are all coprime to 33 and whose neighbouring differences are too, so any single
 *   mistyped character and any swap of two neighbours changes the check.
 *
 * Case and the separators are ignored when a reference is read (`tf 7k3q 0925 x` is fine).
 * The SQL twin is `app.billing_reference_check`; `tests/rls/billing.test.ts` proves they agree.
 */
const SYMBOLS = "0123456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 33 symbols (no I, L, O)
const RANDOM_ALPHABET = SYMBOLS.slice(2); // 31 symbols (also no 0 or 1)
const WEIGHTS = [1, 2, 4, 5, 7, 8, 10, 14] as const;
const PREFIX = "TF-";

/** The check character for the 8 payload characters (4 random + MMYY). */
export function referenceCheckChar(payload: string): string {
  if (payload.length !== WEIGHTS.length) throw new RangeError("payload must be 8 characters");
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    const v = SYMBOLS.indexOf(payload[i]!);
    if (v < 0) throw new RangeError("payload has a character outside the reference alphabet");
    sum += v * WEIGHTS[i]!;
  }
  return SYMBOLS[sum % SYMBOLS.length]!;
}

/** Month and year of an invoice as `MMYY`. */
export function monthYear(month1to12: number, year: number): string {
  if (!Number.isInteger(month1to12) || month1to12 < 1 || month1to12 > 12) {
    throw new RangeError("month must be 1..12");
  }
  return `${String(month1to12).padStart(2, "0")}${String(year % 100).padStart(2, "0")}`;
}

/** Builds a reference. `random` lets tests fix the four characters (default: crypto). */
export function makeReference(mmyy: string, random?: string): string {
  if (!/^\d{4}$/.test(mmyy)) throw new RangeError("mmyy must be four digits");
  let part = random;
  if (part === undefined) {
    // Rejection sampling so every symbol is equally likely (248 = 8 * 31).
    const bytes = new Uint8Array(8);
    part = "";
    while (part.length < 4) {
      crypto.getRandomValues(bytes);
      for (const b of bytes) if (b < 248 && part.length < 4) part += RANDOM_ALPHABET[b % 31];
    }
  }
  if (!/^[2-9A-HJKMNP-Z]{4}$/.test(part)) throw new RangeError("random part must be 4 symbols");
  return `${PREFIX}${part}-${mmyy}-${referenceCheckChar(part + mmyy)}`;
}

/** Normalises what a person typed or a bank printed; null if it cannot be a reference. */
export function normaliseReference(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s_-]+/g, "");
  const m = /^TF([0-9A-Z]{4})(\d{4})([0-9A-Z])$/.exec(s);
  if (!m) return null;
  return `${PREFIX}${m[1]}-${m[2]}-${m[3]}`;
}

export type ReferenceCheck =
  { ok: true; reference: string } | { ok: false; reason: "format" | "check" };

/** Reads a typed reference: its shape, then its check character. */
export function checkReference(raw: string): ReferenceCheck {
  const ref = normaliseReference(raw);
  if (!ref) return { ok: false, reason: "format" };
  const compact = ref.replace(/-/g, "").slice(2);
  const payload = compact.slice(0, 8);
  if (![...compact].every((c) => SYMBOLS.includes(c))) return { ok: false, reason: "format" };
  return referenceCheckChar(payload) === compact[8]
    ? { ok: true, reference: ref }
    : { ok: false, reason: "check" };
}

/** Finds every reference-shaped token in free text (a bank statement line). */
export function findReferences(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.toUpperCase().matchAll(/TF[\s-]?[0-9A-Z]{4}[\s-]?\d{4}[\s-]?[0-9A-Z]/g)) {
    const r = normaliseReference(m[0]);
    if (r) found.add(r);
  }
  return [...found];
}
