process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';
process.env.GOOGLE_FIT_CLIENT_ID = process.env.GOOGLE_FIT_CLIENT_ID || 'test-google-client-id';
process.env.GOOGLE_FIT_CLIENT_SECRET = process.env.GOOGLE_FIT_CLIENT_SECRET || 'test-google-client-secret';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

/**
 * Regression coverage for #129 review feedback (two rounds):
 *
 * Round 1: the original fix stored the Google Sign-In anti-CSRF state in
 * req.session.googleOAuthState, but PgSessionStore.set() silently no-ops for
 * any session without a userId — which every unauthenticated Google Sign-In
 * attempt is, by definition. Unit tests on the signing helpers alone passed
 * while the actual HTTP flow was completely broken.
 *
 * Round 2: the fix for round 1 replaced session-bound state with a purely
 * server-signed, session-less nonce — which closes the "does this app's
 * server trust this state" question but not "did THIS browser receive this
 * state", i.e. it provides no actual CSRF protection (RFC 6749 §10.12 login
 * CSRF: an attacker can start their own flow, obtain a valid state/code
 * pair, and hand the resulting callback URL to a victim). The fix now binds
 * the state to an HTTP-only cookie set alongside it, so a callback must
 * present the SAME browser's cookie, not merely a validly-signed state.
 *
 * This drives the real /google/url -> /google/callback round-trip through
 * two independent app.inject() calls against the real PgSessionStore-backed
 * app, carrying forward the Set-Cookie from the first response into the
 * second — exactly what a real browser does, and exactly what an attacker
 * relaying a bare callback URL to a victim cannot forge.
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

  function extractCookieHeader(setCookie: string | string[] | undefined): string {
    const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    return cookieArray.map((c) => c.split(';')[0]).join('; ');
  }

  it('completes Google Sign-In for an existing user, carrying the state cookie from /google/url into the callback like a real browser would', async () => {
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
    const stateCookie = extractCookieHeader(urlRes.headers['set-cookie']);
    expect(stateCookie).toContain('google_oauth_state=');

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
      // A separate app.inject() call, but carrying forward the Set-Cookie
      // from the /google/url response — exactly what a real browser does
      // across the redirect to Google and back. No shared in-process
      // request context, no server-side session state; only the cookie.
      const callbackRes = await app.inject({
        method: 'GET',
        url: `/api/auth/google/callback?code=mock-auth-code&state=${encodeURIComponent(state!)}`,
        headers: { cookie: stateCookie },
      });

      expect(callbackRes.statusCode).toBe(302);
      expect(callbackRes.headers.location).toBe('/dashboard');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a callback with a validly-signed state but no matching cookie (login CSRF — attacker relays their own callback URL to a victim)', async () => {
    const urlRes = await app.inject({ method: 'POST', url: '/api/auth/google/url' });
    const { url } = JSON.parse(urlRes.body) as { url: string };
    const state = new URL(url).searchParams.get('state');

    // The victim's browser never received the attacker's state cookie — the
    // attacker can only hand over the URL, not their own HTTP-only cookie.
    const callbackRes = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=attacker-auth-code&state=${encodeURIComponent(state!)}`,
    });

    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe('/login?error=google_auth_failed');
  });

  it('rejects a callback whose state cookie does not match the state query parameter', async () => {
    const firstUrlRes = await app.inject({ method: 'POST', url: '/api/auth/google/url' });
    const firstCookie = extractCookieHeader(firstUrlRes.headers['set-cookie']);

    const secondUrlRes = await app.inject({ method: 'POST', url: '/api/auth/google/url' });
    const { url: secondUrl } = JSON.parse(secondUrlRes.body) as { url: string };
    const secondState = new URL(secondUrl).searchParams.get('state');

    // Cookie from flow #1, state query param from flow #2 — mismatched pair.
    const callbackRes = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=mock-auth-code&state=${encodeURIComponent(secondState!)}`,
      headers: { cookie: firstCookie },
    });

    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe('/login?error=google_auth_failed');
  });

  it('rejects a callback whose state was never issued (forged/replayed)', async () => {
    const callbackRes = await app.inject({
      method: 'GET',
      url: '/api/auth/google/callback?code=mock-auth-code&state=forged.notavalidsignature',
      headers: { cookie: 'google_oauth_state=forged.notavalidsignature' },
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
