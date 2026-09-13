import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Sources deactivation and deletion — integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let testUserId: string;
  let googleSourceId: string;
  let mockSourceId: string;

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [user] = await db.insert(tables.users).values({
      email: `deactivate-test-${Date.now()}@test.local`,
      passwordHash: 'secret-hash',
      birthDate: '1990-01-01',
      sex: 'm',
      displayName: 'Deactivate Test',
    }).returning();
    testUserId = user.id;

    // Insert Google Fit source
    const [gSource] = await db.insert(tables.sources).values({
      userId: testUserId,
      kind: 'google_fit',
      adapter: 'oauth',
      enabled: true,
      lastSyncAt: new Date(),
    }).returning();
    googleSourceId = gSource.id;

    // Insert Google Fit sample
    await db.insert(tables.samples).values({
      userId: testUserId,
      sourceId: googleSourceId,
      metric: 'steps',
      value: 10500,
      unit: 'count',
      measuredAt: new Date(),
    });

    // Insert Mock source
    const [mSource] = await db.insert(tables.sources).values({
      userId: testUserId,
      kind: 'apple_health',
      adapter: 'mock',
      enabled: true,
      lastSyncAt: new Date(),
    }).returning();
    mockSourceId = mSource.id;

    // Insert Mock sample
    await db.insert(tables.samples).values({
      userId: testUserId,
      sourceId: mockSourceId,
      metric: 'resting_hr',
      value: 62,
      unit: 'bpm',
      measuredAt: new Date(),
    });
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(tables.users).where(eq(tables.users.id, testUserId));
    }
  });

  it('filters out samples when source is disabled (enabled = false)', async () => {
    // Both sources enabled -> 2 samples returned
    const enabledSamples = await db
      .select({ metric: tables.samples.metric })
      .from(tables.samples)
      .innerJoin(tables.sources, eq(tables.samples.sourceId, tables.sources.id))
      .where(and(eq(tables.samples.userId, testUserId), eq(tables.sources.enabled, true)));
    expect(enabledSamples).toHaveLength(2);

    // Disable Google Fit
    await db.update(tables.sources).set({ enabled: false }).where(eq(tables.sources.id, googleSourceId));

    // Only mock source samples should be returned now
    const afterDisable = await db
      .select({ metric: tables.samples.metric, sourceKind: tables.sources.kind })
      .from(tables.samples)
      .innerJoin(tables.sources, eq(tables.samples.sourceId, tables.sources.id))
      .where(and(eq(tables.samples.userId, testUserId), eq(tables.sources.enabled, true)));
    expect(afterDisable).toHaveLength(1);
    expect(afterDisable[0].metric).toBe('resting_hr');
    expect(afterDisable[0].sourceKind).toBe('apple_health');

    // Re-enable Google Fit
    await db.update(tables.sources).set({ enabled: true }).where(eq(tables.sources.id, googleSourceId));

    const afterReEnable = await db
      .select({ metric: tables.samples.metric })
      .from(tables.samples)
      .innerJoin(tables.sources, eq(tables.samples.sourceId, tables.sources.id))
      .where(and(eq(tables.samples.userId, testUserId), eq(tables.sources.enabled, true)));
    expect(afterReEnable).toHaveLength(2);
  });

  it('deletes samples when mock source is disconnected', async () => {
    // Delete samples for mock source like /api/sources/:id/disconnect does
    await db.delete(tables.samples).where(
      and(eq(tables.samples.sourceId, mockSourceId), eq(tables.samples.userId, testUserId)),
    );
    await db.update(tables.sources).set({ enabled: false }).where(eq(tables.sources.id, mockSourceId));

    const mockSamples = await db
      .select()
      .from(tables.samples)
      .where(eq(tables.samples.sourceId, mockSourceId));
    expect(mockSamples).toHaveLength(0);

    const [mockSource] = await db
      .select()
      .from(tables.sources)
      .where(eq(tables.sources.id, mockSourceId));
    expect(mockSource.enabled).toBe(false);
  });
});
