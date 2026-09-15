import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Role model — integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let b2cUserId: string;
  let insurerUserId: string;
  let orgId: string;

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [b2cUser] = await db.insert(tables.users).values({
      email: `roles-b2c-${Date.now()}@test.local`,
      passwordHash: 'secret-hash',
      birthDate: '1990-01-01',
      sex: 'm',
      displayName: 'B2C Test',
    }).returning();
    b2cUserId = b2cUser.id;

    const [org] = await db.insert(tables.organizations).values({
      name: 'Testkasse',
      contactEmail: 'kontakt@testkasse.de',
    }).returning();
    orgId = org.id;

    const [insurerUser] = await db.insert(tables.users).values({
      email: `roles-insurer-${Date.now()}@test.local`,
      passwordHash: 'secret-hash',
      birthDate: '1985-01-01',
      sex: 'f',
      displayName: 'Insurer Test',
      role: 'insurer_admin',
      organizationId: orgId,
    }).returning();
    insurerUserId = insurerUser.id;
  });

  afterAll(async () => {
    if (insurerUserId) await db.delete(tables.users).where(eq(tables.users.id, insurerUserId));
    if (b2cUserId) await db.delete(tables.users).where(eq(tables.users.id, b2cUserId));
    if (orgId) await db.delete(tables.organizations).where(eq(tables.organizations.id, orgId));
  });

  it('defaults new users to the b2c role with no organization', async () => {
    const [user] = await db.select().from(tables.users).where(eq(tables.users.id, b2cUserId));
    expect(user.role).toBe('b2c');
    expect(user.organizationId).toBeNull();
  });

  it('stores insurer users with their organization link', async () => {
    const [user] = await db.select().from(tables.users).where(eq(tables.users.id, insurerUserId));
    expect(user.role).toBe('insurer_admin');
    expect(user.organizationId).toBe(orgId);
  });

  it('cascades organization deletion to its users', async () => {
    const [tempOrg] = await db.insert(tables.organizations).values({
      name: 'Temp Kasse',
      contactEmail: 'temp@testkasse.de',
    }).returning();

    const [tempUser] = await db.insert(tables.users).values({
      email: `roles-temp-${Date.now()}@test.local`,
      passwordHash: 'secret-hash',
      birthDate: '1980-01-01',
      sex: 'm',
      role: 'insurer_staff',
      organizationId: tempOrg.id,
    }).returning();

    await db.delete(tables.organizations).where(eq(tables.organizations.id, tempOrg.id));

    const remaining = await db.select().from(tables.users).where(eq(tables.users.id, tempUser.id));
    expect(remaining).toHaveLength(0);
  });
});
