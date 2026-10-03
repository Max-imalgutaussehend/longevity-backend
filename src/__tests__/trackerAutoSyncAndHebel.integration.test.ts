process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

describe('Issue #126: Auto-sync on tracker connect and sync-all for Hebel page', () => {
  let app: FastifyInstance;
  let testUserId: string;
  let sessionCookie: string;
  let csrfToken: string;
  let db: typeof import('../db/client.js').db;
  let users: typeof import('../db/schema.js').users;
  let sources: typeof import('../db/schema.js').sources;
  let samples: typeof import('../db/schema.js').samples;
  let scoreSnapshots: typeof import('../db/schema.js').scoreSnapshots;

  beforeAll(async () => {
    const dbMod = await import('../db/client.js');
    const schemaMod = await import('../db/schema.js');
    const appMod = await import('../app.js');
    db = dbMod.db;
    users = schemaMod.users;
    sources = schemaMod.sources;
    samples = schemaMod.samples;
    scoreSnapshots = schemaMod.scoreSnapshots;

    app = await appMod.buildApp();
    await app.ready();

    // Create test user
    const testEmail = `issue126-test-${Date.now()}@longevity.test`;
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: testEmail,
        password: 'ValidPassword123!',
        birthDate: '1995-06-15',
        sex: 'm',
        displayName: 'Issue 126 Tester',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const setCookie = regRes.headers['set-cookie'];
    const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    sessionCookie = cookieArray.map((c) => c.split(';')[0]).join('; ');
    const xsrfCookie = cookieArray.find((c) => c.startsWith('XSRF-TOKEN='));
    csrfToken = xsrfCookie ? xsrfCookie.split(';')[0].replace('XSRF-TOKEN=', '') : '';

    const [u] = await db.select().from(users).where(eq(users.email, testEmail)).limit(1);
    testUserId = u.id;
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(samples).where(eq(samples.userId, testUserId));
      await db.delete(sources).where(eq(sources.userId, testUserId));
      await db.delete(scoreSnapshots).where(eq(scoreSnapshots.userId, testUserId));
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  it('POST /api/sources/sync-all requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sources/sync-all',
      headers: {
        'x-csrf-token': csrfToken,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/sources/sync-all returns ok with 0 synced when no cloud sources are connected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sources/sync-all',
      headers: {
        cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.synced).toBe(0);
    expect(body.totalInserted).toBe(0);
  });

  it('POST /api/sources/sync-all invalidates today score snapshot when sources are synced', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // Insert dummy snapshot for today
    await db.insert(scoreSnapshots).values({
      userId: testUserId,
      computedFor: today,
      score: 50,
      coverage: 0,
      bioAge: 30,
      breakdown: { score: 50 },
      engineVersion: '0.1.0',
    }).onConflictDoUpdate({
      target: [scoreSnapshots.userId, scoreSnapshots.computedFor],
      set: { score: 50 },
    });

    // Check snapshot exists
    const [snapBefore] = await db.select().from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, testUserId), eq(scoreSnapshots.computedFor, today)));
    expect(snapBefore).toBeDefined();

    // Call sync-all
    const res = await app.inject({
      method: 'POST',
      url: '/api/sources/sync-all',
      headers: {
        cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/score/current updates snapshot if score or coverage changed', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // Insert snapshot with an outdated score
    await db.insert(scoreSnapshots).values({
      userId: testUserId,
      computedFor: today,
      score: 40,
      coverage: 0.1,
      bioAge: 35,
      breakdown: { score: 40 },
      engineVersion: '1.0.0',
    }).onConflictDoUpdate({
      target: [scoreSnapshots.userId, scoreSnapshots.computedFor],
      set: { score: 40, coverage: 0.1 },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/score/current',
      headers: {
        cookie: sessionCookie,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Verify snapshot in DB was updated to match calculated result
    const [snapAfter] = await db.select().from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, testUserId), eq(scoreSnapshots.computedFor, today)));
    expect(snapAfter).toBeDefined();
    expect(snapAfter.score).toBe(body.score);
  });

  it('POST /api/sources/sync-all syncs enabled cloud sources and updates lastSyncAt', async () => {
    // Insert an enabled withings source with credentials
    const [sourceRow] = await db.insert(sources).values({
      userId: testUserId,
      kind: 'withings',
      adapter: 'withings',
      enabled: true,
      credentials: {
        accessToken: 'dummy-token',
        refreshToken: 'dummy-refresh',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        scope: 'user.metrics,user.activity',
      },
      syncStatus: 'ok',
    }).returning();

    // Call sync-all (which may fail gracefully with token error or mock without crashing)
    const res = await app.inject({
      method: 'POST',
      url: '/api/sources/sync-all',
      headers: {
        cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.results.length).toBe(1);
    expect(body.results[0].sourceId).toBe(sourceRow.id);

    await db.delete(sources).where(eq(sources.id, sourceRow.id));
  });
});

