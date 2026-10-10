import { describe, expect, it } from "vitest";
import { csvCell, csvRow } from "@/lib/csv";
import { customerFields, tillCustomerInput, toDbCustomer } from "@/lib/customer-schema";

describe("customer fields", () => {
  it("trims, lowercases the email and turns empty optional fields into null", () => {
    const c = customerFields.parse({
      name: "  Mary Byrne ",
      email: " Mary@Example.COM ",
      phone: "",
      vatNumber: "",
      address: " ",
      notes: "",
    });
    expect(c).toEqual({
      name: "Mary Byrne",
      email: "mary@example.com",
      phone: null,
      vatNumber: null,
      address: null,
      notes: null,
    });
    expect(toDbCustomer(c).vat_number).toBeNull();
  });

  it("checks a B2B VAT number like a VAT invoice does", () => {
    const base = { name: "A", email: "", phone: "", address: "", notes: "" };
    expect(customerFields.parse({ ...base, vatNumber: "IE 6388047V" }).vatNumber).toBe(
      "IE6388047V",
    );
    expect(customerFields.parse({ ...base, vatNumber: "de123456789" }).vatNumber).toBe(
      "DE123456789",
    );
    expect(customerFields.safeParse({ ...base, vatNumber: "IE1234567X" }).success).toBe(false);
    expect(customerFields.safeParse({ ...base, vatNumber: "12345" }).success).toBe(false);
  });

  it("refuses an empty name, a bad email and over-long text", () => {
    const ok = { name: "A", email: "", phone: "", vatNumber: "", address: "", notes: "" };
    expect(customerFields.safeParse({ ...ok, name: " " }).success).toBe(false);
    expect(customerFields.safeParse({ ...ok, email: "nope" }).success).toBe(false);
    expect(customerFields.safeParse({ ...ok, notes: "x".repeat(501) }).success).toBe(false);
  });

  it("the till input needs a UUID and defaults consent to off", () => {
    const r = tillCustomerInput.parse({
      id: "0192d3a4-7b6c-7def-8a12-3456789abcde",
      name: "Till",
      email: "",
      phone: "",
      vatNumber: "",
    });
    expect(r.consent).toBe(false);
    expect(tillCustomerInput.safeParse({ ...r, id: "x" }).success).toBe(false);
  });
});

describe("csv", () => {
  it("escapes formula starters, quotes and newlines", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
  });

  it("does not touch a negative number, only text", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvRow(["a", 1, null])).toBe("a,1,");
  });
});
