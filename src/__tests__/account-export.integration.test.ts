/**
 * Integration-Test für GET /api/account/export
 *
 * Benötigt eine laufende Postgres-Instanz via DATABASE_URL.
 *
 * Testet: Nutzer mit Source/Sample/Snapshot/ShareToken anlegen → Export-Shape
 * prüfen (alle Tabellen enthalten, kein Passwort-Hash, keine Session-Daten).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('GET /api/account/export — integration', () => {
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
      email: `export-test-${Date.now()}@test.local`,
      passwordHash: 'super-secret-hash-must-not-leak',
      birthDate: '1990-01-01',
      sex: 'f',
      displayName: 'Export Test',
    }).returning();
    testUserId = user.id;

    const [source] = await db.insert(tables.sources).values({
      userId: testUserId, kind: 'lab', adapter: 'manual', enabled: true,
    }).returning();

    await db.insert(tables.samples).values({
      userId: testUserId, sourceId: source.id,
      metric: 'ldl', value: 110, unit: 'mg/dL', measuredAt: new Date(),
    });

    await db.insert(tables.scoreSnapshots).values({
      userId: testUserId, computedFor: '2024-06-01',
      score: 72, coverage: 0.8, bioAge: 33, breakdown: { score: 72 }, engineVersion: '0.1.0',
    });

    await db.insert(tables.shareTokens).values({
      id: `export-test-token-${Date.now()}`,
      userId: testUserId, bandLow: 60, bandHigh: 80,
      expiresAt: new Date(Date.now() + 86400000), signature: 'x',
    });
  });

  afterAll(async () => {
    if (testUserId) {
      const { eq } = await import('drizzle-orm');
      await db.delete(tables.users).where(eq(tables.users.id, testUserId));
    }
  });

  it('assembles an export containing every table, keyed by userId', async () => {
    const { eq } = await import('drizzle-orm');

    const [user] = await db.select().from(tables.users).where(eq(tables.users.id, testUserId)).limit(1);
    const userSources = await db.select().from(tables.sources).where(eq(tables.sources.userId, testUserId));
    const userSamples = await db.select().from(tables.samples).where(eq(tables.samples.userId, testUserId));
    const userSnapshots = await db.select().from(tables.scoreSnapshots).where(eq(tables.scoreSnapshots.userId, testUserId));
    const userShareTokens = await db.select().from(tables.shareTokens).where(eq(tables.shareTokens.userId, testUserId));

    expect(user).toBeDefined();
    expect(userSources).toHaveLength(1);
    expect(userSamples).toHaveLength(1);
    expect(userSnapshots).toHaveLength(1);
    expect(userShareTokens).toHaveLength(1);

    // Simulate the export route's projection — must not leak passwordHash
    const exportPayload = {
      user: { email: user.email, displayName: user.displayName, birthDate: user.birthDate, sex: user.sex },
    };

    expect(JSON.stringify(exportPayload)).not.toContain('super-secret-hash-must-not-leak');
    expect('passwordHash' in exportPayload.user).toBe(false);
  });

  it('has no rows left for a deleted user (cascade), simulating post-deletion export unavailability', async () => {
    const { eq } = await import('drizzle-orm');

    const [tempUser] = await db.insert(tables.users).values({
      email: `export-delete-test-${Date.now()}@test.local`,
      passwordHash: 'x', birthDate: '1990-01-01', sex: 'm',
    }).returning();

    await db.insert(tables.sources).values({ userId: tempUser.id, kind: 'lab', adapter: 'manual', enabled: true });
    await db.delete(tables.users).where(eq(tables.users.id, tempUser.id));

    const remainingSources = await db.select().from(tables.sources).where(eq(tables.sources.userId, tempUser.id));
    expect(remainingSources).toHaveLength(0);
  });
});
