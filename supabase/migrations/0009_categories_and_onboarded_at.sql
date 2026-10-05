CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"colour" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_org_name_key" UNIQUE("org_id","name"),
	CONSTRAINT "categories_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "categories_colour_hex" CHECK ("categories"."colour" is null or "categories"."colour" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_org_parent_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "public"."categories"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_org_sort_idx" ON "categories" USING btree ("org_id","sort");--> statement-breakpoint
CREATE INDEX "categories_org_parent_idx" ON "categories" USING btree ("org_id","parent_id");