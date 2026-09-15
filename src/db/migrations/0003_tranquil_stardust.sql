ALTER TABLE "users" DROP CONSTRAINT "users_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "join_code" text;--> statement-breakpoint
UPDATE "organizations" SET "join_code" = substr(md5(random()::text || id::text), 1, 10) WHERE "join_code" IS NULL;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "join_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_offers" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "partner_offers" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partner_offers" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_offers" ADD CONSTRAINT "partner_offers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partner_offers_organization_id_index" ON "partner_offers" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_join_code_unique" UNIQUE("join_code");