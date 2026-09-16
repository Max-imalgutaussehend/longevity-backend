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
