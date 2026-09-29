process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

// Deletion-confirmation emails don't depend on a real SMTP transport being
// reachable in every test environment — mock it so this suite is self-contained.
vi.mock('../lib/mail.js', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));

describe('2-step account deletion via email confirmation (#92)', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let users: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let emailTokens: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let issueEmailToken: any;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    const dbClient = await import('../db/client.js');
    const schema = await import('../db/schema.js');
    const tokenModule = await import('../lib/emailTokens.js');

    db = dbClient.db;
    users = schema.users;
    emailTokens = schema.emailTokens;
    issueEmailToken = tokenModule.issueEmailToken;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function jar() {
    const cookieJar = new Map<string, string>();
    function update(setCookieHeader: string | string[] | undefined) {
      if (!setCookieHeader) return;
      const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const c of arr) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        if (idx !== -1) cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    }
    function header() {
      return Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return { update, header };
  }

  async function createUser(email: string) {
    const { hashPassword } = await import('../lib/password.js');
    const { randomUUID } = await import('node:crypto');
    const pwHash = await hashPassword('SecureTestPassword123!');
    const [user] = await db.insert(users).values({
      id: randomUUID(),
      email,
      passwordHash: pwHash,
      birthDate: '1992-05-15',
      sex: 'm',
      emailVerifiedAt: new Date(),
    }).returning();
    return user;
  }

  async function loginAs(email: string) {
    const c = jar();
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'SecureTestPassword123!' },
    });
    expect(loginRes.statusCode).toBe(200);
    c.update(loginRes.headers['set-cookie']);

    const csrfRes = await app.inject({
      method: 'GET',
      url: '/api/auth/csrf',
      headers: { cookie: c.header() },
    });
    c.update(csrfRes.headers['set-cookie']);
    const csrfToken = JSON.parse(csrfRes.payload).csrfToken as string;
    return { c, csrfToken };
  }

  describe('POST /api/account/request-delete', () => {
    it('requires a valid session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/request-delete',
        payload: { password: 'SecureTestPassword123!' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('requires the correct password and issues a delete_account token by email', async () => {
      const user = await createUser(`req-delete-${Date.now()}@example.com`);
      const { c, csrfToken } = await loginAs(user.email);

      const wrongRes = await app.inject({
        method: 'POST',
        url: '/api/account/request-delete',
        headers: { cookie: c.header(), 'x-csrf-token': csrfToken },
        payload: { password: 'WrongPassword!' },
      });
      expect(wrongRes.statusCode).toBe(403);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/request-delete',
        headers: { cookie: c.header(), 'x-csrf-token': csrfToken },
        payload: { password: 'SecureTestPassword123!' },
      });
      expect(res.statusCode).toBe(200);

      const [token] = await db.select().from(emailTokens)
        .where(eq(emailTokens.userId, user.id))
        .limit(1);
      expect(token).toBeDefined();
      expect(token.purpose).toBe('delete_account');
      expect(token.usedAt).toBeNull();

      // The account still exists — nothing is deleted until the link is confirmed.
      const [stillThere] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      expect(stillThere).toBeDefined();

      await db.delete(users).where(eq(users.id, user.id));
    });
  });

  describe('POST /api/account/confirm-delete', () => {
    it('is public (no session required) and deletes the account for a valid token', async () => {
      const user = await createUser(`confirm-delete-${Date.now()}@example.com`);
      const token = await issueEmailToken(user.id, 'delete_account', 30 * 60 * 1000);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/confirm-delete',
        payload: { token },
      });
      expect(res.statusCode).toBe(200);

      const [gone] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      expect(gone).toBeUndefined();
    });

    it('rejects an already-used or unknown token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/confirm-delete',
        payload: { token: 'does-not-exist' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('cannot be consumed with a token issued for a different purpose', async () => {
      const user = await createUser(`wrong-purpose-${Date.now()}@example.com`);
      const token = await issueEmailToken(user.id, 'verify_email');

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/confirm-delete',
        payload: { token },
      });
      expect(res.statusCode).toBe(400);

      const [stillThere] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      expect(stillThere).toBeDefined();
      await db.delete(users).where(eq(users.id, user.id));
    });

    it('is exempt from CSRF enforcement (the confirmation token is the authorization, no cookie session exists)', async () => {
      const user = await createUser(`csrf-exempt-delete-${Date.now()}@example.com`);
      const token = await issueEmailToken(user.id, 'delete_account', 30 * 60 * 1000);

      // x-enforce-csrf forces the CSRF check even under NODE_ENV=test, mirroring
      // production behavior. No cookie or x-csrf-token header is sent — this must
      // not 403 (Victor's PR-review finding: the route was missing from isCsrfExempt).
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/confirm-delete',
        headers: { 'x-enforce-csrf': 'true' },
        payload: { token },
      });
      expect(res.statusCode).toBe(200);

      const [gone] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      expect(gone).toBeUndefined();
    });
  });
});
