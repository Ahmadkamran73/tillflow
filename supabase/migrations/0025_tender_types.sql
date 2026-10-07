CREATE TABLE "tender_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"method" text NOT NULL,
	"label" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tender_types_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "tender_types_method" CHECK ("tender_types"."method" in ('cash', 'card', 'voucher')),
	CONSTRAINT "tender_types_label" CHECK (char_length(btrim("tender_types"."label")) between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tender_type_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "tender_types" ADD CONSTRAINT "tender_types_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_types" ADD CONSTRAINT "tender_types_org_location_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tender_types_org_location_idx" ON "tender_types" USING btree ("org_id","location_id","sort");--> statement-breakpoint
CREATE UNIQUE INDEX "tender_types_one_cash_key" ON "tender_types" USING btree ("location_id") WHERE "tender_types"."method" = 'cash';--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_tender_type_fk" FOREIGN KEY ("org_id","tender_type_id") REFERENCES "public"."tender_types"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_org_created_idx" ON "payments" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount" CHECK ("payments"."amount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_change_cash_only" CHECK ("payments"."method" = 'cash' or "payments"."change_cents" = 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tip" CHECK ("payments"."tip_cents" = 0 or ("payments"."method" = 'card' and "payments"."tip_cents" <= "payments"."amount_cents"));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_ref" CHECK ("payments"."provider_ref" is null or (char_length("payments"."provider_ref") <= 40 and "payments"."provider_ref" ~ '^[A-Za-z0-9 /-]*$' and char_length(regexp_replace("payments"."provider_ref", '[^0-9]', '', 'g')) < 13));