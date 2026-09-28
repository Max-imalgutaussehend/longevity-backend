process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

describe('Issue #97: Snapshot Invalidation on Ingest & Weekly Report Email Sending', () => {
  let app: FastifyInstance;
  let testUserId: string;
  let sessionCookie: string;
  let csrfToken: string;
  let db: typeof import('../db/client.js').db;
  let users: typeof import('../db/schema.js').users;
  let scoreSnapshots: typeof import('../db/schema.js').scoreSnapshots;

  beforeAll(async () => {
    const dbMod = await import('../db/client.js');
    const schemaMod = await import('../db/schema.js');
    const appMod = await import('../app.js');
    db = dbMod.db;
    users = schemaMod.users;
    scoreSnapshots = schemaMod.scoreSnapshots;

    app = await appMod.buildApp();
    await app.ready();

    // Create test user
    const testEmail = `issue97-test-${Date.now()}@longevity.test`;
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: testEmail,
        password: 'ValidPassword123!',
        birthDate: '1992-04-10',
        sex: 'f',
        displayName: 'Issue 97 Tester',
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
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  it('invalidates today snapshot when new labs are posted', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // Insert a dummy snapshot for today
    await db.insert(scoreSnapshots).values({
      userId: testUserId,
      computedFor: today,
      score: 65,
      coverage: 0.5,
      bioAge: 32,
      breakdown: { score: 65 },
      engineVersion: '0.1.0',
    }).onConflictDoUpdate({
      target: [scoreSnapshots.userId, scoreSnapshots.computedFor],
      set: { score: 65 },
    });

    const [snapBefore] = await db.select().from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, testUserId), eq(scoreSnapshots.computedFor, today)));
    expect(snapBefore).toBeDefined();

    // Post new lab values
    const res = await app.inject({
      method: 'POST',
      url: '/api/labs',
      headers: {
        cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
      payload: {
        values: [
          { metric: 'ldl', value: 120, unit: 'mg/dL' },
          { metric: 'hba1c', value: 5.2, unit: '%' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);

    // Check that today snapshot is deleted
    const [snapAfter] = await db.select().from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, testUserId), eq(scoreSnapshots.computedFor, today)));
    expect(snapAfter).toBeUndefined();
  });

  it('invalidates today snapshot when questionnaire is submitted', async () => {
    const today = new Date().toISOString().slice(0, 10);

    await db.insert(scoreSnapshots).values({
      userId: testUserId,
      computedFor: today,
      score: 70,
      coverage: 0.6,
      bioAge: 30,
      breakdown: { score: 70 },
      engineVersion: '0.1.0',
    }).onConflictDoUpdate({
      target: [scoreSnapshots.userId, scoreSnapshots.computedFor],
      set: { score: 70 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/questionnaire',
      headers: {
        cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
      payload: {
        values: [
          { metric: 'smoking', value: 0, unit: 'cig/day' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);

    const [snapAfter] = await db.select().from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, testUserId), eq(scoreSnapshots.computedFor, today)));
    expect(snapAfter).toBeUndefined();
  });

  it('sends weekly report email via POST /api/report/send', async () => {
    const mailMod = await import('../lib/mail.js');
    const sendMailSpy = vi.spyOn(mailMod, 'sendMail').mockResolvedValueOnce();

    const res = await app.inject({
      method: 'POST',
      url: '/api/report/send',
      headers: {
        cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.sentTo).toContain('@longevity.test');

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    const callArg = sendMailSpy.mock.calls[0][0];
    expect(callArg.to).toBe(body.sentTo);
    expect(callArg.subject).toContain('LONGEVITY');
    expect(callArg.html).toContain('Wöchentlicher Vitalitätsbericht');

    sendMailSpy.mockRestore();
  });
});
