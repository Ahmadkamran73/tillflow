import "server-only";
import { createSupabaseServerClient } from "@/lib/auth";
import { planSchema, type Plan } from "./floor-plan";

/** The live floors and tables of a shop, read through RLS (any member). */
export async function getFloorPlan(orgId: string): Promise<Plan> {
  const supabase = await createSupabaseServerClient();
  const [floors, tables] = await Promise.all([
    supabase
      .from("floors")
      .select("id, name, sort")
      .eq("org_id", orgId)
      .is("archived_at", null)
      .order("sort")
      .order("name"),
    supabase
      .from("restaurant_tables")
      .select("id, floor_id, name, seats, shape, x, y, w, h")
      .eq("org_id", orgId)
      .is("archived_at", null)
      .order("name"),
  ]);
  if (floors.error || tables.error) throw new Error("Could not load the floor plan");
  return planSchema.parse(
    (floors.data ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      sort: f.sort,
      tables: (tables.data ?? [])
        .filter((t) => t.floor_id === f.id)
        .map((t) => ({
          id: t.id,
          name: t.name,
          seats: t.seats,
          shape: t.shape,
          x: t.x,
          y: t.y,
          w: t.w,
          h: t.h,
        })),
    })),
  );
}
