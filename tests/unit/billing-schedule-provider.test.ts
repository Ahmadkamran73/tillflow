import { describe, expect, it } from "vitest";
import { parseBillingConfig, type BillingConfig } from "@/lib/billing/config";
import { bankTransferProvider } from "@/lib/billing/provider";
import { checkReference } from "@/lib/billing/reference";
import { nextPeriod } from "@/lib/billing/schedule";

const config = (over: Partial<Record<string, string>> = {}): BillingConfig => {
  const r = parseBillingConfig({
    BILLING_PRICE_CENTS: "4900",
    BILLING_TRIAL_DAYS: "14",
    BILLING_GRACE_DAYS: "14",
    BILLING_INVOICE_DUE_DAYS: "14",
    BILLING_VAT_RATE: "23",
    BILLING_ACCOUNT_NAME: "Tillflow Ltd",
    BILLING_IBAN: "IE29AIBK93115212345678",
    BILLING_BIC: "AIBKIE2D",
    BILLING_VAT_NUMBER: "IE1234567FA",
    BILLING_ADDRESS: "1 Main Street, Dublin",
    ...over,
  });
  if (!r.ok) throw new Error(r.errors.join());
  return r.config;
};

describe("invoice figures (bank transfer provider)", () => {
  const draft = (c: BillingConfig, today = "2026-11-01") =>
    bankTransferProvider(c).draftInvoice({
      id: "id-1",
      orgId: "org-1",
      period: { start: "2026-11-01", end: "2026-12-01" },
      today,
    });

  it("adds VAT on top of the fixed ex-VAT price through the money library", () => {
    const d = draft(config());
    expect(d).toMatchObject({
      amountExVatCents: 4900,
      vatRateBp: 2300,
      vatCents: 1127,
      totalCents: 6027,
      dueOn: "2026-11-15",
    });
    expect(d.amountExVatCents + d.vatCents).toBe(d.totalCents);
  });

  it("follows the settings: another price, rate and due days", () => {
    const d = draft(
      config({
        BILLING_PRICE_CENTS: "3333",
        BILLING_VAT_RATE: "13.5",
        BILLING_INVOICE_DUE_DAYS: "30",
      }),
      "2026-11-20",
    );
    expect(d).toMatchObject({
      amountExVatCents: 3333,
      vatRateBp: 1350,
      vatCents: 450,
      totalCents: 3783,
    });
    expect(d.dueOn).toBe("2026-12-20");
  });

  it("makes a payment reference that dates the invoice month and checks out", () => {
    const d = draft(config());
    expect(d.paymentReference).toMatch(/^TF-[2-9A-HJKMNP-Z]{4}-1126-[0-9A-Z]$/);
    expect(checkReference(d.paymentReference).ok).toBe(true);
  });

  it("tells the customer how to pay, with the IBAN in groups and the exact amount", () => {
    const c = config();
    const d = draft(c);
    expect(bankTransferProvider(c).paymentInstructions(d)).toEqual({
      method: "bank_transfer",
      accountName: "Tillflow Ltd",
      iban: "IE29 AIBK 9311 5212 3456 78",
      bic: "AIBKIE2D",
      reference: d.paymentReference,
      amountCents: 6027,
      dueOn: "2026-11-15",
    });
  });
});

describe("which period is invoiced next", () => {
  const at = (iso: string) => new Date(iso);

  it("nothing before the trial ends, or when there is no trial end", () => {
    expect(
      nextPeriod(
        { anchorDate: null, trialEndsAt: at("2026-11-10T12:00:00Z"), lastPeriodStart: null },
        at("2026-11-10T11:59:00Z"),
      ),
    ).toBeNull();
    expect(
      nextPeriod(
        { anchorDate: null, trialEndsAt: null, lastPeriodStart: null },
        at("2026-11-10T11:59:00Z"),
      ),
    ).toBeNull();
  });

  it("the first month starts on the (Irish) day the trial ended", () => {
    expect(
      nextPeriod(
        { anchorDate: null, trialEndsAt: at("2026-11-10T12:00:00Z"), lastPeriodStart: null },
        at("2026-11-10T12:00:00Z"),
      ),
    ).toEqual({ start: "2026-11-10", end: "2026-12-10" });
    // 23:30 UTC in summer is already the next day in Dublin.
    expect(
      nextPeriod(
        { anchorDate: null, trialEndsAt: at("2026-06-30T23:30:00Z"), lastPeriodStart: null },
        at("2026-07-01T00:00:00Z"),
      ),
    ).toEqual({ start: "2026-07-01", end: "2026-08-01" });
  });

  it("later months are issued on the day they start, not before", () => {
    const facts = { anchorDate: "2026-11-10", trialEndsAt: null, lastPeriodStart: "2026-11-10" };
    expect(nextPeriod(facts, at("2026-12-09T23:59:00Z"))).toBeNull();
    expect(nextPeriod(facts, at("2026-12-10T00:00:00Z"))).toEqual({
      start: "2026-12-10",
      end: "2027-01-10",
    });
  });

  it("counts months from the anchor, so the 31st does not drift", () => {
    const anchor = "2026-01-31";
    expect(
      nextPeriod(
        { anchorDate: anchor, trialEndsAt: null, lastPeriodStart: "2026-01-31" },
        at("2026-03-01T00:00:00Z"),
      ),
    ).toEqual({ start: "2026-02-28", end: "2026-03-31" });
    expect(
      nextPeriod(
        { anchorDate: anchor, trialEndsAt: null, lastPeriodStart: "2026-02-28" },
        at("2026-03-31T12:00:00Z"),
      ),
    ).toEqual({ start: "2026-03-31", end: "2026-04-30" });
  });

  it("catches up one month at a time after downtime", () => {
    const facts = { anchorDate: "2026-01-15", trialEndsAt: null, lastPeriodStart: "2026-01-15" };
    expect(nextPeriod(facts, at("2026-06-01T00:00:00Z"))).toEqual({
      start: "2026-02-15",
      end: "2026-03-15",
    });
  });

  it("does not bill months that passed entirely while the business was paused", () => {
    // Last invoice: 15 Oct to 15 Nov. Paused after that, reopened 10 Feb.
    const facts = {
      anchorDate: "2026-10-15",
      trialEndsAt: null,
      lastPeriodStart: "2026-10-15",
      resumedOn: "2027-02-10",
    };
    // Natural next would be 15 Nov, then 15 Dec, 15 Jan: none of them is issued.
    expect(nextPeriod(facts, at("2027-02-10T09:00:00Z"))).toEqual({
      start: "2027-02-10",
      end: "2027-03-10",
    });
  });

  it("a reopening inside the period already paid changes nothing", () => {
    const facts = {
      anchorDate: "2026-10-15",
      trialEndsAt: null,
      lastPeriodStart: "2026-10-15",
      resumedOn: "2026-11-02",
    };
    expect(nextPeriod(facts, at("2026-11-10T00:00:00Z"))).toBeNull();
    expect(nextPeriod(facts, at("2026-11-15T00:00:00Z"))).toEqual({
      start: "2026-11-15",
      end: "2026-12-15",
    });
  });

  it("a reopening on the day the next period would start keeps the normal cycle", () => {
    const facts = {
      anchorDate: "2026-10-15",
      trialEndsAt: null,
      lastPeriodStart: "2026-10-15",
      resumedOn: "2026-11-15",
    };
    expect(nextPeriod(facts, at("2026-11-15T10:00:00Z"))).toEqual({
      start: "2026-11-15",
      end: "2026-12-15",
    });
  });

  it("is safe if the anchor is missing or inconsistent", () => {
    expect(
      nextPeriod(
        { anchorDate: null, trialEndsAt: null, lastPeriodStart: "2026-11-10" },
        at("2026-12-10T00:00:00Z"),
      ),
    ).toEqual({ start: "2026-12-10", end: "2027-01-10" });
    expect(
      nextPeriod(
        { anchorDate: "2026-12-01", trialEndsAt: null, lastPeriodStart: "2026-11-01" },
        at("2027-06-01T00:00:00Z"),
      ),
    ).toBeNull();
  });
});
