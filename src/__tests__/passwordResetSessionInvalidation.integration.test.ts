process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

describe('Server-side session invalidation on password reset (#108)', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let users: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sessions: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let issueEmailToken: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testUser: any;
  let oldSessionId: string;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    const dbClient = await import('../db/client.js');
    const schema = await import('../db/schema.js');
    const { hashPassword } = await import('../lib/password.js');
    const tokenModule = await import('../lib/emailTokens.js');

    db = dbClient.db;
    users = schema.users;
    sessions = schema.sessions;
    issueEmailToken = tokenModule.issueEmailToken;
    app = await buildApp();
    await app.ready();

    const { randomUUID } = await import('node:crypto');
    const userId = randomUUID();
    const email = `reset-session-invalidation-${Date.now()}@example.com`;
    const pwHash = await hashPassword('OriginalPassword123!');

    const [user] = await db.insert(users).values({
      id: userId,
      email,
      passwordHash: pwHash,
      birthDate: '1990-01-01',
      sex: 'm',
      emailVerifiedAt: new Date(),
    }).returning();

    testUser = user;

    // Simulate active sessions across two devices (e.g. mobile and laptop)
    oldSessionId = `session-device-1-${Date.now()}`;
    const secondSessionId = `session-device-2-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db.insert(sessions).values([
      { id: oldSessionId, userId: testUser.id, expiresAt },
      { id: secondSessionId, userId: testUser.id, expiresAt },
    ]);
  });

  afterAll(async () => {
    if (testUser) {
      await db.delete(users).where(eq(users.id, testUser.id));
    }
    await app.close();
  });

  it('deletes all active sessions for the user when password is reset', async () => {
    // Verify sessions exist before password reset
    const sessionsBefore = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
    expect(sessionsBefore.length).toBe(2);

    // Issue password reset token
    const token = await issueEmailToken(testUser.id, 'reset_password');

    // Perform password reset via POST /api/auth/reset-password
    const newPassword = 'BrandNewSecurePassword123!';
    const resetRes = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: {
        token,
        password: newPassword,
      },
    });

    expect(resetRes.statusCode).toBe(200);
    const body = JSON.parse(resetRes.body);
    expect(body.ok).toBe(true);

    // Verify all active sessions were purged from the database
    const sessionsAfter = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
    expect(sessionsAfter).toHaveLength(0);

    // Attempting to access authenticated route with old session cookie must be rejected (401)
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: {
        sessionId: oldSessionId,
      },
    });
    expect(meRes.statusCode).toBe(401);

    // Verify old password no longer works
    const oldLoginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: testUser.email,
        password: 'OriginalPassword123!',
      },
    });
    expect(oldLoginRes.statusCode).toBe(401);

    // Verify new password works
    const newLoginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: testUser.email,
        password: newPassword,
      },
    });
    expect(newLoginRes.statusCode).toBe(200);
  });
});
