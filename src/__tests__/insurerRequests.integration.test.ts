import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Insurer contact requests — integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let requestId: string;

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [request] = await db.insert(tables.insurerRequests).values({
      company: 'Testkasse Anfrage GmbH',
      contactName: 'Erika Musterfrau',
      contactEmail: `insurer-request-${Date.now()}@test.local`,
      message: 'Wir hätten gerne Zugang.',
    }).returning();
    requestId = request.id;
  });

  afterAll(async () => {
    if (requestId) await db.delete(tables.insurerRequests).where(eq(tables.insurerRequests.id, requestId));
  });

  it('creates a pending request with no organization linked', async () => {
    const [request] = await db.select().from(tables.insurerRequests).where(eq(tables.insurerRequests.id, requestId));
    expect(request.status).toBe('pending');
    expect(request.organizationId).toBeNull();
  });

  it('approving creates an organization and an unverified insurer_admin, and marks the request approved', async () => {
    const [request] = await db.select().from(tables.insurerRequests).where(eq(tables.insurerRequests.id, requestId));

    const [org] = await db.insert(tables.organizations).values({
      name: request.company,
      contactEmail: request.contactEmail,
      status: 'pending',
      joinCode: `insurer-request-test-${Date.now()}`,
    }).returning();

    const [insurerUser] = await db.insert(tables.users).values({
      email: request.contactEmail,
      passwordHash: 'unusable-placeholder-hash',
      birthDate: '1970-01-01',
      sex: 'm',
      role: 'insurer_admin',
      organizationId: org.id,
    }).returning();

    await db.update(tables.insurerRequests).set({
      status: 'approved', organizationId: org.id, decidedAt: new Date(),
    }).where(eq(tables.insurerRequests.id, requestId));

    const [updated] = await db.select().from(tables.insurerRequests).where(eq(tables.insurerRequests.id, requestId));
    expect(updated.status).toBe('approved');
    expect(updated.organizationId).toBe(org.id);
    expect(insurerUser.role).toBe('insurer_admin');
    expect(insurerUser.emailVerifiedAt).toBeNull();

    await db.delete(tables.users).where(eq(tables.users.id, insurerUser.id));
    await db.delete(tables.organizations).where(eq(tables.organizations.id, org.id));
  });

  it('rejecting a request only updates its status, no organization created', async () => {
    const [rejectable] = await db.insert(tables.insurerRequests).values({
      company: 'Abgelehnte Kasse',
      contactName: 'Test Person',
      contactEmail: `insurer-reject-${Date.now()}@test.local`,
    }).returning();

    await db.update(tables.insurerRequests).set({
      status: 'rejected', decidedAt: new Date(),
    }).where(eq(tables.insurerRequests.id, rejectable.id));

    const [updated] = await db.select().from(tables.insurerRequests).where(eq(tables.insurerRequests.id, rejectable.id));
    expect(updated.status).toBe('rejected');
    expect(updated.organizationId).toBeNull();

    await db.delete(tables.insurerRequests).where(eq(tables.insurerRequests.id, rejectable.id));
  });
});
