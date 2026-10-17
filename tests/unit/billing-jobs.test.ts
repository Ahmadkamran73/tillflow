import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const ops = {
  billingCandidates: vi.fn(),
  billingEnsureSubscriptions: vi.fn(),
  billingInvoiceContext: vi.fn(),
  billingIssueInvoice: vi.fn(),
  billingMarkEmailed: vi.fn(),
  billingMarkOverdue: vi.fn(),
  billingOpenInvoices: vi.fn(),
  billingPause: vi.fn(),
  billingPendingEmails: vi.fn(),
  billingReminderClaim: vi.fn(),
  billingReminderRelease: vi.fn(),
};
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", () => ({ sendMail: (m: unknown) => sendMail(m) }));
vi.mock("@/lib/ops/db", () => ({
  billingCandidates: () => ops.billingCandidates(),
  billingEnsureSubscriptions: (...a: unknown[]) => ops.billingEnsureSubscriptions(...a),
  billingInvoiceContext: (...a: unknown[]) => ops.billingInvoiceContext(...a),
  billingIssueInvoice: (...a: unknown[]) => ops.billingIssueInvoice(...a),
  billingMarkEmailed: (...a: unknown[]) => ops.billingMarkEmailed(...a),
  billingMarkOverdue: (...a: unknown[]) => ops.billingMarkOverdue(...a),
  billingOpenInvoices: () => ops.billingOpenInvoices(),
  billingPause: (...a: unknown[]) => ops.billingPause(...a),
  billingPendingEmails: () => ops.billingPendingEmails(),
  billingReminderClaim: (...a: unknown[]) => ops.billingReminderClaim(...a),
  billingReminderRelease: (...a: unknown[]) => ops.billingReminderRelease(...a),
}));
vi.mock("@/lib/billing/invoice-pdf", async (orig) => ({
  ...(await orig<typeof import("@/lib/billing/invoice-pdf")>()),
  renderInvoicePdf: vi.fn(async () => Buffer.from("%PDF-fake")),
}));

import { checkReference } from "@/lib/billing/reference";
import { dunningJob, invoiceJob } from "@/lib/jobs/handlers/billing";

const ENV = {
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
};

const ORG = "11111111-1111-4111-8111-111111111111";
const INV = "22222222-2222-4222-8222-222222222222";

const context = (over: Record<string, unknown> = {}) => ({
  invoice: {
    id: INV,
    org_id: ORG,
    invoice_no: 7,
    period_start: "2026-11-01",
    period_end: "2026-12-01",
    amount_ex_vat_cents: 4900,
    vat_rate_bp: 2300,
    vat_cents: 1127,
    total_cents: 6027,
    issued_at: "2026-11-01T09:00:00Z",
    due_on: "2026-11-13",
    payment_reference: "TF-7K3Q-1126-K",
    status: "issued",
    supplier_name: "Tillflow Ltd",
    supplier_address: "1 Main Street, Dublin",
    supplier_vat_number: "IE1234567FA",
    customer_name: "Corner Shop Ltd",
    customer_address: "5 High Street, Cork",
    customer_vat_number: "IE1234567FA",
  },
  org_name: "Corner Shop",
  legal_name: "Corner Shop Ltd",
  vat_number: "IE1234567FA",
  emails: ["owner@example.com", "second@example.com"],
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.stubEnv("ALERT_FROM", "billing@example.com");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pos.example.com");
  Object.values(ops).forEach((m) => m.mockReset());
  sendMail.mockReset().mockResolvedValue("sent");
  ops.billingEnsureSubscriptions.mockResolvedValue(0);
  ops.billingCandidates.mockResolvedValue([]);
  ops.billingPendingEmails.mockResolvedValue([]);
  ops.billingOpenInvoices.mockResolvedValue([]);
  ops.billingInvoiceContext.mockResolvedValue(context());
  ops.billingReminderClaim.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("invoice job", () => {
  const candidate = {
    org_id: ORG,
    sub_status: "trial",
    anchor_date: null,
    trial_ends_at: "2026-11-01T00:00:00Z",
    last_period_start: null,
  };

  it("does nothing, and says so, when billing settings are missing", async () => {
    vi.stubEnv("BILLING_IBAN", "");
    await invoiceJob(new Date("2026-11-02T10:00:00Z"));
    expect(ops.billingEnsureSubscriptions).not.toHaveBeenCalled();
    expect(ops.billingIssueInvoice).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("creates subscriptions with the configured trial and price, then invoices a finished trial", async () => {
    ops.billingCandidates.mockResolvedValue([candidate]);
    ops.billingIssueInvoice.mockResolvedValue({
      created: true,
      id: INV,
      invoice_no: 7,
      payment_reference: "x",
    });
    await invoiceJob(new Date("2026-11-02T10:00:00Z"));
    expect(ops.billingEnsureSubscriptions).toHaveBeenCalledWith(14, 4900);
    expect(ops.billingIssueInvoice).toHaveBeenCalledTimes(1);
    const f = ops.billingIssueInvoice.mock.calls[0]![0];
    expect(f).toMatchObject({
      org_id: ORG,
      period_start: "2026-11-01",
      period_end: "2026-12-01",
      amount_ex_vat_cents: 4900,
      vat_rate_bp: 2300,
      vat_cents: 1127,
      total_cents: 6027,
      due_on: "2026-11-16",
      supplier_name: "Tillflow Ltd",
      supplier_address: "1 Main Street, Dublin",
      supplier_vat_number: "IE1234567FA",
    });
    expect(checkReference(f.payment_reference).ok).toBe(true);
  });

  it("skips a business whose trial is still running", async () => {
    ops.billingCandidates.mockResolvedValue([
      { ...candidate, trial_ends_at: "2026-11-05T00:00:00Z" },
    ]);
    await invoiceJob(new Date("2026-11-02T10:00:00Z"));
    expect(ops.billingIssueInvoice).not.toHaveBeenCalled();
  });

  it("running it again changes nothing (the database returns the existing invoice)", async () => {
    ops.billingCandidates.mockResolvedValue([candidate]);
    ops.billingIssueInvoice.mockResolvedValue({
      created: false,
      id: INV,
      invoice_no: 7,
      payment_reference: "x",
    });
    await invoiceJob(new Date("2026-11-02T10:00:00Z"));
    await invoiceJob(new Date("2026-11-02T11:00:00Z"));
    expect(ops.billingIssueInvoice).toHaveBeenCalledTimes(2);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("draws another payment reference when the first is taken", async () => {
    ops.billingCandidates.mockResolvedValue([candidate]);
    ops.billingIssueInvoice
      .mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }))
      .mockResolvedValue({ created: true, id: INV, invoice_no: 7, payment_reference: "x" });
    await invoiceJob(new Date("2026-11-02T10:00:00Z"));
    expect(ops.billingIssueInvoice).toHaveBeenCalledTimes(2);
    const [a, b] = ops.billingIssueInvoice.mock.calls.map((c) => c[0]);
    expect(a.payment_reference).not.toBe(b.payment_reference);
  });

  it("does not hide other database errors", async () => {
    ops.billingCandidates.mockResolvedValue([candidate]);
    ops.billingIssueInvoice.mockRejectedValue(Object.assign(new Error("boom"), { code: "XX000" }));
    await expect(invoiceJob(new Date("2026-11-02T10:00:00Z"))).rejects.toThrow("boom");
  });

  it("emails the invoice PDF to every owner and marks it sent", async () => {
    ops.billingPendingEmails.mockResolvedValue([INV]);
    await invoiceJob(new Date("2026-11-02T10:00:00Z"));
    expect(sendMail).toHaveBeenCalledTimes(2);
    const m = sendMail.mock.calls[0]![0];
    expect(m.subject).toContain("INV-000007");
    expect(m.text).toContain("TF-7K3Q-1126-K");
    expect(m.text).toContain("IE29AIBK93115212345678");
    expect(m.attachments[0]).toMatchObject({
      filename: "INV-000007.pdf",
      contentType: "application/pdf",
    });
    expect(ops.billingMarkEmailed).toHaveBeenCalledWith(INV);
  });

  it("leaves an invoice to be retried when no email could be sent, and does not resend after a partial send", async () => {
    ops.billingPendingEmails.mockResolvedValue([INV]);
    sendMail.mockResolvedValue("failed");
    await invoiceJob(new Date("2026-11-02T10:00:00Z"));
    expect(ops.billingMarkEmailed).not.toHaveBeenCalled();
    sendMail.mockReset().mockResolvedValueOnce("failed").mockResolvedValueOnce("sent");
    await invoiceJob(new Date("2026-11-02T11:00:00Z"));
    expect(ops.billingMarkEmailed).toHaveBeenCalledTimes(1);
  });
});

describe("reminders and pause timing (fake clock, Irish dates)", () => {
  const open = (over: Record<string, unknown> = {}) => ({
    id: INV,
    org_id: ORG,
    due_on: "2026-11-13",
    reminder_1_sent: false,
    reminder_2_sent: false,
    sub_status: "trial",
    org_status: "trial",
    ...over,
  });
  const run = async (iso: string) => {
    vi.setSystemTime(new Date(iso));
    await dunningJob(new Date(iso));
  };

  beforeEach(() => ops.billingOpenInvoices.mockResolvedValue([open()]));

  it("nothing happens before the due date", async () => {
    await run("2026-11-12T22:59:00Z");
    expect(ops.billingMarkOverdue).not.toHaveBeenCalled();
    expect(ops.billingReminderClaim).not.toHaveBeenCalled();
    expect(ops.billingPause).not.toHaveBeenCalled();
  });

  it("on the due date: overdue, and the first reminder only", async () => {
    await run("2026-11-13T09:00:00Z");
    expect(ops.billingMarkOverdue).toHaveBeenCalledWith(ORG);
    expect(ops.billingReminderClaim.mock.calls).toEqual([[INV, 1]]);
    expect(sendMail).toHaveBeenCalledTimes(2); // two owners
    expect(sendMail.mock.calls[0]![0].subject).toContain("Reminder");
    expect(ops.billingPause).not.toHaveBeenCalled();
  });

  it("seven days after: the second reminder names the date it goes read-only", async () => {
    await run("2026-11-20T09:00:00Z");
    expect(ops.billingReminderClaim.mock.calls).toEqual([
      [INV, 1],
      [INV, 2],
    ]);
    const second = sendMail.mock.calls.map((c) => c[0]).find((m) => m.subject.includes("Second"));
    expect(second.text).toContain("end of 27/11/2026"); // the last of the 14 grace days
    expect(second.text).toContain("Nothing is deleted");
  });

  it("a reminder already sent is not sent again", async () => {
    ops.billingReminderClaim.mockResolvedValue(false);
    await run("2026-11-20T09:00:00Z");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("a failed reminder email is handed back to be retried", async () => {
    sendMail.mockResolvedValue("failed");
    await run("2026-11-13T09:00:00Z");
    expect(ops.billingReminderRelease).toHaveBeenCalledWith(INV, 1);
  });

  it("the last day of grace does not pause; the next day does, and the owners are told", async () => {
    await run("2026-11-27T12:00:00Z");
    expect(ops.billingPause).not.toHaveBeenCalled();
    ops.billingPause.mockResolvedValue(true);
    sendMail.mockClear();
    await run("2026-11-28T00:30:00Z");
    expect(ops.billingPause).toHaveBeenCalledWith(ORG, INV, "2026-11-28");
    expect(sendMail.mock.calls[0]![0].subject).toContain("read-only");
    expect(sendMail.mock.calls[0]![0].text).toContain("Nothing has been deleted");
  });

  it("sends no pause email when the database declined (a super-admin hold), and reminders are not sent late", async () => {
    ops.billingPause.mockResolvedValue(false);
    await run("2026-12-20T12:00:00Z");
    expect(ops.billingPause).toHaveBeenCalledTimes(1);
    expect(sendMail).not.toHaveBeenCalled();
    expect(ops.billingReminderClaim).not.toHaveBeenCalled();
  });

  it("an already paused business is left alone", async () => {
    ops.billingOpenInvoices.mockResolvedValue([
      open({ sub_status: "paused", org_status: "read_only" }),
    ]);
    await run("2026-12-20T12:00:00Z");
    expect(ops.billingPause).not.toHaveBeenCalled();
  });

  it("uses the Irish date at the edges of the day and of the clock change", async () => {
    // 23:30 UTC on 12 Nov is still 12 Nov in Dublin (winter): not due yet.
    await run("2026-11-12T23:30:00Z");
    expect(ops.billingReminderClaim).not.toHaveBeenCalled();
    // Due 25 Oct 2026 (clocks go back that night): the 7th day is 1 Nov, whatever the hours.
    ops.billingOpenInvoices.mockResolvedValue([open({ due_on: "2026-10-25" })]);
    await run("2026-10-31T23:30:00Z");
    expect(ops.billingReminderClaim.mock.calls.map((c) => c[1])).toEqual([1]);
    ops.billingReminderClaim.mockClear();
    await run("2026-11-01T00:30:00Z");
    expect(ops.billingReminderClaim.mock.calls.map((c) => c[1])).toEqual([1, 2]);
  });

  it("uses the configured grace days (0 = pause the day after it is due)", async () => {
    vi.stubEnv("BILLING_GRACE_DAYS", "0");
    ops.billingPause.mockResolvedValue(true);
    await run("2026-11-13T09:00:00Z");
    expect(ops.billingPause).not.toHaveBeenCalled();
    await run("2026-11-14T09:00:00Z");
    expect(ops.billingPause).toHaveBeenCalled();
  });

  it("does nothing without billing settings", async () => {
    vi.stubEnv("BILLING_GRACE_DAYS", "");
    await run("2026-12-20T12:00:00Z");
    expect(ops.billingOpenInvoices).not.toHaveBeenCalled();
  });
});
