import { createHash, randomBytes, randomInt } from "node:crypto";

/**
 * Device tokens and pairing codes. Only SHA-256 hashes are ever stored; the token lives in the
 * till's cookie and the code is shown once to the manager. Pure Node crypto, no database.
 */

/** 31 symbols: no I, L, O, 0 or 1, so a code read aloud or off a screen is hard to mistype. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MINUTES = 10;

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** 256 random bits, URL-safe. Unguessable, so a plain SHA-256 is enough to store it. */
export function generateDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export const hashDeviceToken = sha256Hex;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** A cheap shape check so garbage cookies never reach the database. */
export const looksLikeDeviceToken = (value: string | undefined): value is string =>
  typeof value === "string" && TOKEN_SHAPE.test(value);

export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

/** What a person types: any case, with spaces or dashes. Returns null if it cannot be a code. */
export function normalisePairingCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of code) if (!PAIRING_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export const hashPairingCode = (normalisedCode: string): string => sha256Hex(normalisedCode);

/** Shown as XXXX-XXXX. */
export const formatPairingCode = (code: string): string =>
  `${code.slice(0, PAIRING_CODE_LENGTH / 2)}-${code.slice(PAIRING_CODE_LENGTH / 2)}`;
