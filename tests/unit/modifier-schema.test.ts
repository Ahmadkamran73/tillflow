import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { parseModifierGroupForm, type RawModifierGroup } from "@/lib/modifier-schema";

const group = (patch: Partial<RawModifierGroup> = {}): RawModifierGroup => ({
  groupId: uuidv7(),
  name: "Milk",
  min: "0",
  max: "1",
  options: [
    { id: uuidv7(), name: "Oat", price: "0.50" },
    { id: uuidv7(), name: "Dairy", price: "" },
  ],
  ...patch,
});

describe("parseModifierGroupForm", () => {
  it("parses a valid group into cents", () => {
    const r = parseModifierGroupForm(group());
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.group).toMatchObject({ name: "Milk", min_choices: 0, max_choices: 1 });
    expect(r.data.options.map((o) => o.price_delta_cents)).toEqual([50, 0]);
  });

  it("allows a negative price delta", () => {
    const r = parseModifierGroupForm(
      group({ options: [{ id: uuidv7(), name: "Small", price: "-0.20" }] }),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.options[0]!.price_delta_cents).toBe(-20);
  });

  it("rejects bad names, choice counts, option counts, prices and duplicate options", () => {
    const bad = (g: RawModifierGroup) => {
      const r = parseModifierGroupForm(g);
      if (r.ok) throw new Error("expected errors");
      return Object.keys(r.fieldErrors);
    };
    expect(bad(group({ name: " " }))).toContain("name");
    expect(bad(group({ min: "2", max: "1" }))).toContain("max");
    expect(bad(group({ min: "x" }))).toContain("min");
    expect(bad(group({ max: "21" }))).toContain("max");
    expect(bad(group({ options: [] }))).toContain("options");
    expect(bad(group({ options: [{ id: uuidv7(), name: "A", price: "1,5" }] }))).toContain(
      "options.0.price",
    );
    expect(
      bad(
        group({
          options: [
            { id: uuidv7(), name: "A", price: "" },
            { id: uuidv7(), name: "a", price: "" },
          ],
        }),
      ),
    ).toContain("options.1.name");
    expect(parseModifierGroupForm({ nope: true }).ok).toBe(false);
  });
});
