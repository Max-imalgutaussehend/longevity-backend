process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

describe('Health Insurer Selection & KVNR Membership Verification (#53)', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let schema: any;

  let userAId: string;
  let userBId: string;
  let activeOrgId: string;
  let pendingOrgId: string;
  let cookieUserA: string;
  let csrfTokenUserA: string;
  let cookieUserB: string;
  let csrfTokenUserB: string;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');

    app = await buildApp();
    db = clientModule.db;
    schema = schemaModule;

    // Create active and pending organizations
    const [activeOrg] = await db.insert(schema.organizations).values({
      name: 'Techniker Krankenkasse (TK)',
      contactEmail: 'partner@tk.test',
      status: 'active',
      joinCode: `tk-join-${Date.now()}`,
    }).returning();
    activeOrgId = activeOrg.id;

    const [pendingOrg] = await db.insert(schema.organizations).values({
      name: 'Inaktive Kasse',
      contactEmail: 'pending@kasse.test',
      status: 'pending',
      joinCode: `pending-join-${Date.now()}`,
    }).returning();
    pendingOrgId = pendingOrg.id;

    // Register User A
    const emailA = `kvnr-user-a-${Date.now()}@test.local`;
    const regResA = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: emailA,
        password: 'Password123!',
        birthDate: '1995-05-15',
        sex: 'm',
      },
    });
    expect(regResA.statusCode).toBe(201);
    const setCookieA = regResA.headers['set-cookie'];
    const cookieArrayA = Array.isArray(setCookieA) ? setCookieA : [setCookieA as string];
    cookieUserA = cookieArrayA.map((c) => c.split(';')[0]).join('; ');
    const xsrfCookieA = cookieArrayA.find((c) => c.startsWith('XSRF-TOKEN='));
    csrfTokenUserA = xsrfCookieA ? xsrfCookieA.split(';')[0].replace('XSRF-TOKEN=', '') : '';

    const [uA] = await db.select().from(schema.users).where(eq(schema.users.email, emailA)).limit(1);
    userAId = uA.id;

    // Register User B
    const emailB = `kvnr-user-b-${Date.now()}@test.local`;
    const regResB = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: emailB,
        password: 'Password123!',
        birthDate: '1992-08-20',
        sex: 'f',
      },
    });
    expect(regResB.statusCode).toBe(201);
    const setCookieB = regResB.headers['set-cookie'];
    const cookieArrayB = Array.isArray(setCookieB) ? setCookieB : [setCookieB as string];
    cookieUserB = cookieArrayB.map((c) => c.split(';')[0]).join('; ');
    const xsrfCookieB = cookieArrayB.find((c) => c.startsWith('XSRF-TOKEN='));
    csrfTokenUserB = xsrfCookieB ? xsrfCookieB.split(';')[0].replace('XSRF-TOKEN=', '') : '';

    const [uB] = await db.select().from(schema.users).where(eq(schema.users.email, emailB)).limit(1);
    userBId = uB.id;
  }, 30000);

  afterAll(async () => {
    if (userAId) await db.delete(schema.users).where(eq(schema.users.id, userAId));
    if (userBId) await db.delete(schema.users).where(eq(schema.users.id, userBId));
    if (activeOrgId) await db.delete(schema.organizations).where(eq(schema.organizations.id, activeOrgId));
    if (pendingOrgId) await db.delete(schema.organizations).where(eq(schema.organizations.id, pendingOrgId));
  });

  describe('GET /api/organizations/public-list', () => {
    it('returns list of active partner organizations and excludes pending ones', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/organizations/public-list',
      });

      expect(res.statusCode).toBe(200);
      const list = JSON.parse(res.payload);
      expect(Array.isArray(list)).toBe(true);

      const foundActive = list.find((o: { id: string }) => o.id === activeOrgId);
      expect(foundActive).toBeDefined();
      expect(foundActive.name).toBe('Techniker Krankenkasse (TK)');

      const foundPending = list.find((o: { id: string }) => o.id === pendingOrgId);
      expect(foundPending).toBeUndefined();
    });
  });

  describe('POST /api/organizations/join with KVNR verification', () => {
    it('rejects request with missing parameters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations/join',
        headers: { cookie: cookieUserA, 'x-csrf-token': csrfTokenUserA },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid KVNR format (e.g. too short or not 1 letter + 9 digits)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations/join',
        headers: { cookie: cookieUserA, 'x-csrf-token': csrfTokenUserA },
        payload: {
          organizationId: activeOrgId,
          kvnr: '1234567890',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.title).toContain('Format ungültig');
    });

    it('rejects invalid KVNR checksum according to Modulo-10 (§ 290 SGB V)', async () => {
      // Z629410048 has incorrect check digit (should be 9)
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations/join',
        headers: { cookie: cookieUserA, 'x-csrf-token': csrfTokenUserA },
        payload: {
          organizationId: activeOrgId,
          kvnr: 'Z629410048',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.title).toContain('Prüfziffer');
    });

    it('rejects joining an inactive or non-existent organization', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations/join',
        headers: { cookie: cookieUserA, 'x-csrf-token': csrfTokenUserA },
        payload: {
          organizationId: pendingOrgId,
          kvnr: 'Z629410049',
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it('successfully verifies valid KVNR and links organization to user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations/join',
        headers: { cookie: cookieUserA, 'x-csrf-token': csrfTokenUserA },
        payload: {
          organizationId: activeOrgId,
          kvnr: '  z629410049  ', // test lowercase and whitespace normalization
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.organizationName).toBe('Techniker Krankenkasse (TK)');
      expect(body.verifiedAt).toBeDefined();

      // Verify database record has hashed KVNR and verified timestamp
      const [userInDb] = await db.select().from(schema.users).where(eq(schema.users.id, userAId));
      expect(userInDb.organizationId).toBe(activeOrgId);
      expect(userInDb.organizationVerifiedAt).toBeDefined();
      expect(userInDb.kvnrHash).toHaveLength(64);
      // Plaintext KVNR must NEVER be stored
      expect(userInDb.kvnrHash).not.toContain('Z629410049');
    });

    it('GET /api/me includes verified organization information', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: cookieUserA },
      });

      expect(res.statusCode).toBe(200);
      const me = JSON.parse(res.payload);
      expect(me.organizationId).toBe(activeOrgId);
      expect(me.organization).toEqual({
        id: activeOrgId,
        name: 'Techniker Krankenkasse (TK)',
        verifiedAt: expect.any(String),
      });
      expect(me.organizationVerifiedAt).toBeDefined();
    });

    it('rejects another user attempting to link the already registered KVNR (anti-fraud)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations/join',
        headers: { cookie: cookieUserB, 'x-csrf-token': csrfTokenUserB },
        payload: {
          organizationId: activeOrgId,
          kvnr: 'Z629410049', // Same KVNR already used by User A
        },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.payload);
      expect(body.title).toContain('bereits mit einem anderen Konto verknüpft');
    });

    it('allows user to disconnect organization via POST /api/organizations/leave', async () => {
      const leaveRes = await app.inject({
        method: 'POST',
        url: '/api/organizations/leave',
        headers: { cookie: cookieUserA, 'x-csrf-token': csrfTokenUserA },
      });
      expect(leaveRes.statusCode).toBe(204);

      const [userInDb] = await db.select().from(schema.users).where(eq(schema.users.id, userAId));
      expect(userInDb.organizationId).toBeNull();
      expect(userInDb.organizationVerifiedAt).toBeNull();
      expect(userInDb.kvnrHash).toBeNull();

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: cookieUserA },
      });
      const me = JSON.parse(meRes.payload);
      expect(me.organizationId).toBeNull();
      expect(me.organization).toBeNull();
    });
  });
});
