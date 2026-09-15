import { z } from 'zod';

const optionalString = z.string().transform(v => (v.trim() === '' ? undefined : v)).optional();
const optionalUrl = z.string().transform(v => (v.trim() === '' ? undefined : v)).pipe(z.string().url().optional()).optional();
const optionalPort = z.string().transform(v => (v.trim() === '' ? undefined : v)).pipe(z.coerce.number().int().positive().optional()).optional();

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SIGNING_KEY_PRIVATE: optionalString,
  SIGNING_KEY_PUBLIC: optionalString,
  PUBLIC_BASE_URL: optionalUrl,
  SMTP_URL: optionalString,
  SMTP_HOST: optionalString,
  SMTP_PORT: optionalPort,
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: optionalString,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  COMMIT_SHA: z.string().default('dev'),
  WITHINGS_CLIENT_ID: optionalString,
  WITHINGS_CLIENT_SECRET: optionalString,
  GOOGLE_FIT_CLIENT_ID: optionalString,
  GOOGLE_FIT_CLIENT_SECRET: optionalString,
  GOOGLE_HEALTH_CLIENT_ID: optionalString,
  GOOGLE_HEALTH_CLIENT_SECRET: optionalString,
  GOOGLE_REDIRECT_URI: optionalString,
  OURA_CLIENT_ID: optionalString,
  OURA_CLIENT_SECRET: optionalString,
  STRAVA_CLIENT_ID: optionalString,
  STRAVA_CLIENT_SECRET: optionalString,
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
