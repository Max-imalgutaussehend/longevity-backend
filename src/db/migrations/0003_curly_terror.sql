ALTER TABLE "users" DROP CONSTRAINT "users_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "join_code" text;--> statement-breakpoint
UPDATE "organizations" SET "join_code" = substr(md5(random()::text || id::text), 1, 10) WHERE "join_code" IS NULL;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "join_code" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_join_code_unique" UNIQUE("join_code");