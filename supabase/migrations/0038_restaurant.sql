CREATE TABLE "floors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "floors_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "floors_name" CHECK (char_length(btrim("floors"."name")) between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "restaurant_tables" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"seats" integer NOT NULL,
	"shape" text DEFAULT 'square' NOT NULL,
	"x" integer DEFAULT 0 NOT NULL,
	"y" integer DEFAULT 0 NOT NULL,
	"w" integer DEFAULT 2 NOT NULL,
	"h" integer DEFAULT 2 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurant_tables_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "restaurant_tables_name" CHECK (char_length(btrim("restaurant_tables"."name")) between 1 and 20),
	CONSTRAINT "restaurant_tables_seats" CHECK ("restaurant_tables"."seats" between 1 and 30),
	CONSTRAINT "restaurant_tables_shape" CHECK ("restaurant_tables"."shape" in ('square', 'round', 'rect')),
	CONSTRAINT "restaurant_tables_grid" CHECK ("restaurant_tables"."x" between 0 and 59 and "restaurant_tables"."y" between 0 and 39 and "restaurant_tables"."w" between 1 and 8 and "restaurant_tables"."h" between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "sale_tabs" (
	"sale_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"tab_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tab_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"tab_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tab_events_kind" CHECK ("tab_events"."kind" in ('open', 'send', 'fire', 'transfer', 'merge', 'close', 'void')),
	CONSTRAINT "tab_events_detail_size" CHECK (pg_column_size("tab_events"."detail") < 2048)
);
--> statement-breakpoint
ALTER TABLE "sales" DROP CONSTRAINT "sales_review_flags";--> statement-breakpoint
ALTER TABLE "register_approvals" DROP CONSTRAINT "register_approvals_purpose";--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "service_charge_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "floors" ADD CONSTRAINT "floors_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floors" ADD CONSTRAINT "floors_org_location_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_org_floor_fk" FOREIGN KEY ("org_id","floor_id") REFERENCES "public"."floors"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tabs" ADD CONSTRAINT "sale_tabs_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tabs" ADD CONSTRAINT "sale_tabs_org_sale_fk" FOREIGN KEY ("org_id","sale_id") REFERENCES "public"."sales"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tab_events" ADD CONSTRAINT "tab_events_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "restaurant_tables_org_floor_idx" ON "restaurant_tables" USING btree ("org_id","floor_id");--> statement-breakpoint
CREATE INDEX "sale_tabs_org_tab_idx" ON "sale_tabs" USING btree ("org_id","tab_id");--> statement-breakpoint
CREATE INDEX "tab_events_org_tab_idx" ON "tab_events" USING btree ("org_id","tab_id","at");--> statement-breakpoint
CREATE INDEX "tab_events_org_at_idx" ON "tab_events" USING btree ("org_id","at");--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_review_flags" CHECK ("sales"."review_flags" <@ array['vat_differs', 'old_prices', 'rounding_differs', 'service_differs']::text[]);--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_service_charge_bp" CHECK ("organisations"."service_charge_bp" between 0 and 2500);--> statement-breakpoint
ALTER TABLE "register_approvals" ADD CONSTRAINT "register_approvals_purpose" CHECK ("register_approvals"."purpose" in ('discount', 'no_sale', 'refund', 'void_item'));