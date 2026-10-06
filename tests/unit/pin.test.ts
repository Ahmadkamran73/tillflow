import { describe, expect, it } from "vitest";
import { hashPin, pinSchema, verifyPin } from "@/lib/auth/pin";

describe("pinSchema", () => {
  it("accepts 4 to 6 digits", () => {
    for (const pin of ["2580", "13579", "159357", "7391"]) {
      expect(pinSchema.safeParse(pin).success, pin).toBe(true);
    }
  });

  it("refuses the wrong length or non-digits", () => {
    for (const pin of ["", "123", "1234567", "12a4", "12 45", "٣٤٥٦"]) {
      expect(pinSchema.safeParse(pin).success, pin).toBe(false);
    }
  });

  it("refuses the first things anyone tries", () => {
    for (const pin of ["0000", "1111", "999999", "1234", "4321", "0123", "123456", "654321"]) {
      expect(pinSchema.safeParse(pin).success, pin).toBe(false);
    }
  });
});

describe("hashPin / verifyPin (Argon2id)", () => {
  it("makes a PHC string with the agreed cost and a fresh salt each time", async () => {
    const a = await hashPin("2580");
    const b = await hashPin("2580");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("2580");
  });

  it("verifies the right PIN and nothing else", async () => {
    const hash = await hashPin("2580");
    expect(await verifyPin("2580", hash)).toBe(true);
    expect(await verifyPin("2581", hash)).toBe(false);
    expect(await verifyPin("258", hash)).toBe(false);
  });

  it("never throws on a bad hash or a bad PIN", async () => {
    expect(await verifyPin("2580", "")).toBe(false);
    expect(await verifyPin("2580", "$2b$10$notargon")).toBe(false);
    expect(await verifyPin("2580", "$argon2id$garbage")).toBe(false);
    expect(await verifyPin("abcd", await hashPin("2580"))).toBe(false);
  });
});
