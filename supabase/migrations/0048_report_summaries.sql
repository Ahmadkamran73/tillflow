CREATE TABLE "daily_sales_summary" (
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"day" date NOT NULL,
	"dim" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"sales_count" integer DEFAULT 0 NOT NULL,
	"qty" bigint DEFAULT 0 NOT NULL,
	"gross_cents" bigint DEFAULT 0 NOT NULL,
	"net_cents" bigint DEFAULT 0 NOT NULL,
	"vat_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"tips_cents" bigint DEFAULT 0 NOT NULL,
	"refund_count" integer DEFAULT 0 NOT NULL,
	"refund_qty" bigint DEFAULT 0 NOT NULL,
	"refund_gross_cents" bigint DEFAULT 0 NOT NULL,
	"refund_net_cents" bigint DEFAULT 0 NOT NULL,
	"refund_vat_cents" bigint DEFAULT 0 NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_sales_summary_org_id_location_id_day_dim_key_pk" PRIMARY KEY("org_id","location_id","day","dim","key"),
	CONSTRAINT "daily_sales_summary_dim" CHECK ("daily_sales_summary"."dim" in ('total', 'hour', 'tender', 'vat_rate', 'category', 'product', 'staff', 'brand', 'size_colour')),
	CONSTRAINT "daily_sales_summary_key_len" CHECK (char_length("daily_sales_summary"."key") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "report_dirty_days" (
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"day" date NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_dirty_days_org_id_location_id_day_pk" PRIMARY KEY("org_id","location_id","day")
);
--> statement-breakpoint
ALTER TABLE "daily_sales_summary" ADD CONSTRAINT "daily_sales_summary_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_sales_summary" ADD CONSTRAINT "daily_sales_summary_org_location_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_dirty_days" ADD CONSTRAINT "report_dirty_days_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_dirty_days" ADD CONSTRAINT "report_dirty_days_org_location_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_sales_summary_org_dim_day_idx" ON "daily_sales_summary" USING btree ("org_id","dim","day");