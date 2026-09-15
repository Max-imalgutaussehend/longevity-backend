ALTER TABLE "partner_offers" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "partner_offers" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partner_offers" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_offers" ADD CONSTRAINT "partner_offers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partner_offers_organization_id_index" ON "partner_offers" USING btree ("organization_id");