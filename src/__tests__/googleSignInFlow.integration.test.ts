process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';
process.env.GOOGLE_FIT_CLIENT_ID = process.env.GOOGLE_FIT_CLIENT_ID || 'test-google-client-id';
process.env.GOOGLE_FIT_CLIENT_SECRET = process.env.GOOGLE_FIT_CLIENT_SECRET || 'test-google-client-secret';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

/**
 * Regression coverage for #129 review feedback: the original fix stored the
 * Google Sign-In anti-CSRF state in req.session.googleOAuthState, but
 * PgSessionStore.set() silently no-ops for any session without a userId —
 * which every unauthenticated Google Sign-In attempt is, by definition. Unit
 * tests on the signing helpers alone passed while the actual HTTP flow was
 * completely broken. This drives the real /google/url -> /google/callback
 * round-trip through two independent app.inject() calls (no shared request
 * context, exactly like two separate real HTTP requests) against the real
 * PgSessionStore-backed app, mocking only the external Google endpoints.
 */
describe('Google Sign-In OAuth flow end-to-end (#129 follow-up)', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let users: any;
  let testUserId: string | undefined;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    const dbClient = await import('../db/client.js');
    const schema = await import('../db/schema.js');
    db = dbClient.db;
    users = schema.users;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (testUserId) await db.delete(users).where(eq(users.id, testUserId));
    await app.close();
  });

  it('completes Google Sign-In for an existing user via two independent requests, with no shared session state', async () => {
    const email = `google-signin-test-${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({
      email,
      passwordHash: 'not-a-real-hash',
      birthDate: '1990-01-01',
      sex: 'm',
      emailVerifiedAt: new Date(),
    }).returning();
    testUserId = user.id;

    const urlRes = await app.inject({ method: 'POST', url: '/api/auth/google/url' });
    expect(urlRes.statusCode).toBe(200);
    const { url } = JSON.parse(urlRes.body) as { url: string };
    expect(url).toBeTruthy();
    const state = new URL(url).searchParams.get('state');
    expect(state).toBeTruthy();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const requestUrl = String(input);
      if (requestUrl.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'mock-access-token' }) } as unknown as Response;
      }
      if (requestUrl.includes('googleapis.com/oauth2/v2/userinfo')) {
        return { ok: true, json: async () => ({ email, name: 'Test User' }) } as unknown as Response;
      }
      throw new Error(`Unexpected fetch to ${requestUrl}`);
    }) as typeof globalThis.fetch;

    try {
      // A brand new app.inject() call — no cookie jar, no shared request
      // context with the /google/url call above. This is exactly the
      // failure mode the review caught: if the state were session-bound,
      // this second "request" would have no way to see it.
      const callbackRes = await app.inject({
        method: 'GET',
        url: `/api/auth/google/callback?code=mock-auth-code&state=${encodeURIComponent(state!)}`,
      });

      expect(callbackRes.statusCode).toBe(302);
      expect(callbackRes.headers.location).toBe('/dashboard');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a callback whose state was never issued (forged/replayed)', async () => {
    const callbackRes = await app.inject({
      method: 'GET',
      url: '/api/auth/google/callback?code=mock-auth-code&state=forged.notavalidsignature',
    });
    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe('/login?error=google_auth_failed');
  });

  it('rejects a callback with no state at all', async () => {
    const callbackRes = await app.inject({
      method: 'GET',
      url: '/api/auth/google/callback?code=mock-auth-code',
    });
    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe('/login?error=google_auth_failed');
  });
});
