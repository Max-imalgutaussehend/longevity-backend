ALTER TABLE "users" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
UPDATE "users" SET "webhook_secret" = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') WHERE "webhook_secret" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "webhook_secret" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_webhook_secret_unique" UNIQUE("webhook_secret");
EXCEPTION
  WHEN duplicate_table OR duplicate_object THEN null;
END $$;