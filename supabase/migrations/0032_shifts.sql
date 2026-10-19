CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"note" text NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movements_kind" CHECK ("cash_movements"."kind" in ('in', 'out')),
	CONSTRAINT "cash_movements_amount" CHECK ("cash_movements"."amount_cents" between 1 and 10000000),
	CONSTRAINT "cash_movements_note" CHECK (char_length(btrim("cash_movements"."note")) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "shift_closes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"z_seq" integer NOT NULL,
	"closed_by" uuid NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"counted_cents" integer NOT NULL,
	"expected_cents" integer NOT NULL,
	"over_short_cents" integer NOT NULL,
	"report" jsonb NOT NULL,
	"review_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_closes_shift_key" UNIQUE("shift_id"),
	CONSTRAINT "shift_closes_register_seq_key" UNIQUE("org_id","register_id","z_seq"),
	CONSTRAINT "shift_closes_z_seq" CHECK ("shift_closes"."z_seq" between 1 and 99999999),
	CONSTRAINT "shift_closes_counted" CHECK ("shift_closes"."counted_cents" between 0 and 100000000),
	CONSTRAINT "shift_closes_over_short" CHECK ("shift_closes"."over_short_cents" = "shift_closes"."counted_cents" - "shift_closes"."expected_cents"),
	CONSTRAINT "shift_closes_review_flags" CHECK ("shift_closes"."review_flags" <@ array['z_differs', 'counts_differ', 'rejected_excluded']::text[]),
	CONSTRAINT "shift_closes_report_size" CHECK (pg_column_size("shift_closes"."report") <= 65536)
);
--> statement-breakpoint
CREATE TABLE "shift_documents" (
	"doc_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_documents_kind" CHECK ("shift_documents"."kind" in ('sale', 'refund'))
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"float_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shifts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "shifts_float" CHECK ("shifts"."float_cents" between 0 and 10000000)
);
--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_org_shift_fk" FOREIGN KEY ("org_id","shift_id") REFERENCES "public"."shifts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closes" ADD CONSTRAINT "shift_closes_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closes" ADD CONSTRAINT "shift_closes_org_shift_fk" FOREIGN KEY ("org_id","shift_id") REFERENCES "public"."shifts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_documents" ADD CONSTRAINT "shift_documents_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_documents" ADD CONSTRAINT "shift_documents_org_shift_fk" FOREIGN KEY ("org_id","shift_id") REFERENCES "public"."shifts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_org_register_fk" FOREIGN KEY ("org_id","register_id") REFERENCES "public"."registers"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_org_location_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_movements_org_shift_idx" ON "cash_movements" USING btree ("org_id","shift_id");--> statement-breakpoint
CREATE INDEX "shift_closes_org_closed_idx" ON "shift_closes" USING btree ("org_id","closed_at");--> statement-breakpoint
CREATE INDEX "shift_documents_org_shift_idx" ON "shift_documents" USING btree ("org_id","shift_id","kind");--> statement-breakpoint
CREATE INDEX "shifts_org_register_idx" ON "shifts" USING btree ("org_id","register_id","opened_at");