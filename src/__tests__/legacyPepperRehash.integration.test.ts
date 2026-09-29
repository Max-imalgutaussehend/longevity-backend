process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { hash } from '@node-rs/argon2';

const DEFAULT_PEPPER = 'longevity-default-pepper-secret-32b-long!';

describe('Login transparently rehashes legacy default-pepper accounts (#90 follow-up)', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let users: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ARGON2_OPTIONS: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testUser: any;

  const rawPassword = 'LegacyPrePepperLogin123!';

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    const dbClient = await import('../db/client.js');
    const schema = await import('../db/schema.js');
    const passwordModule = await import('../lib/password.js');

    db = dbClient.db;
    users = schema.users;
    ARGON2_OPTIONS = passwordModule.ARGON2_OPTIONS;
    app = await buildApp();
    await app.ready();

    const { randomUUID } = await import('node:crypto');
    const defaultPepperedHex = createHmac('sha256', DEFAULT_PEPPER).update(rawPassword).digest('hex');
    const legacyHash = await hash(defaultPepperedHex, ARGON2_OPTIONS);

    const [user] = await db.insert(users).values({
      id: randomUUID(),
      email: `legacy-pepper-rehash-${Date.now()}@example.com`,
      passwordHash: legacyHash,
      birthDate: '1992-05-15',
      sex: 'm',
      emailVerifiedAt: new Date(),
    }).returning();

    testUser = user;
  });

  afterAll(async () => {
    if (testUser) await db.delete(users).where(eq(users.id, testUser.id));
    await app.close();
  });

  it('logs in successfully and rewrites the stored hash to use the current pepper', async () => {
    const originalPepper = process.env.PASSWORD_PEPPER;
    process.env.PASSWORD_PEPPER = 'a-distinct-individual-production-pepper-32b!';
    try {
      const [before] = await db.select().from(users).where(eq(users.id, testUser.id)).limit(1);
      const hashBeforeLogin = before.passwordHash;

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: testUser.email, password: rawPassword },
      });
      expect(res.statusCode).toBe(200);

      const [after] = await db.select().from(users).where(eq(users.id, testUser.id)).limit(1);
      expect(after.passwordHash).not.toBe(hashBeforeLogin);

      // A second login with the same password must still succeed against the rewritten hash.
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: testUser.email, password: rawPassword },
      });
      expect(res2.statusCode).toBe(200);

      // ...and the hash no longer changes on subsequent logins (already on the current pepper).
      const [afterSecond] = await db.select().from(users).where(eq(users.id, testUser.id)).limit(1);
      expect(afterSecond.passwordHash).toBe(after.passwordHash);
    } finally {
      if (originalPepper === undefined) delete process.env.PASSWORD_PEPPER;
      else process.env.PASSWORD_PEPPER = originalPepper;
    }
  });
});
