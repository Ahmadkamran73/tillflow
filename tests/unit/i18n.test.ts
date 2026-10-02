import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";

describe("t", () => {
  it("returns the message", () => expect(t("nav.sales")).toBe("Sales"));
  it("fills placeholders", () => expect(t("register.pay", { amount: "€1.00" })).toBe("Pay €1.00"));
  it("keeps unknown placeholders visible", () =>
    expect(t("register.pay", {})).toBe("Pay {amount}"));
});
