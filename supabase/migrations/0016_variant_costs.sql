CREATE TABLE "variant_costs" (
	"variant_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"cost_cents" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_costs_range" CHECK ("variant_costs"."cost_cents" between 0 and 100000000)
);
--> statement-breakpoint
-- Closed from the first moment: no client role can touch it until 0017 adds the policies.
ALTER TABLE "variant_costs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "variant_costs" FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE "variants" DROP CONSTRAINT "variants_cost_range";--> statement-breakpoint
ALTER TABLE "variant_costs" ADD CONSTRAINT "variant_costs_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_costs" ADD CONSTRAINT "variant_costs_org_variant_fk" FOREIGN KEY ("org_id","variant_id") REFERENCES "public"."variants"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "variant_costs_org_idx" ON "variant_costs" USING btree ("org_id");--> statement-breakpoint
-- Keep the existing cost prices: move them before the column goes.
INSERT INTO "variant_costs" ("variant_id", "org_id", "cost_cents") SELECT "id", "org_id", "cost_cents" FROM "variants" WHERE "cost_cents" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "variants" DROP COLUMN "cost_cents";