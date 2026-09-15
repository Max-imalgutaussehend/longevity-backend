CREATE TABLE IF NOT EXISTS "health_data_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "health_data_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "health_data_consent_version" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "health_data_consents" ADD CONSTRAINT "health_data_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "health_data_consents_user_id_index" ON "health_data_consents" USING btree ("user_id");