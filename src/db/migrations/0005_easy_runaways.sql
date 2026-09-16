ALTER TABLE "sources" ADD COLUMN "sync_status" text DEFAULT 'ok';--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "sync_error" text;