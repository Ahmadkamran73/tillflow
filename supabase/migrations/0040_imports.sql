CREATE TABLE "import_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"opening_stock" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "import_changes_import_variant_key" UNIQUE("import_id","variant_id"),
	CONSTRAINT "import_changes_action" CHECK ("import_changes"."action" in ('created','updated'))
);
--> statement-breakpoint
CREATE TABLE "import_files" (
	"import_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"bytes" "bytea" NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	CONSTRAINT "import_files_size" CHECK (octet_length("import_files"."bytes") <= 10485760)
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"type" text DEFAULT 'products' NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"mode" text DEFAULT 'create' NOT NULL,
	"match_key" text DEFAULT 'sku' NOT NULL,
	"file_name" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"batch_id" uuid NOT NULL,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"undo_until" timestamp with time zone,
	"undone_at" timestamp with time zone,
	CONSTRAINT "import_jobs_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "import_jobs_type" CHECK ("import_jobs"."type" in ('products')),
	CONSTRAINT "import_jobs_status" CHECK ("import_jobs"."status" in ('uploaded','queued','running','done','failed','undone')),
	CONSTRAINT "import_jobs_mode" CHECK ("import_jobs"."mode" in ('create','upsert')),
	CONSTRAINT "import_jobs_match_key" CHECK ("import_jobs"."match_key" in ('sku','barcode')),
	CONSTRAINT "import_jobs_rows" CHECK ("import_jobs"."total_rows" between 0 and 50000),
	CONSTRAINT "import_jobs_file_name" CHECK (char_length("import_jobs"."file_name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "import_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_mappings_org_name_key" UNIQUE("org_id","name"),
	CONSTRAINT "import_mappings_name" CHECK (char_length(btrim("import_mappings"."name")) between 1 and 60),
	CONSTRAINT "import_mappings_size" CHECK (octet_length("import_mappings"."mapping"::text) <= 8000)
);
--> statement-breakpoint
ALTER TABLE "import_changes" ADD CONSTRAINT "import_changes_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_changes" ADD CONSTRAINT "import_changes_org_import_fk" FOREIGN KEY ("org_id","import_id") REFERENCES "public"."import_jobs"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_org_import_fk" FOREIGN KEY ("org_id","import_id") REFERENCES "public"."import_jobs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_files_expires_idx" ON "import_files" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "import_jobs_org_created_idx" ON "import_jobs" USING btree ("org_id","created_at");