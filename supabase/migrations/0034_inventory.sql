ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reason";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "low_stock_threshold" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_low_stock_threshold" CHECK ("products"."low_stock_threshold" is null or "products"."low_stock_threshold" between 0 and 1000000);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_note_len" CHECK ("stock_movements"."note" is null or char_length("stock_movements"."note") <= 200);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason" CHECK ("stock_movements"."reason" in ('opening','adjustment','sale','refund','damage','count','received'));