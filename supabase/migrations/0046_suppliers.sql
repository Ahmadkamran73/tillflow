CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"vat_number" text,
	"address" text,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "suppliers_name" CHECK (char_length(btrim("suppliers"."name")) between 1 and 120),
	CONSTRAINT "suppliers_email" CHECK ("suppliers"."email" is null or char_length("suppliers"."email") <= 254),
	CONSTRAINT "suppliers_phone" CHECK ("suppliers"."phone" is null or char_length("suppliers"."phone") <= 30),
	CONSTRAINT "suppliers_vat" CHECK ("suppliers"."vat_number" is null or char_length("suppliers"."vat_number") <= 20),
	CONSTRAINT "suppliers_address" CHECK ("suppliers"."address" is null or char_length("suppliers"."address") <= 300),
	CONSTRAINT "suppliers_notes" CHECK ("suppliers"."notes" is null or char_length("suppliers"."notes") <= 500)
);
--> statement-breakpoint
ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_type";--> statement-breakpoint
ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_match_key";--> statement-breakpoint
ALTER TABLE "import_mappings" DROP CONSTRAINT "import_mappings_type";--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_org_name_key" ON "suppliers" USING btree ("org_id",lower(btrim("name"))) WHERE "suppliers"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "suppliers_org_name_idx" ON "suppliers" USING btree ("org_id","name");--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_type" CHECK ("import_jobs"."type" in ('products','stock','customers','suppliers'));--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_match_key" CHECK ("import_jobs"."match_key" in ('sku','barcode','email','name'));--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_type" CHECK ("import_mappings"."type" in ('products','stock','customers','suppliers'));