CREATE TABLE "account_export_files" (
	"export_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"bytes" "bytea" NOT NULL,
	CONSTRAINT "account_export_files_size" CHECK (octet_length("account_export_files"."bytes") <= 157286400)
);
--> statement-breakpoint
CREATE TABLE "account_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"file_name" text,
	"size_bytes" integer,
	"error_code" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "account_exports_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "account_exports_status" CHECK ("account_exports"."status" in ('queued', 'running', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "account_export_files" ADD CONSTRAINT "account_export_files_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_export_files" ADD CONSTRAINT "account_export_files_org_export_fk" FOREIGN KEY ("org_id","export_id") REFERENCES "public"."account_exports"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_exports" ADD CONSTRAINT "account_exports_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_exports_org_requested_idx" ON "account_exports" USING btree ("org_id","requested_at");