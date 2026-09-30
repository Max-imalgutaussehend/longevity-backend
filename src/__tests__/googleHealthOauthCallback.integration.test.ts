process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';
process.env.GOOGLE_HEALTH_CLIENT_ID = process.env.GOOGLE_HEALTH_CLIENT_ID || 'test-google-health-client-id';
process.env.GOOGLE_HEALTH_CLIENT_SECRET = process.env.GOOGLE_HEALTH_CLIENT_SECRET || 'test-google-health-client-secret';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';

/**
 * Regression coverage for #129 review feedback: google-health shares
 * google-fit's OAuth redirect endpoint (see oauthProviders.ts), so a state
 * signed for provider 'google-health' arrives at /oauth/callback/google-fit
 * — the URL's :provider is 'google-fit' even though the connect request was
 * for 'google-health'. verifyOAuthState previously required an exact match,
 * so the review's claim was: every google-health connect attempt gets a 400.
 * This drives the real HTTP connect -> callback round-trip to prove it no
 * longer does.
 */
describe('google-health OAuth connect/callback flow (#129 follow-up)', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let users: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sources: any;
  let testUserId: string | undefined;
  let sessionCookie: string;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    const dbClient = await import('../db/client.js');
    const schema = await import('../db/schema.js');
    db = dbClient.db;
    users = schema.users;
    sources = schema.sources;
    app = await buildApp();
    await app.ready();

    // A wearable connect always originates from an authenticated session —
    // the callback now enforces that (#129 follow-up review), so tests must
    // present a real session cookie for testUserId, not just a bare state.
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `google-health-oauth-test-${Date.now()}@example.com`,
        password: 'ValidPassword123!',
        birthDate: '1990-01-01',
        sex: 'm',
      },
    });
    expect(regRes.statusCode).toBe(201);
    testUserId = JSON.parse(regRes.body).id as string;
    const setCookie = regRes.headers['set-cookie'];
    const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    sessionCookie = cookieArray.map((c) => c.split(';')[0]).join('; ');
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(sources).where(eq(sources.userId, testUserId));
      await db.delete(users).where(eq(users.id, testUserId));
    }
    await app.close();
  });

  it('signs a state for google-health and verifies it at the shared google-fit callback route', async () => {
    const { signOAuthState, verifyOAuthState } = await import('../lib/oauthState.js');

    const state = signOAuthState({ userId: testUserId!, provider: 'google-health' });

    // Exactly what the /oauth/callback/:provider handler does for :provider = 'google-fit'
    const acceptedProviders = ['google-fit', 'google-health'];
    const result = verifyOAuthState(state, acceptedProviders);

    expect(result).toEqual({ ok: true, userId: testUserId, provider: 'google-health' });
  });

  it('completes the full /oauth/callback/google-fit HTTP request for a google-health-issued state', async () => {
    const { signOAuthState } = await import('../lib/oauthState.js');
    const state = signOAuthState({ userId: testUserId!, provider: 'google-health' });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const requestUrl = String(input);
      if (requestUrl.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'mock-access-token', refresh_token: 'mock-refresh-token', expires_in: 3600, scope: 'test-scope' }),
        } as unknown as Response;
      }
      // Google Fit sample fetch — allowed to fail; the callback route
      // catches and logs this without affecting the HTTP response.
      throw new Error(`Unexpected fetch to ${requestUrl}`);
    }) as typeof globalThis.fetch;

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/oauth/callback/google-fit?code=mock-auth-code&state=${encodeURIComponent(state)}`,
        headers: { accept: 'application/json', cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; sourceId: string };
      expect(body.ok).toBe(true);

      const [src] = await db.select().from(sources)
        .where(and(eq(sources.userId, testUserId), eq(sources.kind, 'google_fit')))
        .limit(1);
      expect(src).toBeTruthy();
      expect(src.id).toBe(body.sourceId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a state signed for an unrelated provider at the google-fit callback route', async () => {
    const { signOAuthState } = await import('../lib/oauthState.js');
    const state = signOAuthState({ userId: testUserId!, provider: 'withings' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth/callback/google-fit?code=mock-auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a callback with a valid state but no session cookie at all (#129 review — session must always be required, not just checked when present)', async () => {
    const { signOAuthState } = await import('../lib/oauthState.js');
    const state = signOAuthState({ userId: testUserId!, provider: 'google-health' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth/callback/google-fit?code=mock-auth-code&state=${encodeURIComponent(state)}`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('rejects a callback whose state names a different user than the active session (#107 issue requirement)', async () => {
    const { signOAuthState } = await import('../lib/oauthState.js');

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `google-health-session-mismatch-${Date.now()}@example.com`,
        password: 'ValidPassword123!',
        birthDate: '1990-05-15',
        sex: 'f',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const setCookie = regRes.headers['set-cookie'];
    const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    const otherUserSessionCookie = cookieArray.map((c) => c.split(';')[0]).join('; ');
    const sessionUserId = JSON.parse(regRes.body).id as string;

    try {
      // State signed for a DIFFERENT user than the one whose session cookie is presented.
      const stateForOtherUser = signOAuthState({ userId: testUserId!, provider: 'google-health' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/oauth/callback/google-fit?code=mock-auth-code&state=${encodeURIComponent(stateForOtherUser)}`,
        headers: { cookie: otherUserSessionCookie },
      });

      expect(res.statusCode).toBe(403);
    } finally {
      await db.delete(users).where(eq(users.id, sessionUserId));
    }
  });
});
