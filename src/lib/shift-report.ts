/** The report the database builds for a shift (app.shift_report, stored on a Z close). */
export type ShiftReport = {
  closed: boolean;
  z_seq?: number;
  closed_at?: string;
  review_flags?: string[];
  counted_cents?: number;
  over_short_cents?: number;
  sales: {
    count: number;
    items_total_cents: number;
    vat_cents: number;
    non_vat_cents: number;
    rounding_cents: number;
    amount_due_cents: number;
    discount_cents: number;
  };
  vat_by_rate: { rate_bp: number; net_cents: number; vat_cents: number; gross_cents: number }[];
  tenders: {
    method: string;
    label: string;
    payments: number;
    amount_cents: number;
    tip_cents: number;
  }[];
  tips_cents: number;
  refunds: {
    count: number;
    amount_cents: number;
    credit_cents: number;
    vat_cents: number;
    by_kind: { kind: string; count: number; amount_cents: number }[];
  };
  refund_vat_by_rate: {
    rate_bp: number;
    net_cents: number;
    vat_cents: number;
    gross_cents: number;
  }[];
  refund_tenders: {
    method: string;
    label: string;
    refunds: number;
    amount_cents: number;
    tip_cents: number;
  }[];
  drawer: {
    float_cents: number;
    cash_sales_cents: number;
    cash_in_cents: number;
    cash_out_cents: number;
    cash_refunds_cents: number;
    expected_cents: number;
  };
};

/** The Z number as printed: 7 -> "Z0007". */
export const zNumber = (seq: number) => `Z${String(seq).padStart(4, "0")}`;

/** 2300 -> "23%", 1350 -> "13.5%". */
export const rateLabel = (bp: number) => `${bp / 100}%`;
