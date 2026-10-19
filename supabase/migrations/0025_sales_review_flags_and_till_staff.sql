ALTER TABLE "sales" ADD COLUMN "client_vat_cents" integer;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "review_flags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "till_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_review_flags" CHECK ("sales"."review_flags" <@ array['vat_differs', 'old_prices']::text[]);