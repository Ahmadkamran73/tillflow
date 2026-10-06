CREATE TABLE "register_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_for" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "register_approvals_purpose" CHECK ("register_approvals"."purpose" in ('discount', 'no_sale', 'refund'))
);
--> statement-breakpoint
ALTER TABLE "register_approvals" ADD CONSTRAINT "register_approvals_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_approvals" ADD CONSTRAINT "register_approvals_org_register_fk" FOREIGN KEY ("org_id","register_id") REFERENCES "public"."registers"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "register_approvals_org_register_idx" ON "register_approvals" USING btree ("org_id","register_id","created_at");