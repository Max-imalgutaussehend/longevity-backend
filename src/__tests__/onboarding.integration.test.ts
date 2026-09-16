import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Registration & Onboarding — clean user state (#25)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let testUserId: string;

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [user] = await db.insert(tables.users).values({
      email: `onboarding-test-${Date.now()}@test.local`,
      passwordHash: 'secret-hash',
      birthDate: '1992-05-10',
      sex: 'f',
    }).returning();
    testUserId = user.id;
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(tables.samples).where(eq(tables.samples.userId, testUserId));
      await db.delete(tables.sources).where(eq(tables.sources.userId, testUserId));
      await db.delete(tables.users).where(eq(tables.users.id, testUserId));
    }
  });

  it('newly registered user starts with 0 sources and 0 samples for clean onboarding', async () => {
    const userSources = await db.select().from(tables.sources).where(eq(tables.sources.userId, testUserId));
    expect(userSources.length).toBe(0);

    const userSamples = await db.select().from(tables.samples).where(eq(tables.samples.userId, testUserId));
    expect(userSamples.length).toBe(0);
  });
});
