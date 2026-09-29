process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

describe('POST /api/auth/verify-email establishes a session (#88)', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let users: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let issueEmailToken: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testUser: any;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    const dbClient = await import('../db/client.js');
    const schema = await import('../db/schema.js');
    const { hashPassword } = await import('../lib/password.js');
    const tokenModule = await import('../lib/emailTokens.js');

    db = dbClient.db;
    users = schema.users;
    issueEmailToken = tokenModule.issueEmailToken;
    app = await buildApp();
    await app.ready();

    const { randomUUID } = await import('node:crypto');
    const userId = randomUUID();
    const email = `verify-session-test-${Date.now()}@example.com`;
    const pwHash = await hashPassword('SecureTestPassword123!');

    const [user] = await db.insert(users).values({
      id: userId,
      email,
      passwordHash: pwHash,
      birthDate: '1992-05-15',
      sex: 'm',
    }).returning();

    testUser = user;
  });

  afterAll(async () => {
    if (testUser) {
      await db.delete(users).where(eq(users.id, testUser.id));
    }
    await app.close();
  });

  it('logs the user in and sets session/CSRF cookies after verifying their email', async () => {
    const token = await issueEmailToken(testUser.id, 'verify_email');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token },
    });

    expect(res.statusCode).toBe(200);

    const setCookies = res.headers['set-cookie'];
    expect(setCookies).toBeDefined();
    const cookieArray = Array.isArray(setCookies) ? setCookies : [setCookies as string];

    const sessionCookie = cookieArray.find(c => c.startsWith('sessionId='));
    expect(sessionCookie).toBeDefined();

    const [dbUser] = await db.select().from(users).where(eq(users.id, testUser.id)).limit(1);
    expect(dbUser.emailVerifiedAt).not.toBeNull();

    // The freshly issued session cookie should authenticate the /me endpoint.
    const cookieHeader = cookieArray.map((c: string) => c.split(';')[0]).join('; ');
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookieHeader },
    });
    expect(meRes.statusCode).toBe(200);
    const meBody = JSON.parse(meRes.payload);
    expect(meBody.id).toBe(testUser.id);
  });
});
