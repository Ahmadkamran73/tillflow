import { argon2Verify, argon2id } from "hash-wasm";
import { z } from "zod";

/**
 * Cashier PINs: 4 to 6 digits, hashed with Argon2id (OWASP minimum: 19 MiB, 2 passes, 1 lane) as a
 * PHC string. hash-wasm is WebAssembly, so the same code runs on the server (setting a PIN,
 * checking one while online) and on the till (checking a cached hash while offline). The plain PIN
 * never leaves the process that typed it except in the single request that checks it.
 */
const MEMORY_KIB = 19_456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

const isRun = (pin: string, step: 1 | -1) =>
  [...pin].every((ch, i) => i === 0 || Number(ch) - Number(pin[i - 1]) === step);

/** 4 to 6 digits, and not the first thing anyone tries: all one digit, or a straight run. */
export const pinSchema = z
  .string()
  .regex(/^\d{4,6}$/, "Use 4 to 6 digits.")
  .refine((pin) => !/^(\d)\1+$/.test(pin) && !isRun(pin, 1) && !isRun(pin, -1), {
    message: "Choose a PIN that is not all one digit or a simple run like 1234.",
  });

export async function hashPin(pin: string): Promise<string> {
  return argon2id({
    password: pin,
    salt: crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_KIB,
    hashLength: HASH_BYTES,
    outputType: "encoded",
  });
}

/** False for a wrong PIN and for a hash that is not Argon2 at all; never throws on bad input. */
export async function verifyPin(pin: string, encodedHash: string): Promise<boolean> {
  if (!/^\d{4,6}$/.test(pin) || !encodedHash.startsWith("$argon2id$")) return false;
  try {
    return await argon2Verify({ password: pin, hash: encodedHash });
  } catch {
    return false;
  }
}
