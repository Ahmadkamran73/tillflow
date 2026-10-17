import { describe, expect, it } from "vitest";
import { makeReference } from "@/lib/billing/reference";
import {
  MAX_STATEMENT_ROWS,
  parseEuroCents,
  parseStatement,
  parseStatementDate,
  suggest,
  type InvoiceMatch,
} from "@/lib/billing/statement";

const ref = makeReference("1126", "7K3Q");
const other = makeReference("1126", "ABCD");

describe("statement amounts and dates", () => {
  it.each([
    ["60.27", 6027],
    ["60,27", 6027],
    ["€ 60.27", 6027],
    ["1,234.56", 123456],
    ["1,234", 123400],
    ["1234", 123400],
    ["-12.5", -1250],
    ["0.07", 7],
  ])("reads %s as %i cents", (raw, cents) => expect(parseEuroCents(raw)).toBe(cents));

  it.each(["", "abc", "12.345", "1.2.3", "TF-7K3Q-1126-K", "12,34,56"])(
    "%s is not an amount",
    (raw) => expect(parseEuroCents(raw)).toBeNull(),
  );

  it("reads Irish and ISO dates and refuses impossible ones", () => {
    expect(parseStatementDate("31/10/2026")).toBe("2026-10-31");
    expect(parseStatementDate("01-02-2027")).toBe("2027-02-01");
    expect(parseStatementDate("2026-11-05")).toBe("2026-11-05");
    expect(parseStatementDate("2026-11-05T10:00:00Z")).toBe("2026-11-05");
    expect(parseStatementDate("31/02/2026")).toBeNull();
    expect(parseStatementDate("2026-13-01")).toBeNull();
    expect(parseStatementDate("hello")).toBeNull();
  });
});

describe("reading a statement", () => {
  const csv = [
    "Date,Details,Debit,Credit,Balance",
    '05/11/2026,SEPA CREDIT Corner Shop Ltd,,60.27,"1,500.00"',
    `06/11/2026,"Transfer ${ref.toLowerCase()} Mary's Cafe",,49.00,1549.00`,
    "07/11/2026,Card purchase Tesco,12.50,,1536.50",
    `08/11/2026,Ref ${ref.slice(0, -1)}${ref.endsWith("A") ? "B" : "A"} typo,,60.27,1596.77`,
    `09/11/2026,${other.replace(/-/g, " ")} Gift,,60.27,1657.04`,
    "",
  ].join("\n");

  it("keeps only the lines that mention a reference, with amounts and date", () => {
    const { lines, rowsRead, truncated } = parseStatement(csv);
    expect(truncated).toBe(false);
    expect(rowsRead).toBe(6);
    expect(lines.map((l) => l.row)).toEqual([3, 5, 6]);
    expect(lines[0]).toMatchObject({
      date: "2026-11-06",
      references: [ref],
      invalidReferences: [],
    });
    expect(lines[0]!.amountsCents).toEqual(expect.arrayContaining([4900, 154900]));
    expect(lines[1]).toMatchObject({ references: [], invalidReferences: expect.any(Array) });
    expect(lines[1]!.invalidReferences).toHaveLength(1);
    expect(lines[2]).toMatchObject({ references: [other] });
  });

  it("never reads more than the row limit and says so", () => {
    const many = Array.from({ length: MAX_STATEMENT_ROWS + 10 }, () => `x,${ref}`).join("\n");
    const r = parseStatement(many);
    expect(r.truncated).toBe(true);
    expect(r.lines).toHaveLength(MAX_STATEMENT_ROWS);
  });

  it("treats spreadsheet formulas as plain text (nothing is ever written back)", () => {
    const { lines } = parseStatement(`=HYPERLINK("http://evil"),${ref},60.27`);
    expect(lines[0]!.text).toContain("=HYPERLINK");
    expect(lines[0]!.references).toEqual([ref]);
  });
});

describe("suggesting matches", () => {
  const invoice = (over: Partial<InvoiceMatch> = {}): InvoiceMatch => ({
    reference: ref,
    invoice_id: "00000000-0000-4000-8000-000000000001",
    org_name: "Corner Shop",
    invoice_no: 7,
    total_cents: 6027,
    status: "issued",
    due_on: "2026-11-15",
    ...over,
  });
  const line = (amounts: number[], refs = [ref]) => ({
    row: 2,
    text: "x",
    date: "2026-11-06",
    amountsCents: amounts,
    references: refs,
    invalidReferences: [],
  });

  it("exact when the reference and an amount agree", () => {
    expect(suggest([line([6027])], [invoice()])[0]!.kind).toBe("exact");
  });
  it("flags a different amount instead of hiding it", () => {
    expect(suggest([line([5000])], [invoice()])[0]!.kind).toBe("amountDiffers");
  });
  it("flags an invoice that is already paid, and an unknown reference", () => {
    expect(suggest([line([6027])], [invoice({ status: "paid" })])[0]!.kind).toBe("paidAlready");
    expect(suggest([line([6027])], [])[0]!.kind).toBe("unknown");
  });
  it("reports a mistyped reference", () => {
    const l = { ...line([6027], []), invalidReferences: ["TF-7K3Q-1126-Z"] };
    expect(suggest([l], [])[0]).toMatchObject({ kind: "badCheck", reference: "TF-7K3Q-1126-Z" });
  });
});
