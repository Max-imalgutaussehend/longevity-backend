process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, sources, samples } from '../db/schema.js';
import { insertSamplesBatched, upsertSamplesBatched } from '../lib/sampleImport.js';
import type { Sample } from '../score/types.js';

describe('insertSamplesBatched (#109 — bounded bulk import)', () => {
  let testUserId: string;
  let testSourceId: string;

  beforeAll(async () => {
    const [user] = await db.insert(users).values({
      email: `sample-import-test-${Date.now()}@example.com`,
      passwordHash: 'not-a-real-hash',
      birthDate: '1990-01-01',
      sex: 'm',
    }).returning();
    testUserId = user.id;

    const [src] = await db.insert(sources).values({
      userId: testUserId,
      kind: 'apple_health',
      adapter: 'upload',
      enabled: true,
    }).returning();
    testSourceId = src.id;
  });

  afterAll(async () => {
    if (testUserId) await db.delete(users).where(eq(users.id, testUserId));
  });

  function makeSamples(count: number): Sample[] {
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    return Array.from({ length: count }, (_, i) => ({
      metric: 'steps' as Sample['metric'],
      sourceKind: 'apple_health' as Sample['sourceKind'],
      value: 1000 + i,
      unit: 'steps',
      measuredAt: new Date(base + i * 60_000).toISOString(),
    }));
  }

  it('inserts all samples when under the cap, across multiple batches', async () => {
    const parsed = makeSamples(30);
    const inserted = await insertSamplesBatched(testUserId, testSourceId, parsed, { maxSamples: 1000, batchSize: 10 });
    expect(inserted).toBe(30);

    const rows = await db.select().from(samples).where(eq(samples.sourceId, testSourceId));
    expect(rows).toHaveLength(30);
  });

  it('caps the number of inserted samples at maxSamples, silently dropping the rest', async () => {
    const parsed = makeSamples(50).map((s, i) => ({ ...s, measuredAt: new Date(Date.parse('2026-02-01T00:00:00Z') + i * 60_000).toISOString() }));
    const inserted = await insertSamplesBatched(testUserId, testSourceId, parsed, { maxSamples: 20, batchSize: 7 });
    expect(inserted).toBe(20);
  });

  it('keeps the NEWEST samples when capping, not the oldest (#109 review — chronologically-ascending exports must not silently drop recent data)', async () => {
    // 40 samples spanning 4 years, oldest first — exactly how a real Apple
    // Health export.xml is ordered. Cap to 10: only the 10 most recent
    // years must survive, none from the earliest years.
    const metric = 'vo2max' as Sample['metric']; // distinct metric so this test's rows can't mix with other tests' 'steps' rows sharing testSourceId
    const parsed: Sample[] = Array.from({ length: 40 }, (_, i) => ({
      metric,
      sourceKind: 'apple_health',
      value: 40 + i,
      unit: 'ml/kg/min',
      measuredAt: new Date(Date.parse('2026-06-01T00:00:00Z') + i * 365 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    const inserted = await insertSamplesBatched(testUserId, testSourceId, parsed, { maxSamples: 10, batchSize: 4 });
    expect(inserted).toBe(10);

    const rows = await db.select({ measuredAt: samples.measuredAt }).from(samples)
      .where(and(eq(samples.sourceId, testSourceId), eq(samples.metric, metric)));
    const keptYears = rows.map((r: { measuredAt: Date }) => r.measuredAt.getUTCFullYear()).sort((a: number, b: number) => a - b);
    const expectedNewestYears = parsed.slice(-10).map((s) => new Date(s.measuredAt).getUTCFullYear()).sort((a, b) => a - b);
    expect(keptYears).toEqual(expectedNewestYears);
    expect(Math.min(...keptYears)).toBeGreaterThan(2026);
  });

  it('is safe to re-run (onConflictDoNothing) without duplicate key errors', async () => {
    const parsed = makeSamples(5).map((s, i) => ({ ...s, measuredAt: new Date(Date.parse('2026-03-01T00:00:00Z') + i * 60_000).toISOString() }));
    const first = await insertSamplesBatched(testUserId, testSourceId, parsed, { maxSamples: 100, batchSize: 2 });
    expect(first).toBe(5);

    const second = await insertSamplesBatched(testUserId, testSourceId, parsed, { maxSamples: 100, batchSize: 2 });
    expect(second).toBe(0);
  });
});

describe('upsertSamplesBatched (#109 review — batched onConflictDoUpdate for FHIR/lab imports)', () => {
  let testUserId: string;
  let testSourceId: string;

  beforeAll(async () => {
    const [user] = await db.insert(users).values({
      email: `sample-upsert-test-${Date.now()}@example.com`,
      passwordHash: 'not-a-real-hash',
      birthDate: '1990-01-01',
      sex: 'm',
    }).returning();
    testUserId = user.id;

    const [src] = await db.insert(sources).values({
      userId: testUserId,
      kind: 'lab',
      adapter: 'fhir',
      enabled: true,
    }).returning();
    testSourceId = src.id;
  });

  afterAll(async () => {
    if (testUserId) await db.delete(users).where(eq(users.id, testUserId));
  });

  it('inserts new samples across multiple batches', async () => {
    const parsed: Sample[] = Array.from({ length: 12 }, (_, i) => ({
      metric: 'ldl' as Sample['metric'],
      sourceKind: 'lab' as Sample['sourceKind'],
      value: 100 + i,
      unit: 'mg/dL',
      measuredAt: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 24 * 60 * 60 * 1000).toISOString(),
    }));

    const inserted = await upsertSamplesBatched(testUserId, testSourceId, parsed, { maxSamples: 100, batchSize: 5 });
    expect(inserted).toBe(12);

    const rows = await db.select().from(samples).where(eq(samples.sourceId, testSourceId));
    expect(rows).toHaveLength(12);
  });

  it('overwrites the value on conflict instead of skipping (onConflictDoUpdate, not DoNothing)', async () => {
    const measuredAt = new Date('2026-05-01T00:00:00Z').toISOString();
    const original: Sample[] = [{ metric: 'ldl' as Sample['metric'], sourceKind: 'lab' as Sample['sourceKind'], value: 130, unit: 'mg/dL', measuredAt }];
    await upsertSamplesBatched(testUserId, testSourceId, original, { maxSamples: 100, batchSize: 5 });

    const corrected: Sample[] = [{ metric: 'ldl' as Sample['metric'], sourceKind: 'lab' as Sample['sourceKind'], value: 95, unit: 'mg/dL', measuredAt }];
    const inserted = await upsertSamplesBatched(testUserId, testSourceId, corrected, { maxSamples: 100, batchSize: 5 });
    expect(inserted).toBe(1);

    const [row] = await db.select().from(samples).where(and(eq(samples.sourceId, testSourceId), eq(samples.measuredAt, new Date(measuredAt))));
    expect(row.value).toBe(95);
  });
});
