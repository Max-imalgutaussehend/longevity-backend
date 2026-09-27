ALTER TABLE "users" ADD COLUMN "organization_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kvnr_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kvnr_hash_unique" UNIQUE("kvnr_hash");