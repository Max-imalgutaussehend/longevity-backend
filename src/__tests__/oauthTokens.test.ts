import { describe, it, expect, beforeAll } from 'vitest';

describe('OAuth tokens & sync status helpers', () => {
  let isTokenError: (err: unknown, message?: string) => boolean;
  let OAuthTokenError: new (message: string, code: 'NO_CREDENTIALS' | 'REFRESH_FAILED') => Error;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-at-least-32-characters-long-key';

    const mod = await import('../lib/oauthTokens.js');
    isTokenError = mod.isTokenError;
    OAuthTokenError = mod.OAuthTokenError;
  });

  it('detects OAuthTokenError as token error', () => {
    const err = new OAuthTokenError('Token refresh failed', 'REFRESH_FAILED');
    expect(isTokenError(err)).toBe(true);
  });

  it('detects token error from message keywords (case-insensitive)', () => {
    expect(isTokenError(new Error('OAuth token expired'))).toBe(true);
    expect(isTokenError(new Error('invalid_grant: bad refresh token'))).toBe(true);
    expect(isTokenError(new Error('HTTP 401 Unauthorized'))).toBe(true);
    expect(isTokenError(new Error('Missing credential for provider'))).toBe(true);
  });

  it('detects token error when message is passed explicitly', () => {
    expect(isTokenError(null, 'User token was revoked')).toBe(true);
    expect(isTokenError(null, 'Server 500 error')).toBe(false);
  });

  it('returns false for non-token / generic network errors', () => {
    expect(isTokenError(new Error('ECONNREFUSED 127.0.0.1:443'))).toBe(false);
    expect(isTokenError(new Error('Gateway timeout 504'))).toBe(false);
    expect(isTokenError(new Error('Database query failed'))).toBe(false);
  });
});

describe('parseTokenResponse', () => {
  let parseTokenResponse: (raw: unknown, defaultScope: string, fallbackRefreshToken?: string) => {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scope: string;
  };

  beforeAll(async () => {
    const mod = await import('../lib/oauthTokens.js');
    parseTokenResponse = mod.parseTokenResponse;
  });

  it('parses standard flat OAuth2 response', () => {
    const raw = {
      access_token: 'flat_access_123',
      refresh_token: 'flat_refresh_123',
      expires_in: 7200,
      scope: 'read write',
    };

    const parsed = parseTokenResponse(raw, 'default_scope');
    expect(parsed.accessToken).toBe('flat_access_123');
    expect(parsed.refreshToken).toBe('flat_refresh_123');
    expect(parsed.scope).toBe('read write');
    expect(new Date(parsed.expiresAt).getTime()).toBeGreaterThan(Date.now() + 7000 * 1000);
  });

  it('parses nested Withings-style response (status: 0, body: {...})', () => {
    const raw = {
      status: 0,
      body: {
        access_token: 'withings_acc_token',
        refresh_token: 'withings_ref_token',
        expires_in: 10800,
        scope: 'user.metrics,user.activity',
        userid: '12345',
      },
    };

    const parsed = parseTokenResponse(raw, 'user.info');
    expect(parsed.accessToken).toBe('withings_acc_token');
    expect(parsed.refreshToken).toBe('withings_ref_token');
    expect(parsed.scope).toBe('user.metrics,user.activity');
    expect(new Date(parsed.expiresAt).getTime()).toBeGreaterThan(Date.now() + 10000 * 1000);
  });

  it('throws when Withings status is non-zero', () => {
    const raw = {
      status: 253,
      error: 'The request is not valid',
    };

    expect(() => parseTokenResponse(raw, 'default_scope')).toThrow(
      'OAuth provider returned error: The request is not valid',
    );
  });

  it('falls back to 3600s if expires_in is missing or invalid without throwing Invalid time value', () => {
    const raw = {
      access_token: 'some_access_token',
      expires_in: undefined,
    };

    const parsed = parseTokenResponse(raw, 'default_scope');
    expect(parsed.accessToken).toBe('some_access_token');
    expect(parsed.refreshToken).toBe('');
    expect(parsed.scope).toBe('default_scope');
    expect(isNaN(new Date(parsed.expiresAt).getTime())).toBe(false);
    expect(new Date(parsed.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('uses fallbackRefreshToken when response does not return refresh_token', () => {
    const raw = {
      access_token: 'new_access_token',
      expires_in: 3600,
    };

    const parsed = parseTokenResponse(raw, 'default_scope', 'old_refresh_token');
    expect(parsed.accessToken).toBe('new_access_token');
    expect(parsed.refreshToken).toBe('old_refresh_token');
  });

  it('throws on non-object or missing access_token', () => {
    expect(() => parseTokenResponse(null, 'scope')).toThrow('payload is not an object');
    expect(() => parseTokenResponse('string', 'scope')).toThrow('payload is not an object');
    expect(() => parseTokenResponse({}, 'scope')).toThrow('missing access_token');
    expect(() => parseTokenResponse({ body: {} }, 'scope')).toThrow('missing access_token');
  });
});
