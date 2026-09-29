ALTER TABLE "benefit_claims" DROP CONSTRAINT "benefit_claims_share_token_id_share_tokens_id_fk";
--> statement-breakpoint
ALTER TABLE "benefit_claims" DROP CONSTRAINT "benefit_claims_decided_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "webhook_secret" SET DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_share_token_id_share_tokens_id_fk" FOREIGN KEY ("share_token_id") REFERENCES "public"."share_tokens"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
