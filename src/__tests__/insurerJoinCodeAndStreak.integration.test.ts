process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';

const HAS_DB = !!process.env.DATABASE_URL;

function extractCookieHeader(setCookie: string | string[] | undefined): string {
  const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie as string];
  return cookieArray.map((c) => c.split(';')[0]).join('; ');
}

// Issue #99: GET /api/insurer/overview must return the organization's own
// joinCode, and the weekly report's streakDays must reflect consecutive days
// with actual wearable samples, not the count of score-snapshot rows.
describe.skipIf(!HAS_DB)('Issue #99: insurer joinCode + wearable streak', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let orgId: string;
  let insurerCookie: string;
  let insurerUserId: string;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();

    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [org] = await db.insert(tables.organizations).values({
      name: 'Testkasse Streak GmbH',
      contactEmail: 'streak-test@testkasse.de',
      joinCode: `streak-test-${Date.now()}`,
    }).returning();
    orgId = org.id;

    const passwordHash = await hash('insurer-test-password-2026');
    const [insurer] = await db.insert(tables.users).values({
      email: `insurer-streak-test-${Date.now()}@test.local`,
      passwordHash,
      birthDate: '1980-01-01',
      sex: 'f',
      role: 'insurer_admin',
      organizationId: orgId,
    }).returning();
    insurerUserId = insurer.id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: insurer.email, password: 'insurer-test-password-2026' },
    });
    expect(loginRes.statusCode).toBe(200);
    insurerCookie = extractCookieHeader(loginRes.headers['set-cookie']);
  });

  afterAll(async () => {
    if (insurerUserId) await db.delete(tables.users).where(eq(tables.users.id, insurerUserId));
    if (orgId) await db.delete(tables.organizations).where(eq(tables.organizations.id, orgId));
    await app.close();
  });

  it('GET /api/insurer/overview returns the organization joinCode', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/insurer/overview',
      headers: { cookie: insurerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const [org] = await db.select().from(tables.organizations).where(eq(tables.organizations.id, orgId));
    expect(body.joinCode).toBe(org.joinCode);
  });

  describe('weekly report streakDays', () => {
    let userId: string;
    let userEmail: string;
    let userCookie: string;
    let sourceId: string;

    beforeAll(async () => {
      userEmail = `streak-user-${Date.now()}@test.local`;
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: userEmail, password: 'StreakTest-2026', birthDate: '1990-01-01', sex: 'm' },
      });
      expect(regRes.statusCode).toBe(201);
      userCookie = extractCookieHeader(regRes.headers['set-cookie']);

      const [u] = await db.select().from(tables.users).where(eq(tables.users.email, userEmail));
      userId = u.id;

      const [source] = await db.insert(tables.sources).values({
        userId,
        kind: 'oura',
        adapter: 'oura',
        enabled: true,
      }).returning();
      sourceId = source.id;
    });

    afterAll(async () => {
      if (userId) await db.delete(tables.users).where(eq(tables.users.id, userId));
    });

    it('counts only consecutive days with wearable samples, not snapshot rows', async () => {
      const today = new Date();
      // Wearable samples for today and the 2 preceding days (streak of 3),
      // then a gap (no sample 3 days ago) — streak must stop there even
      // though a score snapshot could exist for that day too.
      const sampleDays = [0, 1, 2];
      for (const daysAgo of sampleDays) {
        const measuredAt = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        await db.insert(tables.samples).values({
          userId,
          sourceId,
          metric: 'resting_hr',
          value: 55,
          unit: 'bpm',
          measuredAt,
        });
      }

      // A score snapshot 5 days ago with no corresponding wearable sample —
      // this is exactly the case the old `rows.length` logic miscounted.
      const fiveDaysAgo = new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await db.insert(tables.scoreSnapshots).values({
        userId,
        computedFor: fiveDaysAgo,
        score: 60,
        coverage: 0.5,
        bioAge: 40,
        breakdown: {},
        engineVersion: 'test',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/report/weekly',
        headers: { cookie: userCookie },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.streakDays).toBe(3);
    });
  });
});
