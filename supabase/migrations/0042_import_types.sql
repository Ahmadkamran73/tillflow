ALTER TABLE "import_changes" DROP CONSTRAINT "import_changes_action";--> statement-breakpoint
ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_type";--> statement-breakpoint
ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_mode";--> statement-breakpoint
ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_match_key";--> statement-breakpoint
ALTER TABLE "import_changes" ADD COLUMN "qty_delta" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_changes" ADD CONSTRAINT "import_changes_action" CHECK ("import_changes"."action" in ('created','updated','stock'));--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_type" CHECK ("import_jobs"."type" in ('products','stock','customers'));--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_mode" CHECK ("import_jobs"."mode" in ('create','upsert','count','received'));--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_match_key" CHECK ("import_jobs"."match_key" in ('sku','barcode','email'));