ALTER TABLE "users" ALTER COLUMN "webhook_secret" SET DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
