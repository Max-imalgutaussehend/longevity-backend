process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, sources, samples } from '../db/schema.js';
import { insertSamplesBatched } from '../lib/sampleImport.js';
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

  it('is safe to re-run (onConflictDoNothing) without duplicate key errors', async () => {
    const parsed = makeSamples(5).map((s, i) => ({ ...s, measuredAt: new Date(Date.parse('2026-03-01T00:00:00Z') + i * 60_000).toISOString() }));
    const first = await insertSamplesBatched(testUserId, testSourceId, parsed, { maxSamples: 100, batchSize: 2 });
    expect(first).toBe(5);

    const second = await insertSamplesBatched(testUserId, testSourceId, parsed, { maxSamples: 100, batchSize: 2 });
    expect(second).toBe(0);
  });
});
