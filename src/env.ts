import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SIGNING_KEY_PRIVATE: z.string().min(1),
  SIGNING_KEY_PUBLIC: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),
  SMTP_URL: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  COMMIT_SHA: z.string().default('dev'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
