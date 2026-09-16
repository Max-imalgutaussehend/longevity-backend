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
  extraTokenParams?: Record<string, string>;
}

export function parseTokenResponse(
  raw: unknown,
  defaultScope: string,
  fallbackRefreshToken = '',
): OAuthCredentials {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid OAuth token response: payload is not an object');
  }

  const obj = raw as Record<string, unknown>;

  // Withings API status: 0 is success, non-zero is an error
  if (typeof obj.status === 'number' && obj.status !== 0) {
    const errorMsg = typeof obj.error === 'string'
      ? obj.error
      : (typeof obj.message === 'string' ? obj.message : `API status code ${obj.status}`);
    throw new Error(`OAuth provider returned error: ${errorMsg}`);
  }

  // Support nested body (Withings API format: { status: 0, body: { access_token, ... } })
  const payload = (obj.body && typeof obj.body === 'object')
    ? (obj.body as Record<string, unknown>)
    : obj;

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!accessToken) {
    throw new Error('OAuth token response missing access_token');
  }

  const refreshToken = typeof payload.refresh_token === 'string'
    ? payload.refresh_token
    : fallbackRefreshToken;

  const expiresInRaw = typeof payload.expires_in === 'number' ? payload.expires_in : Number(payload.expires_in);
  const expiresInSec = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 3600;

  const scope = typeof payload.scope === 'string' ? payload.scope : defaultScope;

  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    scope,
  };
}

export async function exchangeCodeForToken(
  provider: OAuthProvider,
  code: string,
  baseUrl: string,
  overrideRedirectUri?: string,
): Promise<OAuthCredentials> {
  const redirect_uri = overrideRedirectUri ?? provider.redirectUri(baseUrl);
  const bodyParams: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: provider.clientId ?? '',
    client_secret: provider.clientSecret ?? '',
    redirect_uri,
    ...(provider.extraTokenParams ?? {}),
  };
  if (provider.kind === 'withings' && !bodyParams.action) {
    bodyParams.action = 'requesttoken';
  }

  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(bodyParams),
  });

  if (!res.ok) {
    throw new Error(`OAuth token exchange failed for ${provider.kind}: ${res.status}`);
  }

  const data = await res.json();
  return parseTokenResponse(data, provider.scope);
}

async function refreshToken(provider: OAuthProvider, credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const bodyParams: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: provider.clientId ?? '',
    client_secret: provider.clientSecret ?? '',
    ...(provider.extraTokenParams ?? {}),
  };
  if (provider.kind === 'withings' && !bodyParams.action) {
    bodyParams.action = 'requesttoken';
  }

  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(bodyParams),
  });

  if (!res.ok) {
    throw new Error(`OAuth token refresh failed for ${provider.kind}: ${res.status}`);
  }

  const data = await res.json();
  return parseTokenResponse(data, credentials.scope, credentials.refreshToken);
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

