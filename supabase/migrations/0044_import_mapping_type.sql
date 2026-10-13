ALTER TABLE "import_mappings" DROP CONSTRAINT "import_mappings_org_name_key";--> statement-breakpoint
ALTER TABLE "import_mappings" ADD COLUMN "type" text DEFAULT 'products' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_org_type_name_key" UNIQUE("org_id","type","name");--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_type" CHECK ("import_mappings"."type" in ('products','stock','customers'));