process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

// Force production mode so the test/dev/CI rate-limit bypass in each route
// doesn't apply — this file specifically verifies real 429 behavior. Saved
// and restored in afterAll in case this vitest worker process is reused for
// other test files.
const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  CI: process.env.CI,
  SIGNING_KEY_PRIVATE: process.env.SIGNING_KEY_PRIVATE,
  SIGNING_KEY_PUBLIC: process.env.SIGNING_KEY_PUBLIC,
  PASSWORD_PEPPER: process.env.PASSWORD_PEPPER,
};
process.env.NODE_ENV = 'production';
delete process.env.CI;
process.env.SIGNING_KEY_PRIVATE = process.env.SIGNING_KEY_PRIVATE || '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKZ8s8j8u9r5nq3b1r5b8r2r3r5b8r2r3r5b8r2r3r5b\n-----END PRIVATE KEY-----';
process.env.SIGNING_KEY_PUBLIC = process.env.SIGNING_KEY_PUBLIC || '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA1z6z1z6z1z6z1z6z1z6z1z6z1z6z1z6z1z6z1z6z1z4=\n-----END PUBLIC KEY-----';
process.env.PASSWORD_PEPPER = process.env.PASSWORD_PEPPER || 'test-password-pepper-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const HAS_DB = !!process.env.DATABASE_URL;

// Issue #102: global baseline + endpoint-specific rate limits actually
// trigger 429 in production mode (all other integration tests run with
// NODE_ENV=test/development, which intentionally bypasses these limits).
describe.skipIf(!HAS_DB)('Issue #102: rate limiting (production mode)', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();

    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(tables.users).where(eq(tables.users.id, id)).catch(() => {});
    }
    await app.close();

    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects the 6th registration attempt from the same IP within 15 minutes (max 5)', async () => {
    let lastRes;
    for (let i = 0; i < 6; i++) {
      lastRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: `ratelimit-register-${Date.now()}-${i}@test.local`,
          password: 'RateLimit-Test-2026',
          birthDate: '1990-01-01',
          sex: 'm',
        },
      });
      if (lastRes.statusCode === 201) {
        const body = JSON.parse(lastRes.payload);
        createdUserIds.push(body.id);
      }
    }
    expect(lastRes!.statusCode).toBe(429);
  });

  it('rejects the 31st verify/:id request from the same IP within 1 minute (max 30)', async () => {
    let lastRes;
    for (let i = 0; i < 31; i++) {
      lastRes = await app.inject({ method: 'GET', url: '/api/verify/00000000-0000-0000-0000-000000000000' });
    }
    expect(lastRes!.statusCode).toBe(429);
  });

  it('emits standard RateLimit-Limit/Remaining/Reset headers alongside the legacy x-ratelimit-* ones', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
    expect(res.headers['ratelimit-reset']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });
});
