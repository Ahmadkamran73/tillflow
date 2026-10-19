ALTER TABLE "organisations" ADD COLUMN "vat_rates_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "vat_rates_confirmed_by" uuid;