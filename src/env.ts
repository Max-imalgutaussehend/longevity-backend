import { z } from 'zod';

const optionalString = z.string().transform(v => (v.trim() === '' ? undefined : v)).optional();
const optionalUrl = z.string().transform(v => (v.trim() === '' ? undefined : v)).pipe(z.string().url().optional()).optional();
const optionalPort = z.string().transform(v => (v.trim() === '' ? undefined : v)).pipe(z.coerce.number().int().positive().optional()).optional();

export const DEFAULT_PASSWORD_PEPPER = 'longevity-default-pepper-secret-32b-long!';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  PASSWORD_PEPPER: z.string().min(16).default(DEFAULT_PASSWORD_PEPPER),
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

export function validateProductionEnv(
  data: { SIGNING_KEY_PRIVATE?: string; SIGNING_KEY_PUBLIC?: string; PASSWORD_PEPPER?: string },
  rawPepper: string | undefined = process.env.PASSWORD_PEPPER,
): string[] {
  const missing: string[] = [];
  if (!data.SIGNING_KEY_PRIVATE) missing.push('SIGNING_KEY_PRIVATE');
  if (!data.SIGNING_KEY_PUBLIC) missing.push('SIGNING_KEY_PUBLIC');
  if (!rawPepper || rawPepper.trim() === '' || data.PASSWORD_PEPPER === DEFAULT_PASSWORD_PEPPER) {
    missing.push('PASSWORD_PEPPER (must be explicitly set and not use default value in production)');
  }
  return missing;
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production') {
  const missing = validateProductionEnv(parsed.data);

  if (missing.length > 0) {
    console.error(`Production startup error: Missing required keys or insecure configuration: ${missing.join(', ')}`);
    process.exit(1);
  }
}

export const env = parsed.data;
