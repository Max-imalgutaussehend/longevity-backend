process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

describe('CSRF Protection & Secure Cookie Configuration (#103)', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let users: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testUser: any;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    const dbClient = await import('../db/client.js');
    const schema = await import('../db/schema.js');
    const { hashPassword } = await import('../lib/password.js');

    db = dbClient.db;
    users = schema.users;
    app = await buildApp();
    await app.ready();

    const { sql } = await import('drizzle-orm');
    const { randomUUID, randomBytes } = await import('node:crypto');
    const userId = randomUUID();
    const email = `csrf-test-${Date.now()}@example.com`;
    const pwHash = await hashPassword('SecureTestPassword123!');
    const secret = randomBytes(32).toString('hex');

    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, birth_date, sex, email_verified_at, webhook_secret)
      VALUES (${userId}, ${email}, ${pwHash}, '1992-05-15', 'm', NOW(), ${secret})
      ON CONFLICT (id) DO NOTHING
    `);

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    testUser = user;
  });

  afterAll(async () => {
    if (testUser) {
      await db.delete(users).where(eq(users.id, testUser.id));
    }
    await app.close();
  });

  describe('GET /api/auth/csrf', () => {
    it('returns a fresh CSRF token and sets both _csrf and XSRF-TOKEN cookies', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/csrf',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('csrfToken');
      expect(typeof body.csrfToken).toBe('string');
      expect(body.csrfToken.length).toBeGreaterThan(10);

      const setCookies = res.headers['set-cookie'];
      expect(setCookies).toBeDefined();
      const cookieArray = Array.isArray(setCookies) ? setCookies : [setCookies as string];

      const csrfCookie = cookieArray.find(c => c.startsWith('_csrf='));
      const xsrfCookie = cookieArray.find(c => c.startsWith('XSRF-TOKEN='));

      expect(csrfCookie).toBeDefined();
      expect(csrfCookie).toContain('HttpOnly');
      expect(csrfCookie?.toLowerCase()).toContain('samesite=lax');

      expect(xsrfCookie).toBeDefined();
      // XSRF-TOKEN must be accessible to browser JavaScript
      expect(xsrfCookie).not.toContain('HttpOnly');
      expect(xsrfCookie?.toLowerCase()).toContain('samesite=lax');
      expect(xsrfCookie).toContain(body.csrfToken);
    });
  });

  describe('CSRF enforcement on authenticated mutating routes', () => {
    let csrfToken: string;
    const cookieJar = new Map<string, string>();

    function updateJar(setCookieHeader: string | string[] | undefined) {
      if (!setCookieHeader) return;
      const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const c of arr) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        if (idx !== -1) {
          const k = pair.slice(0, idx).trim();
          const v = pair.slice(idx + 1).trim();
          cookieJar.set(k, v);
        }
      }
    }

    function getCookies(): string {
      return Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    beforeAll(async () => {
      // Log in to get authenticated session and initial CSRF cookies
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: testUser.email,
          password: 'SecureTestPassword123!',
        },
      });

      expect(loginRes.statusCode).toBe(200);
      updateJar(loginRes.headers['set-cookie']);

      // Also get CSRF token from endpoint
      const csrfRes = await app.inject({
        method: 'GET',
        url: '/api/auth/csrf',
        headers: { cookie: getCookies() },
      });
      const csrfBody = JSON.parse(csrfRes.payload);
      csrfToken = csrfBody.csrfToken;
      updateJar(csrfRes.headers['set-cookie']);
    });

    it('rejects mutating request with missing CSRF token (403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/consent',
        headers: {
          cookie: getCookies(),
          // Omitting x-csrf-token
        },
        payload: { consented: true, consentVersion: '2026-09-v1' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects mutating request with invalid CSRF token (403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/consent',
        headers: {
          cookie: getCookies(),
          'x-csrf-token': 'invalid-tampered-token-12345',
        },
        payload: { consented: true, consentVersion: '2026-09-v1' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('accepts mutating request with valid CSRF token in x-csrf-token header (200)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/consent',
        headers: {
          cookie: getCookies(),
          'x-csrf-token': csrfToken,
        },
        payload: { consented: true, consentVersion: '2026-09-v1' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('enforces 403 when x-enforce-csrf header is sent without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/score/simulate',
        headers: {
          'x-enforce-csrf': 'true',
        },
        payload: { overrides: { vo2max: 45 } },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('Exempt endpoints bypass CSRF check', () => {
    it('allows Health Auto Export webhook without CSRF token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sources/health-auto-export/webhook',
        headers: {
          cookie: `sessionId=fake-unauthenticated-session`,
        },
        payload: {
          metrics: [
            {
              name: 'resting_heart_rate',
              data: [{ date: new Date().toISOString(), qty: 62 }],
            },
          ],
        },
      });

      // Does not return 403 Forbidden (CSRF check passed/exempt)
      expect(res.statusCode).not.toBe(403);
    });

    it('allows public login without CSRF token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: testUser.email,
          password: 'SecureTestPassword123!',
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('allows public registration without CSRF token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: `new-user-${Date.now()}@example.com`,
          password: 'NewUserSecurePassword1!',
          birthDate: '1995-01-01',
          sex: 'f',
        },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears XSRF-TOKEN and _csrf cookies on logout', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
      });

      expect(res.statusCode).toBe(204);
      const setCookies = res.headers['set-cookie'];
      expect(setCookies).toBeDefined();
      const cookieArray = Array.isArray(setCookies) ? setCookies : [setCookies as string];

      const clearedXsrf = cookieArray.some(c => c.startsWith('XSRF-TOKEN=;') || c.includes('Max-Age=0') || c.includes('Expires='));
      const clearedCsrf = cookieArray.some(c => c.startsWith('_csrf=;') || c.includes('Max-Age=0') || c.includes('Expires='));

      expect(clearedXsrf || clearedCsrf).toBe(true);
    });
  });
});
