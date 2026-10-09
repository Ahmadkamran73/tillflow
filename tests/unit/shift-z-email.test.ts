import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const shiftZEmailData = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", () => ({ sendMail: (m: unknown) => sendMail(m) }));
vi.mock("@/lib/ops/db", () => ({ shiftZEmailData: (id: string) => shiftZEmailData(id) }));

import { sendShiftZ, zEmailText } from "@/lib/jobs/handlers/shifts";

const data = (over: Record<string, unknown> = {}) => ({
  org_name: "Corner Shop",
  timezone: "Europe/Dublin",
  register_name: "Till 1",
  z_seq: 7,
  closed_at: "2026-10-09T17:00:00Z",
  review_flags: [],
  emails: ["owner@example.com", "second@example.com"],
  report: {
    sales: { count: 2, amount_due_cents: 1050, vat_cents: 196, discount_cents: 0 },
    tips_cents: 50,
    refunds: { count: 1, amount_cents: 350 },
    vat_by_rate: [{ rate_bp: 2300, net_cents: 854, vat_cents: 196, gross_cents: 1050 }],
    tenders: [{ label: "Cash", payments: 2, amount_cents: 650, tip_cents: 0 }],
    refund_tenders: [{ label: "Cash", refunds: 1, amount_cents: 350 }],
    drawer: {
      float_cents: 10000,
      cash_sales_cents: 650,
      cash_in_cents: 2000,
      cash_out_cents: 500,
      cash_refunds_cents: 350,
      expected_cents: 11800,
    },
    counted_cents: 11600,
    over_short_cents: -200,
  },
  ...over,
});

beforeEach(() => {
  sendMail.mockReset();
  shiftZEmailData.mockReset();
});

describe("Z email", () => {
  it("shows expected, counted and a signed over/short", () => {
    const { subject, text } = zEmailText(data() as never);
    expect(subject).toContain("Z0007");
    expect(subject).toContain("-€2.00");
    expect(text).toContain("Expected €118.00");
    expect(text).toContain("Counted €116.00");
    expect(text).toContain("VAT 23%");
  });

  it("sends to every owner and throws (so the job retries) if any send fails", async () => {
    shiftZEmailData.mockResolvedValue(data());
    sendMail.mockResolvedValue("sent");
    await sendShiftZ("s1");
    expect(sendMail).toHaveBeenCalledTimes(2);
    sendMail.mockResolvedValueOnce("failed").mockResolvedValue("sent");
    await expect(sendShiftZ("s1")).rejects.toThrow();
  });

  it("does nothing when the shift is not closed", async () => {
    shiftZEmailData.mockResolvedValue(null);
    await sendShiftZ("s1");
    expect(sendMail).not.toHaveBeenCalled();
  });
});
