process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Issue #79: registration webhookSecret', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let users: any;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();

    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    users = schemaModule.users;
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
    await app.close();
  });

  it('successfully registers a new user with a valid 64-char hex webhookSecret', async () => {
    const email = `issue79-test-${Date.now()}@longevity.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email,
        password: 'ValidPassword123!',
        birthDate: '1995-05-15',
        sex: 'm',
        displayName: 'Issue 79 Tester',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.id).toBeDefined();
    createdUserIds.push(body.id);

    const [dbUser] = await db.select().from(users).where(eq(users.id, body.id));
    expect(dbUser).toBeDefined();
    expect(dbUser.webhookSecret).toBeTruthy();
    expect(typeof dbUser.webhookSecret).toBe('string');
    expect(dbUser.webhookSecret.length).toBe(64);
  });
});
