// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { settingsProblem } from "@/lib/import/settings";
import { buildSupplierItems } from "@/lib/import/validate-suppliers";

vi.mock("server-only", () => ({}));
const db = {
  importApplyBatch: vi.fn(),
  importApplyStock: vi.fn(),
  importApplyCustomers: vi.fn(),
  importApplySuppliers: vi.fn(),
  importBegin: vi.fn(),
  importFile: vi.fn(),
  importFinish: vi.fn(),
  importPurge: vi.fn(),
};
vi.mock("@/lib/ops/db", () => db);
const { runImport } = await import("@/lib/jobs/handlers/imports");

const ID = "0197f3a0-0000-7000-8000-000000000001";
const IDS = {
  import_id: ID,
  org_id: "0197f3a0-0000-7000-8000-0000000000a1",
  user_id: "0197f3a0-0000-7000-8000-0000000000b1",
};

describe("supplier import: fields and settings", () => {
  it("is a fourth kind with name-based matching", () => {
    expect([...IMPORT_TYPES]).toContain("suppliers");
    expect(importFieldsFor("suppliers", "general")).toEqual([
      "name",
      "email",
      "phone",
      "vatNumber",
      "address",
      "notes",
    ]);
    expect(MATCH_KEYS.suppliers).toEqual(["name"]);
    expect(MODES.suppliers).toEqual(["create", "upsert"]);
    expect(requiredFor("suppliers")).toEqual(["name"]);
    expect(templateRows("general", "suppliers")[1]![0]).toBe("Dairy Direct Ltd");
    expect(
      autoMatch(["Supplier Name", "E-mail", "Tel"], null, importFieldsFor("suppliers", "general")),
    ).toMatchObject({
      name: "Supplier Name",
    });
  });

  it("needs only the name; upsert needs no extra column; keys of other kinds are refused", () => {
    const base = { mode: "upsert" as const, matchKey: "name" as const };
    expect(settingsProblem("suppliers", { ...base, mapping: {} })).toBe(
      "import.err.requiredSuppliers",
    );
    expect(settingsProblem("suppliers", { ...base, mapping: { name: "N" } })).toBeNull();
    expect(
      settingsProblem("suppliers", { mode: "create", matchKey: "email", mapping: { name: "N" } }),
    ).toBe("import.err.generic");
    expect(
      settingsProblem("suppliers", { mode: "count", matchKey: "name", mapping: { name: "N" } }),
    ).toBe("import.err.generic");
    expect(
      settingsProblem("customers", { mode: "create", matchKey: "name", mapping: { name: "N" } }),
    ).toBe("import.err.generic");
  });
});

describe("buildSupplierItems", () => {
  const map: Mapping = {
    name: "Name",
    email: "Email",
    phone: "Phone",
    vatNumber: "VAT",
    notes: "Notes",
  };
  const row = (o: Record<string, string>) => ({
    Name: "",
    Email: "",
    Phone: "",
    VAT: "",
    Notes: "",
    ...o,
  });

  it("keys a supplier by its trimmed lower-case name and lists the fields the file gave", () => {
    const r = buildSupplierItems(ID, [row({ Name: "  Dairy Direct LTD ", Phone: "021 1" })], map);
    expect(r.errors).toEqual([]);
    expect(r.items[0]).toMatchObject({
      ref: "2",
      key: "dairy direct ltd",
      fields: { name: "Dairy Direct LTD", phone: "021 1", email: null },
      set: ["phone"],
    });
  });

  it("lists bad rows by row and field; the same name twice: the first wins; no email needed", () => {
    const r = buildSupplierItems(
      ID,
      [
        row({ Name: "Good" }),
        row({ Name: "" }),
        row({ Name: "Bad mail", Email: "nope" }),
        row({ Name: "Bad VAT", VAT: "12" }),
        row({ Name: "GOOD" }),
        row({ Name: "N".repeat(121) }),
      ],
      map,
    );
    expect(r.items.map((i) => i.key)).toEqual(["good"]);
    expect(r.errors.map((e) => [e.row, e.field])).toEqual([
      [3, "name"],
      [4, "email"],
      [5, "vatNumber"],
      [6, "name"],
      [7, "name"],
    ]);
    expect(r.errors.find((e) => e.row === 6)!.message).toContain("row 2");
  });

  it("gives stable ids per import and row, and differs from the customer ids", () => {
    const a = buildSupplierItems(ID, [row({ Name: "A" })], map).items[0]!.id;
    expect(buildSupplierItems(ID, [row({ Name: "A" })], map).items[0]!.id).toBe(a);
    expect(
      buildSupplierItems("0197f3a0-0000-7000-8000-000000000002", [row({ Name: "A" })], map)
        .items[0]!.id,
    ).not.toBe(a);
  });
});

describe("import job: suppliers", () => {
  beforeEach(() => {
    for (const fn of Object.values(db)) fn.mockReset();
    db.importApplySuppliers.mockImplementation(async (b: { items: { ref: string }[] }) =>
      b.items.map((i) => ({ ref: i.ref, status: "ok" })),
    );
  });

  it("sends a suppliers file to import_apply_suppliers only and never puts values in the problem list", async () => {
    db.importBegin.mockResolvedValue({
      org_id: IDS.org_id,
      type: "suppliers",
      mode: "upsert",
      match_key: "name",
      mapping: { name: "Name", email: "Email" },
      file_name: "s.csv",
      total_rows: 3,
      business_type: "general",
    });
    db.importFile.mockResolvedValue(
      Buffer.from("Name,Email\nDairy Direct,a@dairy.example\n,x@secret.example\nBad,nope"),
    );
    await runImport(IDS);
    expect(db.importApplyBatch).not.toHaveBeenCalled();
    expect(db.importApplyStock).not.toHaveBeenCalled();
    expect(db.importApplyCustomers).not.toHaveBeenCalled();
    const items = db.importApplySuppliers.mock.calls.flatMap((c) => c[0].items);
    expect(items.map((i: { key: string }) => i.key)).toEqual(["dairy direct"]);
    const [, ok, errorCount, errors] = db.importFinish.mock.calls[0]!;
    expect([ok, errorCount]).toEqual([true, 2]);
    expect(JSON.stringify(errors)).not.toContain("secret.example");
  });

  it("turns a database refusal into a row error that names no value", async () => {
    db.importBegin.mockResolvedValue({
      org_id: IDS.org_id,
      type: "suppliers",
      mode: "create",
      match_key: "name",
      mapping: { name: "Name" },
      file_name: "s.csv",
      total_rows: 1,
      business_type: "general",
    });
    db.importFile.mockResolvedValue(Buffer.from("Name\nSolo Trader Mary"));
    db.importApplySuppliers.mockImplementation(async (b: { items: { ref: string }[] }) =>
      b.items.map((i) => ({ ref: i.ref, status: "error", code: "23505" })),
    );
    await runImport(IDS);
    const [, , errorCount, errors] = db.importFinish.mock.calls[0]!;
    expect(errorCount).toBe(1);
    expect(errors[0].message).toMatch(/supplier with this name already exists/);
    expect(JSON.stringify(errors)).not.toContain("Mary");
  });
});
