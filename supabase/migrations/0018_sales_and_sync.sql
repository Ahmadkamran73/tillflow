CREATE TABLE "modifier_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"modifier_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_delta_cents" integer NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"tendered_cents" integer NOT NULL,
	"change_cents" integer NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_method" CHECK ("payments"."method" in ('cash', 'card', 'voucher'))
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text DEFAULT 'item' NOT NULL,
	"variant_id" uuid,
	"product_id" uuid,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"serial" text,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"tax_category" text,
	"tax_rate_bp" integer,
	"net_cents" integer,
	"vat_cents" integer,
	"gross_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_lines_sale_line_key" UNIQUE("sale_id","line_no"),
	CONSTRAINT "sale_lines_kind" CHECK ("sale_lines"."kind" in ('item', 'deposit')),
	CONSTRAINT "sale_lines_qty" CHECK ("sale_lines"."qty" between 1 and 999),
	CONSTRAINT "sale_lines_snapshot" CHECK (("sale_lines"."kind" = 'item' and "sale_lines"."tax_rate_bp" is not null and "sale_lines"."net_cents" is not null and "sale_lines"."vat_cents" is not null and "sale_lines"."tax_category" is not null)
        or ("sale_lines"."kind" = 'deposit' and "sale_lines"."tax_rate_bp" is null))
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"receipt_seq" integer NOT NULL,
	"mode" text DEFAULT 'eat_in' NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"priced_as_of" timestamp with time zone NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"items_total_cents" integer NOT NULL,
	"vat_cents" integer NOT NULL,
	"non_vat_cents" integer NOT NULL,
	"cash_rounding_cents" integer NOT NULL,
	"amount_due_cents" integer NOT NULL,
	"client_due_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "sales_org_register_seq_key" UNIQUE("org_id","register_id","receipt_seq"),
	CONSTRAINT "sales_mode" CHECK ("sales"."mode" in ('eat_in', 'take_away')),
	CONSTRAINT "sales_receipt_seq" CHECK ("sales"."receipt_seq" between 1 and 99999999),
	CONSTRAINT "sales_due_close" CHECK (abs("sales"."amount_due_cents" - "sales"."client_due_cents") <= 1)
);
--> statement-breakpoint
CREATE TABLE "sync_rejections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid,
	"reason" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_rejections_status" CHECK ("sync_rejections"."status" in ('open', 'resolved')),
	CONSTRAINT "sync_rejections_note_len" CHECK ("sync_rejections"."note" is null or char_length("sync_rejections"."note") <= 500),
	CONSTRAINT "sync_rejections_payload_size" CHECK (pg_column_size("sync_rejections"."payload") <= 65536)
);
--> statement-breakpoint
CREATE TABLE "variant_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"price_incl_vat_cents" integer NOT NULL,
	"deposit_cents" integer DEFAULT 0 NOT NULL,
	"tax_category" text NOT NULL,
	"takeaway_tax_category" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_org_id_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "modifier_price_history" ADD CONSTRAINT "modifier_price_history_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_sale_fk" FOREIGN KEY ("org_id","sale_id") REFERENCES "public"."sales"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_org_sale_fk" FOREIGN KEY ("org_id","sale_id") REFERENCES "public"."sales"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_org_variant_fk" FOREIGN KEY ("org_id","variant_id") REFERENCES "public"."variants"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_org_register_fk" FOREIGN KEY ("org_id","register_id") REFERENCES "public"."registers"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_org_location_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_rejections" ADD CONSTRAINT "sync_rejections_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_price_history" ADD CONSTRAINT "variant_price_history_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_price_history" ADD CONSTRAINT "variant_price_history_org_variant_fk" FOREIGN KEY ("org_id","variant_id") REFERENCES "public"."variants"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_price_history" ADD CONSTRAINT "variant_price_history_org_product_fk" FOREIGN KEY ("org_id","product_id") REFERENCES "public"."products"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "modifier_price_history_lookup_idx" ON "modifier_price_history" USING btree ("org_id","modifier_id","valid_from");--> statement-breakpoint
CREATE INDEX "payments_org_sale_idx" ON "payments" USING btree ("org_id","sale_id");--> statement-breakpoint
CREATE INDEX "sale_lines_org_sale_idx" ON "sale_lines" USING btree ("org_id","sale_id");--> statement-breakpoint
CREATE INDEX "sale_lines_org_variant_idx" ON "sale_lines" USING btree ("org_id","variant_id");--> statement-breakpoint
CREATE INDEX "sales_org_completed_idx" ON "sales" USING btree ("org_id","completed_at");--> statement-breakpoint
CREATE INDEX "sales_org_created_idx" ON "sales" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "sync_rejections_org_status_idx" ON "sync_rejections" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "variant_price_history_lookup_idx" ON "variant_price_history" USING btree ("org_id","variant_id","valid_from");
