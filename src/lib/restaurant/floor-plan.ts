import { z } from "zod";

// The floor plan of a restaurant (docs/specs/restaurant.md): floors with tables placed on a grid of
// cells. Pure helpers shared by the back-office editor and the save action, so both apply the same
// rules the database checks again (public.save_floor_plan).

/** The editor canvas. The database allows a larger grid (60 x 40); the editor offers this one. */
export const GRID = { cols: 24, rows: 16 } as const;
export const SHAPES = ["square", "round", "rect"] as const;

export const planTable = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(20),
  seats: z.int().min(1).max(30),
  shape: z.enum(SHAPES),
  x: z.int().min(0).max(59),
  y: z.int().min(0).max(39),
  w: z.int().min(1).max(8),
  h: z.int().min(1).max(8),
});
export const planFloor = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(40),
  sort: z.int().min(0).max(100),
  tables: z.array(planTable).max(60),
});
export const planSchema = z.array(planFloor).max(10);

export type PlanTable = z.infer<typeof planTable>;
export type PlanFloor = z.infer<typeof planFloor>;
export type Plan = z.infer<typeof planSchema>;

type Box = Pick<PlanTable, "x" | "y" | "w" | "h">;

/** Do two boxes share a grid cell? */
export const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Can `box` sit on this floor (inside the canvas, clear of every other table)? */
export function canPlace(floor: PlanFloor, id: string, box: Box): boolean {
  if (box.x < 0 || box.y < 0 || box.x + box.w > GRID.cols || box.y + box.h > GRID.rows)
    return false;
  return floor.tables.every((t) => t.id === id || !overlaps(t, box));
}

/** The first free spot (left to right, top to bottom) for a new table, or null if the floor is full. */
export function firstFreeSpot(floor: PlanFloor, w = 2, h = 2): { x: number; y: number } | null {
  for (let y = 0; y + h <= GRID.rows; y++)
    for (let x = 0; x + w <= GRID.cols; x++)
      if (canPlace(floor, "", { x, y, w, h })) return { x, y };
  return null;
}

/** Floors and tables must have unique names (ignoring case) within their level. */
export function hasDuplicateNames(plan: Plan): boolean {
  const dup = (names: string[]) =>
    new Set(names.map((n) => n.trim().toLowerCase())).size < names.length;
  return dup(plan.map((f) => f.name)) || plan.some((f) => dup(f.tables.map((t) => t.name)));
}

/** Does any floor have two tables on the same cell? */
export const hasOverlap = (plan: Plan): boolean =>
  plan.some((f) => f.tables.some((a, i) => f.tables.slice(i + 1).some((b) => overlaps(a, b))));
