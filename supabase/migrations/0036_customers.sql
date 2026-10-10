CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"vat_number" text,
	"address" text,
	"notes" text,
	"marketing_consent_at" timestamp with time zone,
	"anonymised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "customers_name" CHECK (char_length(btrim("customers"."name")) between 1 and 120),
	CONSTRAINT "customers_email" CHECK ("customers"."email" is null or char_length("customers"."email") <= 254),
	CONSTRAINT "customers_phone" CHECK ("customers"."phone" is null or char_length("customers"."phone") <= 30),
	CONSTRAINT "customers_vat" CHECK ("customers"."vat_number" is null or char_length("customers"."vat_number") <= 20),
	CONSTRAINT "customers_address" CHECK ("customers"."address" is null or char_length("customers"."address") <= 300),
	CONSTRAINT "customers_notes" CHECK ("customers"."notes" is null or char_length("customers"."notes") <= 500)
);
--> statement-breakpoint
CREATE TABLE "sale_customers" (
	"sale_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_customers" ADD CONSTRAINT "sale_customers_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_customers" ADD CONSTRAINT "sale_customers_org_sale_fk" FOREIGN KEY ("org_id","sale_id") REFERENCES "public"."sales"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_customers" ADD CONSTRAINT "sale_customers_org_customer_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "public"."customers"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_email_key" ON "customers" USING btree ("org_id",lower("email")) WHERE "customers"."email" is not null;--> statement-breakpoint
CREATE INDEX "customers_org_name_idx" ON "customers" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "sale_customers_org_customer_idx" ON "sale_customers" USING btree ("org_id","customer_id");