import { env } from '../env.js';
import type { OAuthProvider } from './oauthTokens.js';

export const oauthProviders: Record<string, OAuthProvider> = {
  withings: {
    kind: 'withings',
    authorizeUrl: 'https://account.withings.com/oauth2_user/authorize2',
    tokenUrl: 'https://wbsapi.withings.net/v2/oauth2',
    clientId: env.WITHINGS_CLIENT_ID,
    clientSecret: env.WITHINGS_CLIENT_SECRET,
    scope: 'user.metrics,user.activity',
    redirectUri: (baseUrl) => `${baseUrl}/api/oauth/callback/withings`,
  },
  'google-fit': {
    kind: 'google-fit',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: env.GOOGLE_FIT_CLIENT_ID,
    clientSecret: env.GOOGLE_FIT_CLIENT_SECRET,
    scope: [
      'https://www.googleapis.com/auth/fitness.heart_rate.read',
      'https://www.googleapis.com/auth/fitness.activity.read',
      'https://www.googleapis.com/auth/fitness.sleep.read',
    ].join(' '),
    redirectUri: (baseUrl) => `${baseUrl}/api/oauth/callback/google-fit`,
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
};

export function providerToSourceKind(provider: string): 'withings' | 'google_fit' | 'oura' | null {
  if (provider === 'withings') return 'withings';
  if (provider === 'google-fit') return 'google_fit';
  if (provider === 'oura') return 'oura';
  return null;
}
