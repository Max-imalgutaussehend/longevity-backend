import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sources, type OAuthCredentials } from '../db/schema.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface OAuthProvider {
  kind: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  scope: string;
  redirectUri(baseUrl: string): string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export async function exchangeCodeForToken(
  provider: OAuthProvider,
  code: string,
  baseUrl: string,
  overrideRedirectUri?: string,
): Promise<OAuthCredentials> {
  const redirect_uri = overrideRedirectUri ?? provider.redirectUri(baseUrl);
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: provider.clientId ?? '',
      client_secret: provider.clientSecret ?? '',
      redirect_uri,
    }),
  });

  if (!res.ok) {
    throw new Error(`OAuth token exchange failed for ${provider.kind}: ${res.status}`);
  }

  const data = await res.json() as TokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? '',
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    scope: data.scope ?? provider.scope,
  };
}

async function refreshToken(provider: OAuthProvider, credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: provider.clientId ?? '',
      client_secret: provider.clientSecret ?? '',
    }),
  });

  if (!res.ok) {
    throw new Error(`OAuth token refresh failed for ${provider.kind}: ${res.status}`);
  }

  const data = await res.json() as TokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? credentials.refreshToken,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    scope: data.scope ?? credentials.scope,
  };
}

export class OAuthTokenError extends Error {
  constructor(message: string, public readonly code: 'NO_CREDENTIALS' | 'REFRESH_FAILED') {
    super(message);
    this.name = 'OAuthTokenError';
  }
}

export function isTokenError(err: unknown, message?: string): boolean {
  if (err instanceof OAuthTokenError) return true;
  const msg = (message ?? (err instanceof Error ? err.message : String(err))).toLowerCase();
  return (
    msg.includes('oauth') ||
    msg.includes('token') ||
    msg.includes('credential') ||
    msg.includes('invalid_grant') ||
    msg.includes('unauthorized') ||
    msg.includes('401')
  );
}

// Returns a valid access token for the given source, refreshing and persisting it first if it is close to expiry.
export async function getValidToken(sourceId: string, provider: OAuthProvider): Promise<string> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source?.credentials) {
    await db.update(sources).set({
      syncStatus: 'token_expired',
      syncError: `Keine OAuth-Anmeldedaten hinterlegt (${provider.kind})`,
    }).where(eq(sources.id, sourceId));
    throw new OAuthTokenError(`No OAuth credentials stored for source ${sourceId}`, 'NO_CREDENTIALS');
  }

  const credentials = source.credentials;
  const expiresAt = new Date(credentials.expiresAt).getTime();

  if (expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return credentials.accessToken;
  }

  try {
    const refreshed = await refreshToken(provider, credentials);
    await db.update(sources).set({
      credentials: refreshed,
      syncStatus: 'ok',
      syncError: null,
    }).where(eq(sources.id, sourceId));
    return refreshed.accessToken;
  } catch (err) {
    // Refresh token expired or revoked -> clear credentials in DB and set token_expired
    await db.update(sources).set({
      credentials: null,
      syncStatus: 'token_expired',
      syncError: `OAuth-Token-Erneuerung fehlgeschlagen (${provider.kind})`,
    }).where(eq(sources.id, sourceId));
    throw new OAuthTokenError(
      `OAuth token refresh failed for ${provider.kind}: ${err instanceof Error ? err.message : String(err)}`,
      'REFRESH_FAILED'
    );
  }
}

