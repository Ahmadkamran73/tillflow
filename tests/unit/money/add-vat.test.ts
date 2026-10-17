import { describe, expect, it } from "vitest";
import { addVat, splitVat } from "@/lib/money";

describe("addVat", () => {
  it.each([
    [4900, 2300, 1127, 6027],
    [0, 2300, 0, 0],
    [1000, 0, 0, 1000],
    [1, 2300, 0, 1], // 0.23c rounds down
    [2, 2500, 1, 3], // 0.5c rounds up (half-up)
    [-4900, 2300, -1127, -6027], // mirrored for credit notes
    [-2, 2500, -1, -3],
  ])("net %i at %i bp gives vat %i and gross %i", (net, rate, vat, gross) => {
    expect(addVat(net, rate)).toEqual({ net, vat, gross });
  });

  it("agrees with splitVat on whole-euro prices", () => {
    for (let net = 0; net <= 20000; net += 100) {
      const { gross, vat } = addVat(net, 2300);
      expect(splitVat(gross, 2300)).toEqual({ net, vat });
    }
  });

  it("rejects non-integers and bad rates", () => {
    expect(() => addVat(10.5, 2300)).toThrow(RangeError);
    expect(() => addVat(100, -1)).toThrow(RangeError);
    expect(() => addVat(100, 10001)).toThrow(RangeError);
    expect(() => addVat(100, 23.5)).toThrow(RangeError);
  });
});
