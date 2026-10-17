CREATE TABLE "billing_counters" (
	"name" text PRIMARY KEY NOT NULL,
	"last_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "billing_counters_name" CHECK ("billing_counters"."name" = 'invoice')
);
--> statement-breakpoint
CREATE TABLE "billing_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_no" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_ex_vat_cents" integer NOT NULL,
	"vat_rate_bp" integer NOT NULL,
	"vat_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_on" date NOT NULL,
	"payment_reference" text NOT NULL,
	"supplier_name" text NOT NULL,
	"supplier_address" text NOT NULL,
	"supplier_vat_number" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_address" text,
	"customer_vat_number" text,
	"status" text DEFAULT 'issued' NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_on" date,
	"bank_reference" text,
	"marked_paid_by" uuid,
	"emailed_at" timestamp with time zone,
	"reminder_1_sent_at" timestamp with time zone,
	"reminder_2_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_invoices_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "billing_invoices_invoice_no_key" UNIQUE("invoice_no"),
	CONSTRAINT "billing_invoices_payment_reference_key" UNIQUE("payment_reference"),
	CONSTRAINT "billing_invoices_org_period_key" UNIQUE("org_id","period_start"),
	CONSTRAINT "billing_invoices_status" CHECK ("billing_invoices"."status" in ('issued', 'paid', 'void')),
	CONSTRAINT "billing_invoices_no_positive" CHECK ("billing_invoices"."invoice_no" > 0),
	CONSTRAINT "billing_invoices_amounts" CHECK ("billing_invoices"."amount_ex_vat_cents" >= 0 and "billing_invoices"."vat_cents" >= 0 and "billing_invoices"."total_cents" = "billing_invoices"."amount_ex_vat_cents" + "billing_invoices"."vat_cents"),
	CONSTRAINT "billing_invoices_rate" CHECK ("billing_invoices"."vat_rate_bp" between 0 and 10000),
	CONSTRAINT "billing_invoices_period" CHECK ("billing_invoices"."period_end" > "billing_invoices"."period_start"),
	CONSTRAINT "billing_invoices_paid_fields" CHECK (("billing_invoices"."status" = 'paid') = ("billing_invoices"."paid_at" is not null and "billing_invoices"."paid_on" is not null and "billing_invoices"."bank_reference" is not null and "billing_invoices"."marked_paid_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"price_cents" integer NOT NULL,
	"anchor_date" date,
	"period_start" date,
	"period_end" date,
	"paused_at" timestamp with time zone,
	"hold_until" date,
	"resumed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_org_id_key" UNIQUE("org_id"),
	CONSTRAINT "subscriptions_status" CHECK ("subscriptions"."status" in ('trial', 'active', 'overdue', 'paused')),
	CONSTRAINT "subscriptions_price" CHECK ("subscriptions"."price_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_invoices_status_due_idx" ON "billing_invoices" USING btree ("status","due_on");--> statement-breakpoint
CREATE INDEX "billing_invoices_org_issued_idx" ON "billing_invoices" USING btree ("org_id","issued_at");