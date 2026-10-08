-- Moved to the top: the refund_lines foreign key below needs this unique key to exist first.
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_org_id_id_key" UNIQUE("org_id","id");--> statement-breakpoint
CREATE TABLE "refund_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text DEFAULT 'item' NOT NULL,
	"variant_id" uuid,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"serial" text,
	"restock" boolean DEFAULT true NOT NULL,
	"tax_category" text,
	"tax_rate_bp" integer,
	"net_cents" integer,
	"vat_cents" integer,
	"gross_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_lines_refund_line_key" UNIQUE("refund_id","line_no"),
	CONSTRAINT "refund_lines_kind" CHECK ("refund_lines"."kind" in ('item', 'deposit')),
	CONSTRAINT "refund_lines_qty" CHECK ("refund_lines"."qty" between 1 and 999),
	CONSTRAINT "refund_lines_gross" CHECK ("refund_lines"."gross_cents" >= 0),
	CONSTRAINT "refund_lines_snapshot" CHECK (("refund_lines"."kind" = 'item' and "refund_lines"."tax_rate_bp" is not null and "refund_lines"."net_cents" is not null and "refund_lines"."vat_cents" is not null and "refund_lines"."tax_category" is not null and "refund_lines"."net_cents" + "refund_lines"."vat_cents" = "refund_lines"."gross_cents")
        or ("refund_lines"."kind" = 'deposit' and "refund_lines"."tax_rate_bp" is null))
);
--> statement-breakpoint
CREATE TABLE "refund_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"tender_type_id" uuid,
	"label" text,
	"method" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_payments_method" CHECK ("refund_payments"."method" in ('cash', 'card', 'voucher', 'exchange')),
	CONSTRAINT "refund_payments_amount" CHECK ("refund_payments"."amount_cents" >= 0),
	CONSTRAINT "refund_payments_tip" CHECK ("refund_payments"."tip_cents" = 0 or ("refund_payments"."method" = 'card' and "refund_payments"."tip_cents" <= "refund_payments"."amount_cents")),
	CONSTRAINT "refund_payments_provider_ref" CHECK ("refund_payments"."provider_ref" is null or (char_length("refund_payments"."provider_ref") <= 40 and "refund_payments"."provider_ref" ~ '^[A-Za-z0-9 /-]*$' and char_length(regexp_replace("refund_payments"."provider_ref", '[^0-9]', '', 'g')) < 13))
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"original_sale_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_note" text,
	"receipt_seq" integer NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"approved_by" uuid,
	"approval_id" uuid,
	"approval_state" text DEFAULT 'not_needed' NOT NULL,
	"items_total_cents" integer NOT NULL,
	"vat_cents" integer NOT NULL,
	"non_vat_cents" integer NOT NULL,
	"credit_cents" integer DEFAULT 0 NOT NULL,
	"cash_rounding_cents" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"client_amount_cents" integer NOT NULL,
	"exchange_sale_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "refunds_org_register_seq_key" UNIQUE("org_id","register_id","receipt_seq"),
	CONSTRAINT "refunds_kind" CHECK ("refunds"."kind" in ('refund', 'void', 'exchange')),
	CONSTRAINT "refunds_reason_code" CHECK ("refunds"."reason_code" in ('changed_mind', 'faulty', 'wrong_item', 'damaged', 'void_mistake', 'other')),
	CONSTRAINT "refunds_reason_note" CHECK (("refunds"."reason_note" is null or char_length("refunds"."reason_note") <= 200)
        and ("refunds"."reason_code" <> 'other' or char_length(btrim(coalesce("refunds"."reason_note", ''))) > 0)),
	CONSTRAINT "refunds_approval_state" CHECK ("refunds"."approval_state" in ('not_needed', 'verified', 'self', 'unverified')),
	CONSTRAINT "refunds_receipt_seq" CHECK ("refunds"."receipt_seq" between 1 and 99999999),
	CONSTRAINT "refunds_amounts" CHECK ("refunds"."items_total_cents" >= 0 and "refunds"."vat_cents" >= 0 and "refunds"."non_vat_cents" >= 0
        and "refunds"."credit_cents" >= 0 and "refunds"."amount_cents" >= 0
        and "refunds"."cash_rounding_cents" between -2 and 2
        and "refunds"."amount_cents" = "refunds"."items_total_cents" + "refunds"."non_vat_cents" - "refunds"."credit_cents" + "refunds"."cash_rounding_cents"),
	CONSTRAINT "refunds_amount_close" CHECK (abs("refunds"."amount_cents" - "refunds"."client_amount_cents") <= 1),
	CONSTRAINT "refunds_exchange" CHECK (("refunds"."kind" = 'exchange') = ("refunds"."exchange_sale_id" is not null)
        and ("refunds"."kind" = 'exchange' or "refunds"."credit_cents" = 0))
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_method";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "exchange_refund_id" uuid;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "refund_override_cents" integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE "register_approvals" ADD COLUMN "sale_id" uuid;--> statement-breakpoint
ALTER TABLE "register_approvals" ADD COLUMN "max_cents" integer;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_org_refund_fk" FOREIGN KEY ("org_id","refund_id") REFERENCES "public"."refunds"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_org_sale_line_fk" FOREIGN KEY ("org_id","sale_line_id") REFERENCES "public"."sale_lines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payments" ADD CONSTRAINT "refund_payments_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payments" ADD CONSTRAINT "refund_payments_org_refund_fk" FOREIGN KEY ("org_id","refund_id") REFERENCES "public"."refunds"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payments" ADD CONSTRAINT "refund_payments_org_tender_type_fk" FOREIGN KEY ("org_id","tender_type_id") REFERENCES "public"."tender_types"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_org_register_fk" FOREIGN KEY ("org_id","register_id") REFERENCES "public"."registers"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_org_location_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_org_sale_fk" FOREIGN KEY ("org_id","original_sale_id") REFERENCES "public"."sales"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_lines_org_refund_idx" ON "refund_lines" USING btree ("org_id","refund_id");--> statement-breakpoint
CREATE INDEX "refund_lines_org_sale_line_idx" ON "refund_lines" USING btree ("org_id","sale_line_id");--> statement-breakpoint
CREATE INDEX "refund_payments_org_refund_idx" ON "refund_payments" USING btree ("org_id","refund_id");--> statement-breakpoint
CREATE INDEX "refund_payments_org_created_idx" ON "refund_payments" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_org_created_idx" ON "refunds" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_org_sale_idx" ON "refunds" USING btree ("org_id","original_sale_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_exchange_refund_fk" FOREIGN KEY ("org_id","exchange_refund_id") REFERENCES "public"."refunds"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method" CHECK ("payments"."method" in ('cash', 'card', 'voucher', 'exchange'));--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_refund_override_cents" CHECK ("organisations"."refund_override_cents" between 0 and 1000000);--> statement-breakpoint
ALTER TABLE "register_approvals" ADD CONSTRAINT "register_approvals_max_cents" CHECK ("register_approvals"."max_cents" is null or "register_approvals"."max_cents" >= 0);