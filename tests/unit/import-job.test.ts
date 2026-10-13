// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const db = {
  importApplyBatch: vi.fn(),
  importApplyStock: vi.fn(),
  importApplyCustomers: vi.fn(),
  importBegin: vi.fn(),
  importFile: vi.fn(),
  importFinish: vi.fn(),
  importPurge: vi.fn(),
};
vi.mock("@/lib/ops/db", () => db);

const { runProductImport } = await import("@/lib/jobs/handlers/imports");

const IDS = {
  import_id: "0197f3a0-0000-7000-8000-000000000001",
  org_id: "0197f3a0-0000-7000-8000-0000000000a1",
  user_id: "0197f3a0-0000-7000-8000-0000000000b1",
};
const start = (over: Record<string, unknown> = {}) => ({
  org_id: IDS.org_id,
  mode: "create",
  match_key: "sku",
  mapping: { name: "Name", price: "Price", sku: "SKU" },
  file_name: "p.csv",
  total_rows: 0,
  business_type: "general",
  ...over,
});
const csv = (rows: number, bad: number[] = []) =>
  Buffer.from(
    "Name,Price,SKU\n" +
      Array.from(
        { length: rows },
        (_, i) => `Item ${i},${bad.includes(i) ? "x" : "1.50"},S${i}`,
      ).join("\n"),
  );

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  db.importApplyBatch.mockImplementation(async (b: { items: { ref: string }[] }) =>
    b.items.map((i) => ({ ref: i.ref, status: "ok" })),
  );
  for (const fn of [db.importApplyStock, db.importApplyCustomers])
    fn.mockImplementation(async (b: { items: { ref: string }[] }) =>
      b.items.map((i) => ({ ref: i.ref, status: "ok" })),
    );
});

describe("import-products job", () => {
  it("sends valid rows in batches of 500 and finishes with the problem rows", async () => {
    db.importBegin.mockResolvedValue(start());
    db.importFile.mockResolvedValue(csv(1_200, [3, 700]));
    await runProductImport(IDS);

    const sizes = db.importApplyBatch.mock.calls.map((c) => c[0].items.length);
    expect(sizes).toEqual([500, 500, 198]);
    expect(db.importApplyBatch.mock.calls[0]![0]).toMatchObject({
      import_id: IDS.import_id,
      user_id: IDS.user_id,
    });
    const [, ok, errorCount, errors, failure] = db.importFinish.mock.calls[0]!;
    expect([ok, errorCount, failure]).toEqual([true, 2, null]);
    expect(errors.map((e: { row: number }) => e.row)).toEqual([5, 702]);
  });

  it("turns a database refusal into error rows for that product, and goes on", async () => {
    db.importBegin.mockResolvedValue(start());
    db.importFile.mockResolvedValue(csv(3));
    db.importApplyBatch.mockImplementation(async (b: { items: { ref: string }[] }) =>
      b.items.map((i) =>
        i.ref === "3"
          ? { ref: i.ref, status: "error", code: "23505" }
          : { ref: i.ref, status: "ok" },
      ),
    );
    await runProductImport(IDS);
    const [, ok, errorCount, errors] = db.importFinish.mock.calls[0]!;
    expect(ok).toBe(true);
    expect(errorCount).toBe(1);
    expect(errors[0]).toMatchObject({ row: 3 });
    expect(errors[0].message).toMatch(/SKU or barcode/);
  });

  it("does nothing when the import is not queued, and refuses another shop's import", async () => {
    db.importBegin.mockResolvedValue(null);
    await runProductImport(IDS);
    expect(db.importFile).not.toHaveBeenCalled();
    db.importBegin.mockResolvedValue(start({ org_id: "0197f3a0-0000-7000-8000-0000000000ff" }));
    await expect(runProductImport(IDS)).rejects.toThrow();
    expect(db.importApplyBatch).not.toHaveBeenCalled();
  });

  it("fails cleanly when the file was already purged or is not importable (.sql never runs)", async () => {
    db.importBegin.mockResolvedValue(start());
    db.importFile.mockResolvedValue(null);
    await runProductImport(IDS);
    expect(db.importFinish).toHaveBeenLastCalledWith(IDS.import_id, false, 0, [], "file_expired");

    db.importBegin.mockResolvedValue(start({ file_name: "dump.sql" }));
    db.importFile.mockResolvedValue(Buffer.from("insert into products values (1);"));
    await expect(runProductImport(IDS)).rejects.toThrow();
    expect(db.importFinish).toHaveBeenLastCalledWith(
      IDS.import_id,
      false,
      0,
      [],
      "unexpected_error",
    );
    expect(db.importApplyBatch).not.toHaveBeenCalled();
  });

  it("marks the import failed when the database goes away mid-way", async () => {
    db.importBegin.mockResolvedValue(start());
    db.importFile.mockResolvedValue(csv(10));
    db.importApplyBatch.mockRejectedValue(new Error("connection lost"));
    await expect(runProductImport(IDS)).rejects.toThrow("connection lost");
    expect(db.importFinish).toHaveBeenLastCalledWith(
      IDS.import_id,
      false,
      0,
      [],
      "unexpected_error",
    );
  });
});

describe("import-products job: a 10,000 row file", () => {
  it("runs it as 20 batches of 500 with every product sent once", async () => {
    db.importBegin.mockResolvedValue(start());
    db.importFile.mockResolvedValue(csv(10_000, [7]));
    await runProductImport(IDS);
    const sent = db.importApplyBatch.mock.calls.flatMap((c) => c[0].items as { ref: string }[]);
    expect(db.importApplyBatch).toHaveBeenCalledTimes(20);
    expect(sent).toHaveLength(9_999);
    expect(new Set(sent.map((i) => i.ref)).size).toBe(9_999);
    const [, ok, errorCount] = db.importFinish.mock.calls[0]!;
    expect([ok, errorCount]).toEqual([true, 1]);
  });
});

describe("import job: stock and customers", () => {
  it("sends a stock file to import_apply_stock only, with the mode and key", async () => {
    db.importBegin.mockResolvedValue(
      start({
        type: "stock",
        mode: "received",
        match_key: "barcode",
        mapping: { barcode: "Code", quantity: "Qty" },
      }),
    );
    db.importFile.mockResolvedValue(Buffer.from("Code,Qty\n5390001,4\n5390002,x\n5390003,2"));
    await runProductImport(IDS);
    expect(db.importApplyBatch).not.toHaveBeenCalled();
    expect(db.importApplyCustomers).not.toHaveBeenCalled();
    const items = db.importApplyStock.mock.calls.flatMap((c) => c[0].items);
    expect(items.map((i: { key: string; qty: number }) => [i.key, i.qty])).toEqual([
      ["5390001", 4],
      ["5390003", 2],
    ]);
    const [, ok, errorCount, errors] = db.importFinish.mock.calls[0]!;
    expect([ok, errorCount, errors[0].row]).toEqual([true, 1, 3]);
  });

  it("maps a missing product to a row error", async () => {
    db.importBegin.mockResolvedValue(
      start({ type: "stock", mode: "count", mapping: { sku: "SKU", quantity: "Qty" } }),
    );
    db.importFile.mockResolvedValue(Buffer.from("SKU,Qty\nA,1\nB,2"));
    db.importApplyStock.mockImplementation(async (b: { items: { ref: string }[] }) =>
      b.items.map((i) =>
        i.ref === "3"
          ? { ref: i.ref, status: "error", code: "P0002" }
          : { ref: i.ref, status: "ok" },
      ),
    );
    await runProductImport(IDS);
    const [, ok, errorCount, errors] = db.importFinish.mock.calls[0]!;
    expect([ok, errorCount, errors[0].row]).toEqual([true, 1, 3]);
  });

  it("sends a customers file to import_apply_customers only, and never logs its content", async () => {
    db.importBegin.mockResolvedValue(
      start({
        type: "customers",
        mode: "upsert",
        match_key: "email",
        mapping: { name: "Name", email: "Email" },
      }),
    );
    db.importFile.mockResolvedValue(
      Buffer.from("Name,Email\nMary,mary@example.com\n,nobody@example.com"),
    );
    await runProductImport(IDS);
    expect(db.importApplyBatch).not.toHaveBeenCalled();
    expect(db.importApplyStock).not.toHaveBeenCalled();
    const items = db.importApplyCustomers.mock.calls.flatMap((c) => c[0].items);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("mary@example.com");
    const [, ok, errorCount, errors] = db.importFinish.mock.calls[0]!;
    expect([ok, errorCount, errors[0].row]).toEqual([true, 1, 3]);
    // the stored problem list names rows and fields, never the values
    expect(JSON.stringify(errors)).not.toContain("nobody@example.com");
  });
});
