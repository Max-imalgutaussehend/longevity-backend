import { env } from '../env.js';
import type { OAuthProvider } from './oauthTokens.js';

const googleClientId = env.GOOGLE_FIT_CLIENT_ID ?? env.GOOGLE_HEALTH_CLIENT_ID;
const googleClientSecret = env.GOOGLE_FIT_CLIENT_SECRET ?? env.GOOGLE_HEALTH_CLIENT_SECRET;

const googleHealthScopes = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
].join(' ');

export const oauthProviders: Record<string, OAuthProvider> = {
  withings: {
    kind: 'withings',
    authorizeUrl: 'https://account.withings.com/oauth2_user/authorize2',
    tokenUrl: 'https://wbsapi.withings.net/v2/oauth2',
    clientId: env.WITHINGS_CLIENT_ID,
    clientSecret: env.WITHINGS_CLIENT_SECRET,
    scope: 'user.metrics,user.activity',
    redirectUri: (baseUrl) => `${baseUrl}/api/oauth/callback/withings`,
    extraTokenParams: {
      action: 'requesttoken',
    },
  },
  'google-fit': {
    kind: 'google-fit',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    scope: googleHealthScopes,
    redirectUri: (baseUrl) => (env.GOOGLE_REDIRECT_URI && env.GOOGLE_REDIRECT_URI.trim()) || `${baseUrl}/api/oauth/callback/google-fit`,
  },
  'google-health': {
    kind: 'google-health',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    scope: googleHealthScopes,
    redirectUri: (baseUrl) => (env.GOOGLE_REDIRECT_URI && env.GOOGLE_REDIRECT_URI.trim()) || `${baseUrl}/api/oauth/callback/google-fit`,
  },
  oura: {
    kind: 'oura',
    authorizeUrl: 'https://cloud.ouraring.com/oauth/authorize',
    tokenUrl: 'https://api.ouraring.com/oauth/token',
    clientId: env.OURA_CLIENT_ID,
    clientSecret: env.OURA_CLIENT_SECRET,
    scope: 'daily',
    redirectUri: (baseUrl) => `${baseUrl}/api/oauth/callback/oura`,
  },
  strava: {
    kind: 'strava',
    authorizeUrl: 'https://www.strava.com/oauth/authorize',
    tokenUrl: 'https://www.strava.com/oauth/token',
    clientId: env.STRAVA_CLIENT_ID,
    clientSecret: env.STRAVA_CLIENT_SECRET,
    scope: 'activity:read_all',
    redirectUri: (baseUrl) => `${baseUrl}/api/oauth/callback/strava`,
  },
};

export function providerToSourceKind(provider: string): 'withings' | 'google_fit' | 'oura' | 'strava' | null {
  if (provider === 'withings') return 'withings';
  if (provider === 'google-fit' || provider === 'google-health') return 'google_fit';
  if (provider === 'oura') return 'oura';
  if (provider === 'strava') return 'strava';
  return null;
}

