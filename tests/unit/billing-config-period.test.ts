import { describe, expect, it } from "vitest";
import { ibanValid, parseBillingConfig, formatIban } from "@/lib/billing/config";
import {
  addDays,
  addMonths,
  daysBetween,
  dublinDate,
  dunningState,
  firstPeriodStart,
  periodIndexOf,
  periodN,
} from "@/lib/billing/period";

const GOOD_IBAN = "IE29AIBK93115212345678"; // the standard published example IBAN
const env = {
  BILLING_PRICE_CENTS: "4900",
  BILLING_TRIAL_DAYS: "14",
  BILLING_GRACE_DAYS: "14",
  BILLING_INVOICE_DUE_DAYS: "14",
  BILLING_VAT_RATE: "23",
  BILLING_ACCOUNT_NAME: "Tillflow Ltd",
  BILLING_IBAN: "ie29 aibk 9311 5212 3456 78",
  BILLING_BIC: "aibkie2d",
  BILLING_VAT_NUMBER: "IE1234567FA",
  BILLING_ADDRESS: "1 Main Street, Dublin",
};

describe("billing config", () => {
  it("parses a complete environment and normalises the IBAN and BIC", () => {
    const r = parseBillingConfig(env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toMatchObject({
        priceCents: 4900,
        graceDays: 14,
        iban: GOOD_IBAN,
        bic: "AIBKIE2D",
      });
      expect(formatIban(r.config.iban)).toBe("IE29 AIBK 9311 5212 3456 78");
    }
  });

  it("refuses to run with the price or bank details missing (no silent defaults)", () => {
    for (const key of Object.keys(env)) {
      const copy: Record<string, string | undefined> = { ...env };
      delete copy[key];
      const r = parseBillingConfig(copy);
      expect(r.ok, key).toBe(false);
      if (!r.ok) expect(r.errors.join()).toContain(key);
    }
  });

  it("refuses bad numbers, IBANs and BICs, and never echoes a value", () => {
    const r = parseBillingConfig({
      ...env,
      BILLING_PRICE_CENTS: "49.00",
      BILLING_IBAN: "IE29AIBK93115212345679",
      BILLING_BIC: "nope",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(3);
      expect(r.errors.join()).not.toContain("49.00");
      expect(r.errors.join()).not.toContain("5679");
    }
  });

  it("reads the VAT rate as a percentage and stores basis points", () => {
    const rate = (v: string) => {
      const r = parseBillingConfig({ ...env, BILLING_VAT_RATE: v });
      return r.ok ? r.config.vatRateBp : null;
    };
    expect(rate("23")).toBe(2300);
    expect(rate("13.5")).toBe(1350);
    expect(rate("9.25")).toBe(925);
    expect(rate("0")).toBe(0);
    for (const bad of ["", "23%", "2300", "-1", "9.255", "abc"]) expect(rate(bad), bad).toBeNull();
  });

  it("names the seller on invoices separately from the bank account holder", () => {
    const same = parseBillingConfig(env);
    const other = parseBillingConfig({ ...env, BILLING_SUPPLIER_NAME: "Tillflow Trading" });
    expect(same.ok && same.config.supplierName).toBe(same.ok && same.config.accountName);
    expect(other.ok && other.config.supplierName).toBe("Tillflow Trading");
    expect(other.ok && other.config.accountName).not.toBe("Tillflow Trading");
  });

  it("checks IBANs with mod 97", () => {
    expect(ibanValid(GOOD_IBAN)).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("IE29AIBK93115212345679")).toBe(false);
    expect(ibanValid("1234")).toBe(false);
  });
});

describe("billing periods", () => {
  it("adds months from the anchor without drifting", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 2)).toBe("2026-03-31"); // not 28 March
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("2026-12-01", 12)).toBe("2027-12-01");
    expect(periodN("2026-01-31", 1)).toEqual({ start: "2026-02-28", end: "2026-03-31" });
  });

  it("does day maths across month ends and leap days", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2026-10-25", "2026-10-26")).toBe(1); // 25-hour DST day still one day
    expect(daysBetween("2026-03-29", "2026-03-30")).toBe(1); // 23-hour DST day
    expect(daysBetween("2026-03-01", "2026-02-01")).toBe(-28);
    expect(() => addDays("26-1-1", 1)).toThrow(RangeError);
  });

  it("finds the period a date is in", () => {
    expect(periodIndexOf("2026-01-31", "2026-01-30")).toBe(-1);
    expect(periodIndexOf("2026-01-31", "2026-01-31")).toBe(0);
    expect(periodIndexOf("2026-01-31", "2026-02-27")).toBe(0);
    expect(periodIndexOf("2026-01-31", "2026-02-28")).toBe(1);
    expect(periodIndexOf("2026-01-31", "2026-03-30")).toBe(1);
    expect(periodIndexOf("2026-01-31", "2026-03-31")).toBe(2);
  });

  it("uses the Irish date, not the UTC date", () => {
    // 23:30 UTC on 30 June is already 1 July in Dublin (summer time, UTC+1).
    expect(dublinDate(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
    expect(dublinDate(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31"); // winter: UTC+0
    expect(firstPeriodStart(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
  });
});

describe("reminders and pause timing", () => {
  const due = "2026-11-13";
  const grace = 14;

  it.each([
    ["2026-11-12", "current"],
    ["2026-11-13", "reminder_1"], // the due date itself
    ["2026-11-19", "reminder_1"],
    ["2026-11-20", "reminder_2"], // due + 7
    ["2026-11-27", "reminder_2"], // due + 14 = last day of grace
    ["2026-11-28", "pause"], // due + 15
    ["2027-03-01", "pause"],
  ])("on %s an unpaid invoice is %s", (today, expected) => {
    expect(dunningState(today, due, grace)).toBe(expected);
  });

  it("pauses straight after the due date when there is no grace", () => {
    expect(dunningState("2026-11-13", due, 0)).toBe("reminder_1");
    expect(dunningState("2026-11-14", due, 0)).toBe("pause");
  });

  it("is steady across the clock change (day counts use dates, not 24-hour blocks)", () => {
    const dueDst = "2026-10-20";
    expect(dunningState("2026-10-27", dueDst, 14)).toBe("reminder_2");
    expect(dunningState("2026-11-04", dueDst, 14)).toBe("pause");
  });
});
