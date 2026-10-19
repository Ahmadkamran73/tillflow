CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_choices" integer DEFAULT 0 NOT NULL,
	"max_choices" integer DEFAULT 1 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modifier_groups_org_name_key" UNIQUE("org_id","name"),
	CONSTRAINT "modifier_groups_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "modifier_groups_name_len" CHECK (char_length("modifier_groups"."name") between 1 and 60),
	CONSTRAINT "modifier_groups_choices" CHECK ("modifier_groups"."min_choices" >= 0 and "modifier_groups"."min_choices" <= "modifier_groups"."max_choices" and "modifier_groups"."max_choices" <= 20)
);
--> statement-breakpoint
CREATE TABLE "modifiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_delta_cents" integer DEFAULT 0 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modifiers_org_group_name_key" UNIQUE("org_id","group_id","name"),
	CONSTRAINT "modifiers_name_len" CHECK (char_length("modifiers"."name") between 1 and 60),
	CONSTRAINT "modifiers_price_delta" CHECK ("modifiers"."price_delta_cents" between -100000 and 100000)
);
--> statement-breakpoint
CREATE TABLE "product_modifier_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_modifier_groups_org_product_group_key" UNIQUE("org_id","product_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"tax_category" text NOT NULL,
	"takeaway_tax_category" text,
	"track_stock" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "products_name_len" CHECK (char_length("products"."name") between 1 and 120),
	CONSTRAINT "products_tax_category" CHECK ("products"."tax_category" in ('STANDARD','REDUCED','SECOND_REDUCED','ZERO','LIVESTOCK','CATERING','HAIRDRESSING')),
	CONSTRAINT "products_takeaway_tax_category" CHECK ("products"."takeaway_tax_category" is null or "products"."takeaway_tax_category" in ('STANDARD','REDUCED','SECOND_REDUCED','ZERO','LIVESTOCK','CATERING','HAIRDRESSING')),
	CONSTRAINT "products_catering_takeaway" CHECK ("products"."tax_category" <> 'CATERING' or "products"."takeaway_tax_category" is not null)
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_levels_org_variant_location_key" UNIQUE("org_id","variant_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"qty_delta" integer NOT NULL,
	"reason" text NOT NULL,
	"ref_id" uuid,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_qty" CHECK ("stock_movements"."qty_delta" <> 0 and "stock_movements"."qty_delta" between -1000000 and 1000000),
	CONSTRAINT "stock_movements_reason" CHECK ("stock_movements"."reason" in ('opening','adjustment','sale','refund'))
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"sku" text,
	"barcode" text,
	"price_incl_vat_cents" integer NOT NULL,
	"cost_cents" integer,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "variants_org_barcode_key" UNIQUE("org_id","barcode"),
	CONSTRAINT "variants_org_sku_key" UNIQUE("org_id","sku"),
	CONSTRAINT "variants_price_range" CHECK ("variants"."price_incl_vat_cents" between 0 and 100000000),
	CONSTRAINT "variants_cost_range" CHECK ("variants"."cost_cents" is null or "variants"."cost_cents" between 0 and 100000000),
	CONSTRAINT "variants_barcode_shape" CHECK ("variants"."barcode" is null or "variants"."barcode" ~ '^[0-9A-Za-z-]{1,32}$'),
	CONSTRAINT "variants_sku_len" CHECK ("variants"."sku" is null or char_length("variants"."sku") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_org_group_fk" FOREIGN KEY ("org_id","group_id") REFERENCES "public"."modifier_groups"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_modifier_groups" ADD CONSTRAINT "product_modifier_groups_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_modifier_groups" ADD CONSTRAINT "product_modifier_groups_org_product_fk" FOREIGN KEY ("org_id","product_id") REFERENCES "public"."products"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_modifier_groups" ADD CONSTRAINT "product_modifier_groups_org_group_fk" FOREIGN KEY ("org_id","group_id") REFERENCES "public"."modifier_groups"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_org_category_fk" FOREIGN KEY ("org_id","category_id") REFERENCES "public"."categories"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_org_variant_fk" FOREIGN KEY ("org_id","variant_id") REFERENCES "public"."variants"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_org_location_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_org_variant_fk" FOREIGN KEY ("org_id","variant_id") REFERENCES "public"."variants"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_org_location_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_org_product_fk" FOREIGN KEY ("org_id","product_id") REFERENCES "public"."products"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "modifiers_org_group_idx" ON "modifiers" USING btree ("org_id","group_id");--> statement-breakpoint
CREATE INDEX "product_modifier_groups_org_group_idx" ON "product_modifier_groups" USING btree ("org_id","group_id");--> statement-breakpoint
CREATE INDEX "products_org_name_idx" ON "products" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "products_org_category_idx" ON "products" USING btree ("org_id","category_id");--> statement-breakpoint
CREATE INDEX "stock_movements_org_variant_created_idx" ON "stock_movements" USING btree ("org_id","variant_id","created_at");--> statement-breakpoint
CREATE INDEX "variants_org_product_idx" ON "variants" USING btree ("org_id","product_id");