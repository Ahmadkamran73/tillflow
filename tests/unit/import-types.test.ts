import { describe, expect, it } from "vitest";
import {
  IMPORT_TYPES,
  importFieldsFor,
  MATCH_KEYS,
  MODES,
  requiredFor,
  templateRows,
  type Mapping,
} from "@/lib/import/fields";
import { autoMatch } from "@/lib/import/presets";
import {
  DEFAULTS,
  missingFields,
  settingsProblem,
  type ImportSettings,
} from "@/lib/import/settings";
import { buildCustomerItems } from "@/lib/import/validate-customers";
import { buildStockItems } from "@/lib/import/validate-stock";

const ID = "0197f3a0-0000-7000-8000-000000000001";

describe("import types: fields, templates, auto match", () => {
  it("has three kinds, each with its own columns, modes and match keys", () => {
    expect([...IMPORT_TYPES]).toEqual(["products", "stock", "customers"]);
    expect(importFieldsFor("stock", "general")).toEqual(["sku", "barcode", "quantity", "notes"]);
    expect(importFieldsFor("customers", "cafe")).toEqual([
      "name",
      "email",
      "phone",
      "vatNumber",
      "address",
      "notes",
    ]);
    expect(importFieldsFor("products", "general")).toContain("price");
    expect(MODES.stock).toEqual(["count", "received"]);
    expect(MATCH_KEYS.customers).toEqual(["email"]);
    expect(requiredFor("stock")).toEqual(["quantity"]);
    expect(requiredFor("customers")).toEqual(["name"]);
  });

  it("builds a template per kind with a header and one example row", () => {
    expect(templateRows("general", "stock")).toEqual([
      ["SKU", "Barcode", "Quantity", "Note (optional)"],
      ["BRD-1", "", "24", "Friday delivery"],
    ]);
    const customers = templateRows("restaurant", "customers");
    expect(customers[0]).toEqual(["Name", "Email", "Phone", "VAT number", "Address", "Notes"]);
    expect(customers[1]![1]).toBe("mary@example.com");
    expect(templateRows("general")[0]).toContain("Price (incl. VAT)"); // products unchanged
  });

  it("matches stock and customer columns by their usual names, only among that kind's columns", () => {
    const stock = autoMatch(
      ["Item code", "On Hand", "Note", "Price"],
      null,
      importFieldsFor("stock", "general"),
    );
    expect(stock).toEqual({ sku: "Item code", quantity: "On Hand", notes: "Note" });
    const customers = autoMatch(
      ["Full Name", "Email Address", "Mobile", "VAT No", "Street Address", "Comments", "Price"],
      null,
      importFieldsFor("customers", "general"),
    );
    expect(customers).toEqual({
      name: "Full Name",
      email: "Email Address",
      phone: "Mobile",
      vatNumber: "VAT No",
      address: "Street Address",
      notes: "Comments",
    });
  });
});

describe("import settings: what is required for each kind", () => {
  const base = (over: Partial<ImportSettings>): ImportSettings => ({
    mapping: {},
    ...DEFAULTS.products,
    ...over,
  });

  it("products need name and price", () => {
    expect(settingsProblem("products", base({ mapping: { name: "N" } }))).toBe(
      "import.err.required",
    );
    expect(settingsProblem("products", base({ mapping: { name: "N", price: "P" } }))).toBeNull();
  });

  it("stock needs the quantity column and the column it is matched by", () => {
    const s = (mapping: Mapping, matchKey: "sku" | "barcode" = "sku") => ({
      mapping,
      mode: "count" as const,
      matchKey,
    });
    expect(settingsProblem("stock", s({ quantity: "Q" }))).toBe("import.err.requiredStock");
    expect(settingsProblem("stock", s({ sku: "S" }))).toBe("import.err.requiredStock");
    expect(settingsProblem("stock", s({ quantity: "Q", sku: "S" }))).toBeNull();
    expect(settingsProblem("stock", s({ quantity: "Q", sku: "S" }, "barcode"))).toBe(
      "import.err.requiredStock",
    );
    expect(missingFields("stock", { ...s({ quantity: "Q" }), mode: "received" })).toEqual(["sku"]);
  });

  it("customers need a name, and an email column to update existing ones", () => {
    const s = (mapping: Mapping, mode: "create" | "upsert") => ({
      mapping,
      mode,
      matchKey: "email" as const,
    });
    expect(settingsProblem("customers", s({}, "create"))).toBe("import.err.requiredCustomers");
    expect(settingsProblem("customers", s({ name: "N" }, "create"))).toBeNull();
    expect(settingsProblem("customers", s({ name: "N" }, "upsert"))).toBe(
      "import.err.requiredEmail",
    );
    expect(settingsProblem("customers", s({ name: "N", email: "E" }, "upsert"))).toBeNull();
  });

  it("refuses a mode or match key that belongs to another kind", () => {
    expect(
      settingsProblem("stock", {
        mapping: { quantity: "Q", sku: "S" },
        mode: "create",
        matchKey: "sku",
      }),
    ).toBe("import.err.generic");
    expect(
      settingsProblem("products", {
        mapping: { name: "N", price: "P" },
        mode: "count",
        matchKey: "sku",
      }),
    ).toBe("import.err.generic");
    expect(
      settingsProblem("customers", { mapping: { name: "N" }, mode: "create", matchKey: "sku" }),
    ).toBe("import.err.generic");
    expect(
      settingsProblem("stock", {
        mapping: { quantity: "Q", sku: "S" },
        mode: "count",
        matchKey: "email",
      }),
    ).toBe("import.err.generic");
  });
});

describe("buildStockItems", () => {
  const map: Mapping = { sku: "SKU", barcode: "Barcode", quantity: "Qty", notes: "Note" };
  const row = (o: Record<string, string>) => ({ SKU: "", Barcode: "", Qty: "", Note: "", ...o });

  it("reads the key, the whole-number quantity and the note", () => {
    const r = buildStockItems(
      [row({ SKU: "A1", Qty: "12", Note: "Friday" }), row({ SKU: "B2", Qty: "0" })],
      map,
      "sku",
      "count",
    );
    expect(r.errors).toEqual([]);
    expect(r.items).toEqual([
      { ref: "2", rows: [2], key: "A1", qty: 12, note: "Friday" },
      { ref: "3", rows: [3], key: "B2", qty: 0, note: null },
    ]);
  });

  it("uses the barcode column when matching by barcode", () => {
    const r = buildStockItems(
      [row({ SKU: "A1", Barcode: "5390001", Qty: "3" })],
      map,
      "barcode",
      "received",
    );
    expect(r.items[0]).toMatchObject({ key: "5390001", qty: 3 });
  });

  it("lists bad rows with row numbers and keeps the good ones", () => {
    const r = buildStockItems(
      [
        row({ SKU: "A1", Qty: "5" }),
        row({ SKU: "", Qty: "5" }), // no key
        row({ SKU: "B1", Qty: "12.5" }),
        row({ SKU: "B2", Qty: "-3" }),
        row({ SKU: "B3", Qty: "abc" }),
        row({ SKU: "B4", Qty: "" }),
        row({ SKU: "B5", Qty: "1e3" }),
        row({ SKU: "B6", Qty: "5", Note: "x".repeat(201) }),
        row({ SKU: "A1", Qty: "9" }), // repeated key: the first row wins
        row({ SKU: "x".repeat(65), Qty: "1" }),
      ],
      map,
      "sku",
      "count",
    );
    expect(r.items.map((i) => i.key)).toEqual(["A1"]);
    expect(r.errors.map((e) => [e.row, e.field])).toEqual([
      [3, "sku"],
      [4, "quantity"],
      [5, "quantity"],
      [6, "quantity"],
      [7, "quantity"],
      [8, "quantity"],
      [9, "notes"],
      [10, "sku"],
      [11, "sku"],
    ]);
  });

  it("a delivery must be at least 1, a count may be 0", () => {
    expect(
      buildStockItems([row({ SKU: "A", Qty: "0" })], map, "sku", "received").errors,
    ).toHaveLength(1);
    expect(buildStockItems([row({ SKU: "A", Qty: "0" })], map, "sku", "count").errors).toHaveLength(
      0,
    );
  });

  it("does not read a column named like an Object method", () => {
    const r = buildStockItems(
      [{ SKU: "A", Qty: "1" }],
      { sku: "constructor", quantity: "Qty" },
      "sku",
      "count",
    );
    expect(r.items).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });
});

describe("buildCustomerItems", () => {
  const map: Mapping = {
    name: "Name",
    email: "Email",
    phone: "Phone",
    vatNumber: "VAT",
    address: "Address",
    notes: "Notes",
  };
  const row = (o: Record<string, string>) => ({
    Name: "",
    Email: "",
    Phone: "",
    VAT: "",
    Address: "",
    Notes: "",
    ...o,
  });

  it("builds customers with the screen's own rules, lower-casing the email", () => {
    const r = buildCustomerItems(
      ID,
      [row({ Name: " Mary Byrne ", Email: "Mary@Example.COM", Phone: "087 123 4567" })],
      map,
    );
    expect(r.errors).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      ref: "2",
      rows: [2],
      key: "mary@example.com",
      fields: {
        name: "Mary Byrne",
        email: "mary@example.com",
        phone: "087 123 4567",
        vat_number: null,
        address: null,
        notes: null,
      },
      set: ["phone"],
    });
  });

  it("lists only the fields the file gave a value for (an update leaves the rest alone)", () => {
    const r = buildCustomerItems(ID, [row({ Name: "A", Address: "1 Main St", Notes: "n" })], map);
    expect(r.items[0]!.set).toEqual(["address", "notes"]);
  });

  it("has no consent column: a customer never gets marketing consent from a file", () => {
    const r = buildCustomerItems(ID, [row({ Name: "A" })], {
      ...map,
      ...({ consent: "Consent" } as unknown as Mapping),
    });
    expect(JSON.stringify(r.items[0])).not.toMatch(/consent/i);
  });

  it("refuses bad rows with a plain message per field and keeps the good ones", () => {
    const r = buildCustomerItems(
      ID,
      [
        row({ Name: "Good", Email: "good@example.com" }),
        row({ Name: "" }),
        row({ Name: "N".repeat(121) }),
        row({ Name: "Bad email", Email: "not-an-email" }),
        row({ Name: "Bad VAT", VAT: "12" }),
        row({ Name: "Long phone", Phone: "1".repeat(31) }),
        row({ Name: "Long notes", Notes: "n".repeat(501) }),
        row({ Name: "Dup", Email: "GOOD@example.com" }),
      ],
      map,
    );
    expect(r.items.map((i) => i.fields.name)).toEqual(["Good"]);
    expect(r.errors.map((e) => [e.row, e.field])).toEqual([
      [3, "name"],
      [4, "name"],
      [5, "email"],
      [6, "vatNumber"],
      [7, "phone"],
      [8, "notes"],
      [9, "email"],
    ]);
    expect(r.errors.find((e) => e.row === 5)!.message).toBe("Enter a valid email address.");
    expect(r.errors.find((e) => e.row === 9)!.message).toContain("row 2");
  });

  it("accepts an Irish or EU VAT number and rows without an email", () => {
    const r = buildCustomerItems(
      ID,
      [row({ Name: "Acme", VAT: "IE6388047V" }), row({ Name: "Walk-in" })],
      map,
    );
    expect(r.errors).toEqual([]);
    expect(r.items.map((i) => i.key)).toEqual([null, null]);
    expect(r.items[0]!.fields.vat_number).toBe("IE6388047V");
  });

  it("gives the same ids for the same import and row (a retried batch finds its own work)", () => {
    const a = buildCustomerItems(ID, [row({ Name: "A" })], map).items[0]!.id;
    const b = buildCustomerItems(ID, [row({ Name: "A" })], map).items[0]!.id;
    const c = buildCustomerItems("0197f3a0-0000-7000-8000-000000000002", [row({ Name: "A" })], map)
      .items[0]!.id;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
