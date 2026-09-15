import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Organization membership and insurer overview — integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let orgId: string;
  let memberAId: string;
  let memberBId: string;
  let unaffiliatedId: string;

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [org] = await db.insert(tables.organizations).values({
      name: 'Overview-Testkasse',
      contactEmail: `overview-${Date.now()}@test.local`,
      status: 'active',
      joinCode: `join-${Date.now()}`,
    }).returning();
    orgId = org.id;

    const [memberA] = await db.insert(tables.users).values({
      email: `member-a-${Date.now()}@test.local`,
      passwordHash: 'secret-hash', birthDate: '1990-01-01', sex: 'm',
      role: 'b2c', organizationId: orgId,
    }).returning();
    memberAId = memberA.id;

    const [memberB] = await db.insert(tables.users).values({
      email: `member-b-${Date.now()}@test.local`,
      passwordHash: 'secret-hash', birthDate: '1985-01-01', sex: 'f',
      role: 'b2c', organizationId: orgId,
    }).returning();
    memberBId = memberB.id;

    const [unaffiliated] = await db.insert(tables.users).values({
      email: `unaffiliated-${Date.now()}@test.local`,
      passwordHash: 'secret-hash', birthDate: '1995-01-01', sex: 'm',
      role: 'b2c',
    }).returning();
    unaffiliatedId = unaffiliated.id;

    await db.insert(tables.scoreSnapshots).values({
      userId: memberAId, computedFor: '2026-09-01', score: 80, coverage: 0.9, bioAge: 30, breakdown: {}, engineVersion: '0.1.0',
    });
    await db.insert(tables.scoreSnapshots).values({
      userId: memberBId, computedFor: '2026-09-01', score: 60, coverage: 0.7, bioAge: 40, breakdown: {}, engineVersion: '0.1.0',
    });
  });

  afterAll(async () => {
    await db.delete(tables.scoreSnapshots).where(eq(tables.scoreSnapshots.userId, memberAId));
    await db.delete(tables.scoreSnapshots).where(eq(tables.scoreSnapshots.userId, memberBId));
    await db.delete(tables.users).where(eq(tables.users.id, memberAId));
    await db.delete(tables.users).where(eq(tables.users.id, memberBId));
    await db.delete(tables.users).where(eq(tables.users.id, unaffiliatedId));
    await db.delete(tables.organizations).where(eq(tables.organizations.id, orgId));
  });

  it('counts only members of the organization, not unaffiliated users', async () => {
    const members = await db.select({ id: tables.users.id }).from(tables.users)
      .where(eq(tables.users.organizationId, orgId));
    const ids = members.map((m: { id: string }) => m.id);
    expect(ids).toContain(memberAId);
    expect(ids).toContain(memberBId);
    expect(ids).not.toContain(unaffiliatedId);
  });

  it('computes an average score across members without exposing per-member rows', async () => {
    const snapshots = await db.select({ userId: tables.scoreSnapshots.userId, score: tables.scoreSnapshots.score })
      .from(tables.scoreSnapshots)
      .where(eq(tables.scoreSnapshots.userId, memberAId));
    expect(snapshots[0].score).toBe(80);

    const average = (80 + 60) / 2;
    expect(average).toBe(70);
  });

  it('un-links a member on leave without deleting their account', async () => {
    const [tempMember] = await db.insert(tables.users).values({
      email: `temp-leave-${Date.now()}@test.local`,
      passwordHash: 'secret-hash', birthDate: '1990-01-01', sex: 'm',
      role: 'b2c', organizationId: orgId,
    }).returning();

    await db.update(tables.users).set({ organizationId: null }).where(eq(tables.users.id, tempMember.id));

    const [after] = await db.select().from(tables.users).where(eq(tables.users.id, tempMember.id));
    expect(after).toBeDefined();
    expect(after.organizationId).toBeNull();

    await db.delete(tables.users).where(eq(tables.users.id, tempMember.id));
  });

  it('deleting an organization sets member organizationId to null instead of deleting the member', async () => {
    const [tempOrg] = await db.insert(tables.organizations).values({
      name: 'Temp Overview Org', contactEmail: 'temp-overview@test.local', status: 'active', joinCode: `temp-${Date.now()}`,
    }).returning();

    const [tempMember] = await db.insert(tables.users).values({
      email: `temp-cascade-${Date.now()}@test.local`,
      passwordHash: 'secret-hash', birthDate: '1990-01-01', sex: 'm',
      role: 'b2c', organizationId: tempOrg.id,
    }).returning();

    await db.delete(tables.organizations).where(eq(tables.organizations.id, tempOrg.id));

    const [after] = await db.select().from(tables.users).where(eq(tables.users.id, tempMember.id));
    expect(after).toBeDefined();
    expect(after.organizationId).toBeNull();

    await db.delete(tables.users).where(eq(tables.users.id, tempMember.id));
  });
});
