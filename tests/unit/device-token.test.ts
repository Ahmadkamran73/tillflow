import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  generateDeviceToken,
  generatePairingCode,
  hashDeviceToken,
  hashPairingCode,
  looksLikeDeviceToken,
  normalisePairingCode,
} from "@/lib/device/token";
import { discountLimitText, parseDiscountLimit } from "@/lib/device/discount-limit";

describe("pairing codes", () => {
  it("are 8 characters from an alphabet with no look-alikes", () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(31);
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[ILO01]/);
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      expect([...code].every((c) => PAIRING_CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it("are not repeated in practice", () => {
    const seen = new Set(Array.from({ length: 500 }, generatePairingCode));
    expect(seen.size).toBe(500);
  });

  it("are read back in any case, with spaces or dashes", () => {
    expect(normalisePairingCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalisePairingCode(" ab cd  ef gh ")).toBe("ABCDEFGH");
    expect(normalisePairingCode(formatPairingCode("ABCDEFGH"))).toBe("ABCDEFGH");
    expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });

  it("refuse anything that cannot be a code", () => {
    expect(normalisePairingCode("ABCDEFG")).toBeNull(); // too short
    expect(normalisePairingCode("ABCDEFGHJ")).toBeNull(); // too long
    expect(normalisePairingCode("ABCDEFG0")).toBeNull(); // 0 is not in the alphabet
    expect(normalisePairingCode("ABCDEFGI")).toBeNull(); // nor is I
    expect(normalisePairingCode("")).toBeNull();
  });

  it("hash to a stable SHA-256 that is not the code", () => {
    const h = hashPairingCode("ABCDEFGH");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashPairingCode("ABCDEFGH"));
    expect(h).not.toBe(hashPairingCode("ABCDEFGJ"));
  });
});

describe("device tokens", () => {
  it("are 256 random bits in URL-safe text and recognised by shape", () => {
    const token = generateDeviceToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(looksLikeDeviceToken(token)).toBe(true);
    expect(generateDeviceToken()).not.toBe(token);
  });

  it("reject junk before it reaches the database", () => {
    expect(looksLikeDeviceToken(undefined)).toBe(false);
    expect(looksLikeDeviceToken("")).toBe(false);
    expect(looksLikeDeviceToken("x".repeat(42))).toBe(false);
    expect(looksLikeDeviceToken("x".repeat(43) + "'")).toBe(false);
    expect(looksLikeDeviceToken(`${"x".repeat(42)}!`)).toBe(false);
  });

  it("are stored only as a SHA-256 hash", () => {
    const token = generateDeviceToken();
    const hash = hashDeviceToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });
});

describe("discount limit text", () => {
  it("turns percent text into exact basis points", () => {
    expect(parseDiscountLimit("10")).toBe(1000);
    expect(parseDiscountLimit("7.5")).toBe(750);
    expect(parseDiscountLimit("7,25")).toBe(725);
    expect(parseDiscountLimit("0")).toBe(0);
    expect(parseDiscountLimit("100")).toBe(10_000);
    expect(parseDiscountLimit(" 12.05 ")).toBe(1205);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "abc", "-1", "100.01", "101", "1.234", "1e2", "10%", "1000"]) {
      expect(parseDiscountLimit(bad), bad).toBeNull();
    }
  });

  it("shows basis points back as the same text", () => {
    expect(discountLimitText(1000)).toBe("10");
    expect(discountLimitText(750)).toBe("7.5");
    expect(discountLimitText(725)).toBe("7.25");
    expect(discountLimitText(0)).toBe("0");
    expect(discountLimitText(10_000)).toBe("100");
    for (const bp of [0, 1, 99, 100, 505, 9999, 10_000]) {
      expect(parseDiscountLimit(discountLimitText(bp))).toBe(bp);
    }
  });
});
