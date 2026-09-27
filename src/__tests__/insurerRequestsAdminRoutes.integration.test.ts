process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';
process.env.SMTP_URL = process.env.SMTP_URL || 'smtp://localhost:1025';

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';

const HAS_DB = !!process.env.DATABASE_URL;

// Regression coverage for the admin insurer-request routes at the HTTP layer
// (approve/reject/resend-invite/delete) — a prior bug made approve 500 in
// prod despite unit-level DB assertions passing, because nothing exercised
// the real route handler end-to-end.
describe.skipIf(!HAS_DB)('Admin insurer-request routes — HTTP integration', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let adminCookie: string;
  let adminCsrfToken: string = '';
  let adminUserId: string;
  const createdRequestIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  async function createPendingRequest(overrides: Partial<{ company: string; contactEmail: string }> = {}) {
    const [request] = await db.insert(tables.insurerRequests).values({
      company: overrides.company ?? 'Testkasse HTTP GmbH',
      contactName: 'Erika Musterfrau',
      contactEmail: overrides.contactEmail ?? `insurer-http-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      message: 'Wir hätten gerne Zugang.',
    }).returning();
    createdRequestIds.push(request.id);
    return request;
  }

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();

    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const adminPasswordHash = await hash('admin-test-password-2026');
    const [admin] = await db.insert(tables.users).values({
      email: `insurer-admin-route-test-${Date.now()}@test.local`,
      passwordHash: adminPasswordHash,
      birthDate: '1980-01-01',
      sex: 'f',
      role: 'platform_admin',
    }).returning();
    adminUserId = admin.id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: 'admin-test-password-2026' },
    });
    expect(loginRes.statusCode).toBe(200);
    const setCookie = loginRes.headers['set-cookie'];
    const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    adminCookie = cookieArray.map(c => c.split(';')[0]).join('; ');
    const xsrfCookie = cookieArray.find(c => c.startsWith('XSRF-TOKEN='));
    adminCsrfToken = xsrfCookie ? xsrfCookie.split(';')[0].replace('XSRF-TOKEN=', '') : '';
  });

  afterEach(async () => {
    for (const id of createdUserIds.splice(0)) {
      await db.delete(tables.users).where(eq(tables.users.id, id));
    }
    for (const id of createdOrgIds.splice(0)) {
      await db.delete(tables.organizations).where(eq(tables.organizations.id, id));
    }
    for (const id of createdRequestIds.splice(0)) {
      await db.delete(tables.insurerRequests).where(eq(tables.insurerRequests.id, id)).catch(() => {});
    }
  });

  afterAll(async () => {
    if (adminUserId) await db.delete(tables.users).where(eq(tables.users.id, adminUserId));
    await app.close();
  });

  it('rejects admin routes without a session', async () => {
    const request = await createPendingRequest();
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/insurer-requests/${request.id}/approve`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('approve creates an organization + insurer_admin user and returns 200', async () => {
    const request = await createPendingRequest();

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/insurer-requests/${request.id}/approve`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.organizationId).toBeTruthy();
    createdOrgIds.push(body.organizationId);

    const [updatedRequest] = await db.select().from(tables.insurerRequests).where(eq(tables.insurerRequests.id, request.id));
    expect(updatedRequest.status).toBe('approved');
    expect(updatedRequest.organizationId).toBe(body.organizationId);

    const [insurerUser] = await db.select().from(tables.users).where(eq(tables.users.email, request.contactEmail));
    expect(insurerUser.role).toBe('insurer_admin');
    expect(insurerUser.organizationId).toBe(body.organizationId);
    expect(insurerUser.emailVerifiedAt).toBeNull();
    createdUserIds.push(insurerUser.id);
  });

  it('approve returns 400 when the request was already decided', async () => {
    const request = await createPendingRequest();
    const first = await app.inject({
      method: 'POST',
      url: `/api/admin/insurer-requests/${request.id}/approve`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });
    expect(first.statusCode).toBe(200);
    createdOrgIds.push(JSON.parse(first.payload).organizationId);
    const [insurerUser] = await db.select().from(tables.users).where(eq(tables.users.email, request.contactEmail));
    createdUserIds.push(insurerUser.id);

    const second = await app.inject({
      method: 'POST',
      url: `/api/admin/insurer-requests/${request.id}/approve`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });
    expect(second.statusCode).toBe(400);
  });

  it('approve returns 409 when the contact email is already a registered user', async () => {
    const email = `insurer-http-conflict-${Date.now()}@test.local`;
    const [existingUser] = await db.insert(tables.users).values({
      email,
      passwordHash: 'unusable-placeholder-hash',
      birthDate: '1990-01-01',
      sex: 'm',
    }).returning();
    createdUserIds.push(existingUser.id);

    const request = await createPendingRequest({ contactEmail: email });
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/insurer-requests/${request.id}/approve`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });
    expect(res.statusCode).toBe(409);
  });

  it('approve returns 404 for an unknown request id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/insurer-requests/00000000-0000-0000-0000-000000000000/approve',
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });
    expect(res.statusCode).toBe(404);
  });

  it('reject marks the request rejected without creating an organization', async () => {
    const request = await createPendingRequest();
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/insurer-requests/${request.id}/reject`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });
    expect(res.statusCode).toBe(200);

    const [updated] = await db.select().from(tables.insurerRequests).where(eq(tables.insurerRequests.id, request.id));
    expect(updated.status).toBe('rejected');
    expect(updated.organizationId).toBeNull();
  });

  it('resend-invite returns 400 for a request that was never approved', async () => {
    const request = await createPendingRequest();
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/insurer-requests/${request.id}/resend-invite`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });
    expect(res.statusCode).toBe(400);
  });

  it('resend-invite succeeds for an approved request', async () => {
    const request = await createPendingRequest();
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/admin/insurer-requests/${request.id}/approve`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });
    createdOrgIds.push(JSON.parse(approveRes.payload).organizationId);
    const [insurerUser] = await db.select().from(tables.users).where(eq(tables.users.email, request.contactEmail));
    createdUserIds.push(insurerUser.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/insurer-requests/${request.id}/resend-invite`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });
    expect(res.statusCode).toBe(200);
  });

  it('delete blocks removal of a pending request', async () => {
    const request = await createPendingRequest();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/insurer-requests/${request.id}`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });
    expect(res.statusCode).toBe(400);
  });

  it('delete removes a decided (rejected) request', async () => {
    const request = await createPendingRequest();
    await app.inject({
      method: 'POST',
      url: `/api/admin/insurer-requests/${request.id}/reject`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/insurer-requests/${request.id}`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrfToken },
    });
    expect(res.statusCode).toBe(204);

    const [gone] = await db.select().from(tables.insurerRequests).where(eq(tables.insurerRequests.id, request.id));
    expect(gone).toBeUndefined();
    createdRequestIds.splice(createdRequestIds.indexOf(request.id), 1);
  });
});
