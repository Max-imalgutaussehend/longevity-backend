process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

describe('Issue #98: Health Auto Export Webhook Token-Auth & Questionnaire Separation', () => {
  let app: FastifyInstance;
  let testUserId: string;
  let testUserSecret: string;
  let sessionCookie: string;
  let csrfToken: string;
  let db: typeof import('../db/client.js').db;
  let users: typeof import('../db/schema.js').users;
  let sources: typeof import('../db/schema.js').sources;
  let samples: typeof import('../db/schema.js').samples;

  beforeAll(async () => {
    const dbMod = await import('../db/client.js');
    const schemaMod = await import('../db/schema.js');
    const appMod = await import('../app.js');
    db = dbMod.db;
    users = schemaMod.users;
    sources = schemaMod.sources;
    samples = schemaMod.samples;

    app = await appMod.buildApp();
    await app.ready();

    // Create test user
    const testEmail = `issue98-test-${Date.now()}@longevity.test`;
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: testEmail,
        password: 'ValidPassword123!',
        birthDate: '1990-05-15',
        sex: 'm',
        displayName: 'Issue 98 Tester',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const setCookie = regRes.headers['set-cookie'];
    const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    sessionCookie = cookieArray.map(c => c.split(';')[0]).join('; ');
    const xsrfCookie = cookieArray.find(c => c.startsWith('XSRF-TOKEN='));
    csrfToken = xsrfCookie ? xsrfCookie.split(';')[0].replace('XSRF-TOKEN=', '') : '';

    const [u] = await db.select().from(users).where(eq(users.email, testEmail)).limit(1);
    testUserId = u.id;
    testUserSecret = u.webhookSecret;
    expect(testUserSecret).toBeDefined();
    expect(testUserSecret.length).toBe(64);
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
    await app.close();
  });

  describe('Health Auto Export Webhook Token Auth', () => {
    it('accepts background webhook via URL secret without any session cookie', async () => {
      const mockPayload = {
        data: {
          metrics: [
            {
              name: 'HeartRate',
              units: 'bpm',
              data: [
                {
                  date: '2026-09-27T12:00:00Z',
                  qty: 58,
                },
              ],
            },
            {
              name: 'StepCount',
              units: 'count',
              data: [
                {
                  date: '2026-09-27T12:00:00Z',
                  qty: 8500,
                },
              ],
            },
          ],
        },
      };

      const res = await app.inject({
        method: 'POST',
        url: `/api/sources/health-auto-export/webhook/${testUserSecret}`,
        payload: mockPayload,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.inserted).toBeGreaterThan(0);
      expect(body.sourceId).toBeDefined();

      // Verify source was created with kind apple_health, adapter health_auto_export
      const [src] = await db.select().from(sources).where(eq(sources.id, body.sourceId)).limit(1);
      expect(src.kind).toBe('apple_health');
      expect(src.adapter).toBe('health_auto_export');
      expect(src.enabled).toBe(true);
    });

    it('rejects webhook requests with invalid or nonexistent secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sources/health-auto-export/webhook/invalid_secret_1234567890abcdef',
        payload: { data: { metrics: [] } },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects webhook POST /api/sources/health-auto-export/webhook without secret even with valid session cookie (#110)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sources/health-auto-export/webhook',
        headers: { cookie: sessionCookie },
        payload: {
          data: {
            metrics: [
              {
                name: 'StepCount',
                units: 'count',
                data: [{ date: '2026-09-27T12:00:00Z', qty: 9999 }],
              },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('accepts webhook POST /api/sources/health-auto-export/webhook with query secret (#110)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sources/health-auto-export/webhook?secret=${testUserSecret}`,
        payload: {
          data: {
            metrics: [
              {
                name: 'StepCount',
                units: 'count',
                data: [{ date: '2026-09-27T12:00:00Z', qty: 1000 }],
              },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('accepts webhook POST /api/sources/health-auto-export/webhook with x-webhook-secret header (#110)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sources/health-auto-export/webhook',
        headers: { 'x-webhook-secret': testUserSecret },
        payload: {
          data: {
            metrics: [
              {
                name: 'StepCount',
                units: 'count',
                data: [{ date: '2026-09-27T12:00:00Z', qty: 1000 }],
              },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows authenticated user to fetch their webhook secret and URL', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sources/health-auto-export/secret',
        headers: { cookie: sessionCookie },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.webhookSecret).toBe(testUserSecret);
      expect(body.webhookUrl).toContain(`/api/sources/health-auto-export/webhook/${testUserSecret}`);
    });

    it('allows rotating the webhook secret', async () => {
      const rotateRes = await app.inject({
        method: 'POST',
        url: '/api/sources/health-auto-export/secret/rotate',
        headers: { cookie: sessionCookie, 'x-csrf-token': csrfToken },
      });
      expect(rotateRes.statusCode).toBe(200);
      const body = JSON.parse(rotateRes.body);
      const newSecret = body.webhookSecret;
      expect(newSecret).not.toBe(testUserSecret);
      expect(newSecret.length).toBe(64);

      // Old secret should now be rejected
      const oldReq = await app.inject({
        method: 'POST',
        url: `/api/sources/health-auto-export/webhook/${testUserSecret}`,
        payload: { data: { metrics: [] } },
      });
      expect(oldReq.statusCode).toBe(401);

      // New secret should succeed
      const newReq = await app.inject({
        method: 'POST',
        url: `/api/sources/health-auto-export/webhook/${newSecret}`,
        payload: {
          data: {
            metrics: [
              {
                name: 'HeartRate',
                units: 'bpm',
                data: [{ date: '2026-09-27T13:00:00Z', qty: 57 }],
              },
            ],
          },
        },
      });
      expect(newReq.statusCode).toBe(200);

      // Update testUserSecret
      testUserSecret = newSecret;
    });
  });

  describe('Questionnaire Source Separation', () => {
    it('saves lifestyle values to questionnaire source under kind: questionnaire', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/questionnaire',
        headers: { cookie: sessionCookie, 'x-csrf-token': csrfToken },
        payload: {
          values: [
            { metric: 'smoking', value: 0, unit: 'category' },
            { metric: 'alcohol_units', value: 2, unit: 'units/week' },
            { metric: 'strength_sessions', value: 5, unit: '/week' },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.inserted).toEqual(expect.arrayContaining(['smoking', 'alcohol_units', 'strength_sessions']));

      const [questSrc] = await db.select().from(sources).where(eq(sources.id, body.sourceId)).limit(1);
      expect(questSrc.kind).toBe('questionnaire');
      expect(questSrc.adapter).toBe('manual');
      expect(questSrc.enabled).toBe(true);
    });

    it('supports alias POST /api/lifestyle', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/lifestyle',
        headers: { cookie: sessionCookie, 'x-csrf-token': csrfToken },
        payload: {
          values: [{ metric: 'alcohol_units', value: 3, unit: 'units/week' }],
        },
      });
      expect(res.statusCode).toBe(201);
    });

    it('routes smoking and alcohol to questionnaire even when sent via POST /api/labs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/labs',
        headers: { cookie: sessionCookie, 'x-csrf-token': csrfToken },
        payload: {
          values: [
            { metric: 'ldl', value: 95, unit: 'mg/dL' },
            { metric: 'smoking', value: 1, unit: 'category' },
          ],
        },
      });
      expect(res.statusCode).toBe(201);

      // Check where smoking was saved
      const [smokingSample] = await db.select()
        .from(samples)
        .innerJoin(sources, eq(samples.sourceId, sources.id))
        .where(and(eq(samples.userId, testUserId), eq(samples.metric, 'smoking')))
        .limit(1);

      expect(smokingSample.sources.kind).toBe('questionnaire');

      // Check where ldl was saved
      const [ldlSample] = await db.select()
        .from(samples)
        .innerJoin(sources, eq(samples.sourceId, sources.id))
        .where(and(eq(samples.userId, testUserId), eq(samples.metric, 'ldl')))
        .limit(1);

      expect(ldlSample.sources.kind).toBe('lab');
    });

    it('keeps questionnaire active when lab source is deactivated', async () => {
      // Find lab source
      const [labSrc] = await db.select().from(sources)
        .where(and(eq(sources.userId, testUserId), eq(sources.kind, 'lab')))
        .limit(1);
      expect(labSrc).toBeDefined();

      // Deactivate lab source
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/sources/${labSrc.id}`,
        headers: { cookie: sessionCookie, 'x-csrf-token': csrfToken },
        payload: { enabled: false },
      });
      expect(patchRes.statusCode).toBe(204);

      // Verify in /api/samples/summary that questionnaire metrics remain active
      const summaryRes = await app.inject({
        method: 'GET',
        url: '/api/samples/summary',
        headers: { cookie: sessionCookie },
      });
      expect(summaryRes.statusCode).toBe(200);
      const summary = JSON.parse(summaryRes.body);

      // ldl should be hidden because lab is disabled
      const ldlMetric = summary.metrics.find((m: { metric: string }) => m.metric === 'ldl');
      expect(ldlMetric).toBeUndefined();

      // smoking and alcohol should still be present because questionnaire is separate!
      const smokingMetric = summary.metrics.find((m: { metric: string; sourceKind?: string }) => m.metric === 'smoking');
      expect(smokingMetric).toBeDefined();
      expect(smokingMetric.sourceKind).toBe('questionnaire');
    });
  });
});
