import { notFound } from "next/navigation";
import { presets } from "@/config/business-type-presets";
import { requireRole } from "@/lib/auth";
import { getLocation, getTaxRates, listModifierGroups } from "@/lib/catalog";
import { getOrganisation, listCategories } from "@/lib/org";

/** Everything the product form needs besides the product itself. Shared by new and edit. */
export async function loadProductFormContext(orgId: string) {
  await requireRole(["owner", "manager"], orgId);
  const org = await getOrganisation(orgId);
  const location = await getLocation(orgId);
  if (!org || !location) notFound();
  const wantsGroups = presets[org.businessType].productFields.includes("modifiers");
  const [categories, rates, groups] = await Promise.all([
    listCategories(orgId),
    getTaxRates(),
    wantsGroups ? listModifierGroups(orgId) : Promise.resolve([]),
  ]);
  return {
    businessType: org.businessType,
    timeZone: location.timezone,
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    rates,
  };
}
