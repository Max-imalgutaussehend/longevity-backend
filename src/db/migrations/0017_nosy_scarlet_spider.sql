CREATE TABLE IF NOT EXISTS "partner_offer_voucher_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"code" text NOT NULL,
	"claimed_by_user_id" uuid,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "benefit_claims" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "benefit_claims" ADD COLUMN "kvnr" text;--> statement-breakpoint
ALTER TABLE "partner_offers" ADD COLUMN "voucher_delivery" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_offer_voucher_codes" ADD CONSTRAINT "partner_offer_voucher_codes_offer_id_partner_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."partner_offers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_offer_voucher_codes" ADD CONSTRAINT "partner_offer_voucher_codes_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partner_offer_voucher_codes_offer_id_index" ON "partner_offer_voucher_codes" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partner_offer_voucher_codes_claimed_by_user_id_index" ON "partner_offer_voucher_codes" USING btree ("claimed_by_user_id");