// @vitest-environment node
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail, ops } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  ops: {
    accountExportBegin: vi.fn(),
    accountExportRows: vi.fn(),
    accountExportFinish: vi.fn(),
    accountExportFail: vi.fn(),
    accountExportMailData: vi.fn(),
    accountExportOwnerEmails: vi.fn(),
    accountExportPurge: vi.fn(),
    rebuildDirtySummaries: vi.fn(),
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", () => ({ sendMail: (m: unknown) => sendMail(m) }));
vi.mock("@/lib/ops/db", () => ops);

import { ACCOUNT_TABLES, ExportTooLarge, buildAccountZip } from "@/lib/export/account-zip";
import { accountExportJob, summaryJob } from "@/lib/jobs/handlers/reports";

/** Reads a stored or deflated zip back: name -> text. Small enough to trust for tests. */
function unzip(zip: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("ascii");
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + size);
    out[name] = (method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
    p += 46 + nameLen;
  }
  return out;
}

const meta = { shop: "Corner Shop", madeAt: "2026-10-14T10:00:00.000Z" };

describe("account ZIP", () => {
  it("has one CSV per table plus README and manifest, with escaped cells and exact cents", async () => {
    const zip = await buildAccountZip(async (table, offset) => {
      if (offset > 0) return [];
      if (table === "customers")
        return [
          { id: "c1", name: '=HYPERLINK("http://x")', email: null, notes: "a,b\nc" },
          { id: "c2", name: "Ann", email: "ann@example.com", notes: null },
        ];
      if (table === "sales")
        return [{ id: "s1", amount_due_cents: 1230, review_flags: ["old_prices"] }];
      return [];
    }, meta);
    const files = unzip(zip);
    expect(Object.keys(files).sort()).toEqual(
      [...ACCOUNT_TABLES.map((t) => `${t}.csv`), "README.txt", "manifest.json"].sort(),
    );
    expect(files["customers.csv"]).toContain("id,name,email,notes");
    expect(files["customers.csv"]).toContain(`c1,"'=HYPERLINK(""http://x"")",,"a,b\nc"`);
    expect(files["customers.csv"]).toContain("c2,Ann,ann@example.com,");
    expect(files["sales.csv"]).toContain('s1,1230,"[""old_prices""]"');
    expect(files["products.csv"]).toBe("﻿(no rows)\r\n");
    expect(JSON.parse(files["manifest.json"]!)).toMatchObject({
      shop: "Corner Shop",
      rows: { customers: 2, sales: 1, products: 0 },
    });
    expect(files["README.txt"]).toContain("PIN hashes");
  });

  it("reads every page until a short one", async () => {
    const calls: number[] = [];
    await buildAccountZip(async (table, offset, limit) => {
      if (table !== "products") return [];
      calls.push(offset);
      return offset < 5000
        ? Array.from({ length: limit }, (_, i) => ({ id: `p${offset + i}` }))
        : [{ id: "last" }];
    }, meta);
    expect(calls).toEqual([0, 5000]);
  });

  it("stops rather than build a file the database would refuse (compressed size)", async () => {
    // Random text does not compress, so it exceeds a 1 KB cap even deflated.
    const noise = randomBytes(2000).toString("hex");
    await expect(
      buildAccountZip(
        async (table, offset) => (table === "products" && offset === 0 ? [{ id: noise }] : []),
        meta,
        1000,
      ),
    ).rejects.toBeInstanceOf(ExportTooLarge);
  });

  it("deflates: repetitive CSV is far smaller than its text, and still reads back exactly", async () => {
    const rows = Array.from({ length: 4000 }, (_, i) => ({
      id: `id-${i}`,
      amount_cents: 1230,
      note: "same",
    }));
    const zip = await buildAccountZip(
      async (table, offset) => (table === "sales" && offset === 0 ? rows : []),
      meta,
    );
    const files = unzip(zip);
    expect(files["sales.csv"]!.split("\r\n")).toHaveLength(4002); // header + rows + trailing blank
    expect(files["sales.csv"]).toContain("id-3999,1230,same");
    expect(zip.length).toBeLessThan(files["sales.csv"]!.length / 3);
  });
});

describe("account export job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ops.accountExportBegin.mockResolvedValue({ org_id: "o1", org_name: "Corner Shop" });
    ops.accountExportRows.mockResolvedValue([]);
    ops.accountExportMailData.mockResolvedValue({
      org_id: "o1",
      org_name: "Corner Shop",
      file_name: "x.zip",
      size_bytes: 2_097_152,
      expires_at: "2026-10-21T10:00:00Z",
      email: "owner@example.com",
    });
    ops.accountExportOwnerEmails.mockResolvedValue({
      org_id: "o1",
      org_name: "Corner Shop",
      requested_at: "2026-10-14T10:00:00Z",
      emails: ["owner@example.com", "second@example.com"],
    });
    sendMail.mockResolvedValue("sent");
  });

  it("builds the ZIP, stores it and emails a link that needs a sign-in", async () => {
    await accountExportJob("e1");
    expect(ops.accountExportFinish).toHaveBeenCalledTimes(1);
    const [id, name, bytes] = ops.accountExportFinish.mock.calls[0]!;
    expect(id).toBe("e1");
    expect(name).toMatch(/^tillflow-data-\d{4}-\d{2}-\d{2}\.zip$/);
    expect((bytes as Buffer).subarray(0, 2).toString()).toBe("PK");
    // Two notices to the owners first, then the "ready" email to the person who asked.
    const sent = sendMail.mock.calls.map(
      (c) => c[0] as { to: string; subject: string; text: string },
    );
    expect(sent.map((m) => m.to)).toEqual([
      "owner@example.com",
      "second@example.com",
      "owner@example.com",
    ]);
    expect(sent[0]!.subject).toContain("was requested");
    expect(sent[0]!.text).toContain("never sent by email");
    expect(sent[0]!.text).not.toMatch(/\.zip|settings\/export/);
    const mail = sent[2]!;
    expect(mail.text).toContain("/o/o1/settings/export");
    expect(mail.text).toContain("2.0 MB");
    expect(mail.text).not.toContain(".zip?"); // no bearer token in the link
  });

  it("does nothing for an export that is finished, unknown or already failed", async () => {
    ops.accountExportBegin.mockResolvedValue(null);
    await accountExportJob("e1");
    expect(ops.accountExportRows).not.toHaveBeenCalled();
    expect(ops.accountExportFinish).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("marks a failure at once and rethrows so it reaches the error log", async () => {
    ops.accountExportRows.mockRejectedValue(new Error("db down"));
    await expect(accountExportJob("e1")).rejects.toThrow("db down");
    expect(ops.accountExportFail).toHaveBeenCalledWith("e1", "failed");
    expect(ops.accountExportFinish).not.toHaveBeenCalled();
  });

  it("a failed owner notice does not stop the export", async () => {
    sendMail.mockResolvedValueOnce("failed").mockResolvedValue("sent");
    await expect(accountExportJob("e1")).resolves.toBeUndefined();
    expect(ops.accountExportFinish).toHaveBeenCalled();
  });

  it("a failed email does not undo a finished export", async () => {
    sendMail.mockResolvedValue("failed");
    await expect(accountExportJob("e1")).resolves.toBeUndefined();
    expect(ops.accountExportFinish).toHaveBeenCalled();
    expect(ops.accountExportFail).not.toHaveBeenCalled();
  });
});

describe("summary job", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rebuilds one day per call until none are left", async () => {
    ops.rebuildDirtySummaries
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    await summaryJob();
    expect(ops.rebuildDirtySummaries).toHaveBeenCalledTimes(3);
    expect(ops.rebuildDirtySummaries).toHaveBeenCalledWith(1, 0);
  });

  it("does not loop for ever on a busy database", async () => {
    ops.rebuildDirtySummaries.mockResolvedValue(1);
    await summaryJob();
    expect(ops.rebuildDirtySummaries).toHaveBeenCalledTimes(300);
  });
});
