import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SIGNING_KEY_PRIVATE: z.string().min(1).optional(),
  SIGNING_KEY_PUBLIC: z.string().min(1).optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  SMTP_URL: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  COMMIT_SHA: z.string().default('dev'),
  WITHINGS_CLIENT_ID: z.string().optional(),
  WITHINGS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_FIT_CLIENT_ID: z.string().optional(),
  GOOGLE_FIT_CLIENT_SECRET: z.string().optional(),
  GOOGLE_HEALTH_CLIENT_ID: z.string().optional(),
  GOOGLE_HEALTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  OURA_CLIENT_ID: z.string().optional(),
  OURA_CLIENT_SECRET: z.string().optional(),
  STRAVA_CLIENT_ID: z.string().optional(),
  STRAVA_CLIENT_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
