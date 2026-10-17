import { describe, expect, it } from "vitest";
import {
  checkReference,
  findReferences,
  makeReference,
  monthYear,
  normaliseReference,
  referenceCheckChar,
} from "@/lib/billing/reference";

const SYMBOLS = "0123456789ABCDEFGHJKMNPQRSTUVWXYZ";

describe("payment reference", () => {
  it("has the documented shape and verifies", () => {
    const ref = makeReference("0925", "7K3Q");
    expect(ref).toMatch(/^TF-7K3Q-0925-[0-9A-Z]$/);
    expect(checkReference(ref)).toEqual({ ok: true, reference: ref });
  });

  it("never uses look-alike characters in the random part", () => {
    for (let i = 0; i < 500; i++) {
      expect(makeReference("1026").slice(3, 7)).toMatch(/^[2-9A-HJKMNP-Z]{4}$/);
    }
  });

  it("accepts case, spaces and missing dashes", () => {
    const ref = makeReference("0925", "7K3Q");
    expect(checkReference(ref.toLowerCase().replace(/-/g, " "))).toEqual({
      ok: true,
      reference: ref,
    });
    expect(normaliseReference(ref.replace(/-/g, ""))).toBe(ref);
  });

  it("catches every single mistyped character", () => {
    const body = makeReference("0925", "7K3Q").replace(/-/g, "").slice(2);
    for (let i = 0; i < body.length; i++) {
      for (const s of SYMBOLS) {
        if (s === body[i]) continue;
        const typo = body.slice(0, i) + s + body.slice(i + 1);
        expect(checkReference("TF" + typo).ok, typo).toBe(false);
      }
    }
  });

  it("catches every swap of two neighbouring different characters", () => {
    for (const random of ["7K3Q", "ABCD", "2345", "XYZ9", "H2M8"]) {
      const body = makeReference("0925", random).replace(/-/g, "").slice(2);
      for (let i = 0; i < body.length - 1; i++) {
        if (body[i] === body[i + 1]) continue;
        const swapped = body.slice(0, i) + body[i + 1] + body[i] + body.slice(i + 2);
        expect(checkReference("TF" + swapped).ok, swapped).toBe(false);
      }
    }
  });

  it("reports why a reference is refused", () => {
    expect(checkReference("hello")).toEqual({ ok: false, reason: "format" });
    expect(checkReference("TF-7K3Q-0925-")).toEqual({ ok: false, reason: "format" });
    expect(checkReference("TF-7K3I-0925-A")).toEqual({ ok: false, reason: "format" });
    const ref = makeReference("0925", "7K3Q");
    const bad = ref.slice(0, -1) + (ref.endsWith("A") ? "B" : "A");
    expect(checkReference(bad)).toEqual({ ok: false, reason: "check" });
  });

  it("finds references inside bank statement text", () => {
    const a = makeReference("0925", "7K3Q");
    const b = makeReference("1025", "ABCD");
    expect(
      findReferences(`SEPA CR ${a.toLowerCase()} Cafe Ltd; ref ${b.replace(/-/g, " ")}`),
    ).toEqual([a, b]);
    expect(findReferences("no reference here")).toEqual([]);
  });

  it("validates its inputs", () => {
    expect(() => makeReference("92", "7K3Q")).toThrow(RangeError);
    expect(() => makeReference("0925", "7K0Q")).toThrow(RangeError);
    expect(() => referenceCheckChar("short")).toThrow(RangeError);
    expect(() => referenceCheckChar("7K3Q092!")).toThrow(RangeError);
    expect(monthYear(9, 2026)).toBe("0926");
    expect(() => monthYear(13, 2026)).toThrow(RangeError);
  });
});
