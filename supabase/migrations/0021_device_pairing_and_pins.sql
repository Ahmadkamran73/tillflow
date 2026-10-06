CREATE TABLE "register_pairing_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "register_pairing_codes_code_hash_key" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "pin_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "pin_failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "pin_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "discount_override_bp" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "register_pairing_codes" ADD CONSTRAINT "register_pairing_codes_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_pairing_codes" ADD CONSTRAINT "register_pairing_codes_org_register_fk" FOREIGN KEY ("org_id","register_id") REFERENCES "public"."registers"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "register_pairing_codes_org_register_idx" ON "register_pairing_codes" USING btree ("org_id","register_id");--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_discount_override_bp" CHECK ("organisations"."discount_override_bp" between 0 and 10000);
