CREATE TABLE IF NOT EXISTS "benefit_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"share_token_id" text NOT NULL,
	"band_low" integer NOT NULL,
	"band_high" integer NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_offer_id_partner_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."partner_offers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_share_token_id_share_tokens_id_fk" FOREIGN KEY ("share_token_id") REFERENCES "public"."share_tokens"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "benefit_claims_user_id_index" ON "benefit_claims" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "benefit_claims_organization_id_index" ON "benefit_claims" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "benefit_claims_active_unique" ON "benefit_claims" USING btree ("user_id","offer_id") WHERE "benefit_claims"."status" != 'rejected';