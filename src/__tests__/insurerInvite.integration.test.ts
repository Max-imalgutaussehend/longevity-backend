import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Insurer invite acceptance — integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let issueEmailToken: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consumeEmailToken: any;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    const tokenModule = await import('../lib/emailTokens.js');
    db = clientModule.db;
    tables = schemaModule;
    issueEmailToken = tokenModule.issueEmailToken;
    consumeEmailToken = tokenModule.consumeEmailToken;

    const [org] = await db.insert(tables.organizations).values({
      name: 'Einladungs-Testkasse',
      contactEmail: `invite-${Date.now()}@test.local`,
      status: 'pending',
      joinCode: `invite-test-${Date.now()}`,
    }).returning();
    orgId = org.id;

    const [user] = await db.insert(tables.users).values({
      email: org.contactEmail,
      passwordHash: 'unusable-placeholder-hash',
      birthDate: '1970-01-01',
      sex: 'm',
      role: 'insurer_admin',
      organizationId: orgId,
    }).returning();
    userId = user.id;
  });

  afterAll(async () => {
    if (userId) await db.delete(tables.users).where(eq(tables.users.id, userId));
    if (orgId) await db.delete(tables.organizations).where(eq(tables.organizations.id, orgId));
  });

  it('creates the org in pending status with an unverified insurer_admin', async () => {
    const [org] = await db.select().from(tables.organizations).where(eq(tables.organizations.id, orgId));
    const [user] = await db.select().from(tables.users).where(eq(tables.users.id, userId));
    expect(org.status).toBe('pending');
    expect(user.role).toBe('insurer_admin');
    expect(user.emailVerifiedAt).toBeNull();
  });

  it('consumes an insurer_invite token exactly once and activates the org on acceptance', async () => {
    const token = await issueEmailToken(userId, 'insurer_invite', 7 * 24 * 60 * 60 * 1000);

    const result = await consumeEmailToken(token, 'insurer_invite');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe(userId);

    await db.update(tables.users).set({ emailVerifiedAt: new Date() }).where(eq(tables.users.id, userId));
    await db.update(tables.organizations).set({ status: 'active' }).where(eq(tables.organizations.id, orgId));

    const [org] = await db.select().from(tables.organizations).where(eq(tables.organizations.id, orgId));
    const [user] = await db.select().from(tables.users).where(eq(tables.users.id, userId));
    expect(org.status).toBe('active');
    expect(user.emailVerifiedAt).not.toBeNull();

    const replay = await consumeEmailToken(token, 'insurer_invite');
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('used');
  });

  it('rejects a verify_email token when consumed as insurer_invite', async () => {
    const token = await issueEmailToken(userId, 'verify_email');
    const result = await consumeEmailToken(token, 'insurer_invite');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});
