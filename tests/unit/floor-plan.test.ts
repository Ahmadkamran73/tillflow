import { describe, expect, it } from "vitest";
import {
  canPlace,
  firstFreeSpot,
  GRID,
  hasDuplicateNames,
  hasOverlap,
  overlaps,
  planSchema,
  type PlanFloor,
  type PlanTable,
} from "@/lib/restaurant/floor-plan";
import { parseDiscountLimit } from "@/lib/device/discount-limit";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const table = (n: number, over: Partial<PlanTable> = {}): PlanTable => ({
  id: id(n),
  name: `T${n}`,
  seats: 4,
  shape: "square",
  x: 0,
  y: 0,
  w: 2,
  h: 2,
  ...over,
});
const floor = (tables: PlanTable[]): PlanFloor => ({ id: id(99), name: "Ground", sort: 0, tables });

describe("floor plan rules", () => {
  it("boxes overlap only when they share a cell", () => {
    expect(overlaps({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
    expect(overlaps({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 2, w: 2, h: 2 })).toBe(false);
  });
  it("a table stays inside the canvas and off its neighbours, but may stay where it is", () => {
    const f = floor([table(1), table(2, { x: 3 })]);
    expect(canPlace(f, id(1), { x: 0, y: 0, w: 2, h: 2 })).toBe(true);
    expect(canPlace(f, id(1), { x: 2, y: 0, w: 2, h: 2 })).toBe(false); // onto T2? x 2..4 vs 3..5
    expect(canPlace(f, id(1), { x: -1, y: 0, w: 2, h: 2 })).toBe(false);
    expect(canPlace(f, id(1), { x: GRID.cols - 1, y: 0, w: 2, h: 2 })).toBe(false);
    expect(canPlace(f, id(1), { x: 0, y: GRID.rows - 1, w: 2, h: 2 })).toBe(false);
  });
  it("finds the first free spot, and none when the floor is full", () => {
    expect(firstFreeSpot(floor([]))).toEqual({ x: 0, y: 0 });
    expect(firstFreeSpot(floor([table(1)]))).toEqual({ x: 2, y: 0 });
    const full = floor(
      Array.from({ length: (GRID.cols / 2) * (GRID.rows / 2) }, (_, i) =>
        table(i + 1, { x: (i % (GRID.cols / 2)) * 2, y: Math.floor(i / (GRID.cols / 2)) * 2 }),
      ),
    );
    expect(firstFreeSpot(full)).toBeNull();
  });
  it("catches duplicate names (ignoring case) and overlapping tables in a plan", () => {
    expect(hasDuplicateNames([floor([table(1), table(2, { name: "t1", x: 3 })])])).toBe(true);
    expect(hasDuplicateNames([floor([table(1), table(2, { x: 3 })])])).toBe(false);
    expect(hasOverlap([floor([table(1), table(2, { x: 1 })])])).toBe(true);
    expect(hasOverlap([floor([table(1), table(2, { x: 3 })])])).toBe(false);
    const a = { ...floor([]), id: id(97), name: "A" };
    const b = { ...floor([]), id: id(98), name: "a" };
    expect(hasDuplicateNames([a, b])).toBe(true);
  });
  it("the schema refuses bad shapes, sizes, seats and unknown keys", () => {
    const ok = [floor([table(1)])];
    expect(planSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { seats: 0 },
      { seats: 31 },
      { shape: "star" },
      { w: 9 },
      { x: 60 },
      { name: " " },
    ])
      expect(planSchema.safeParse([floor([table(1, bad as Partial<PlanTable>)])]).success).toBe(
        false,
      );
    expect(planSchema.safeParse([{ ...ok[0], extra: 1 }]).success).toBe(false);
    expect(planSchema.safeParse(Array(11).fill(ok[0])).success).toBe(false);
  });
});

describe("service charge percent", () => {
  it("reads whole and two-decimal percents exactly", () => {
    expect(parseDiscountLimit("12.5")).toBe(1250);
    expect(parseDiscountLimit("0")).toBe(0);
    expect(parseDiscountLimit("10,25")).toBe(1025);
    expect(parseDiscountLimit("abc")).toBeNull();
  });
});
