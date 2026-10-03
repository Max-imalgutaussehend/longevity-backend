ALTER TABLE "benefit_claims" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "benefit_claims" ADD COLUMN "payout_method" text DEFAULT 'bank_transfer';--> statement-breakpoint
ALTER TABLE "benefit_claims" ADD COLUMN "payout_iban_masked" text;--> statement-breakpoint
ALTER TABLE "benefit_claims" ADD COLUMN "payout_account_holder" text;--> statement-breakpoint
ALTER TABLE "benefit_claims" ADD COLUMN "reward_payload" jsonb;--> statement-breakpoint
ALTER TABLE "benefit_claims" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "benefit_claims" ADD COLUMN "self_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "benefit_claims" ADD COLUMN "reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partner_offers" ADD COLUMN "benefit_type" text DEFAULT 'payout' NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_offers" ADD COLUMN "voucher_code" text;--> statement-breakpoint
ALTER TABLE "partner_offers" ADD COLUMN "partner_url" text;