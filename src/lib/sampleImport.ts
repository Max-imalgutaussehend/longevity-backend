import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { samples } from '../db/schema.js';
import type { Sample } from '../score/types.js';

// Caps how many samples a single bulk import may insert, and how many rows
// go into one INSERT statement — avoids millions of serial round-trips
// blocking the event loop for all users during a large import (see #109).
export const MAX_APPLE_HEALTH_SAMPLES = 25_000;
export const SAMPLE_INSERT_BATCH_SIZE = 500;

export async function insertSamplesBatched(
  userId: string,
  sourceId: string,
  parsedSamples: Sample[],
  opts: { maxSamples?: number; batchSize?: number } = {},
): Promise<number> {
  const maxSamples = opts.maxSamples ?? MAX_APPLE_HEALTH_SAMPLES;
  const batchSize = opts.batchSize ?? SAMPLE_INSERT_BATCH_SIZE;
  // Apple Health exports are chronologically ascending (oldest first). When
  // capping, keep the NEWEST samples — the score engine reads current
  // values, so silently dropping recent data for years-old readings would
  // leave the user with a stale/incomplete score (see #109 review).
  const capped = parsedSamples.length <= maxSamples
    ? parsedSamples
    : [...parsedSamples]
      .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())
      .slice(0, maxSamples);
  let inserted = 0;
  for (let i = 0; i < capped.length; i += batchSize) {
    const batch = capped.slice(i, i + batchSize).map((s) => ({
      userId,
      sourceId,
      metric: s.metric,
      value: s.value,
      unit: s.unit,
      measuredAt: new Date(s.measuredAt),
    }));
    const rows = await db.insert(samples).values(batch).onConflictDoNothing().returning({ id: samples.id });
    inserted += rows.length;
  }
  return inserted;
}

// Same batching, but for import paths that must overwrite an existing
// sample at the same (userId, metric, measuredAt) instead of skipping it
// (FHIR lab uploads: a corrected/updated observation should replace the
// prior value, not be silently dropped by onConflictDoNothing).
export async function upsertSamplesBatched(
  userId: string,
  sourceId: string,
  parsedSamples: Sample[],
  opts: { maxSamples?: number; batchSize?: number } = {},
): Promise<number> {
  const maxSamples = opts.maxSamples ?? MAX_APPLE_HEALTH_SAMPLES;
  const batchSize = opts.batchSize ?? SAMPLE_INSERT_BATCH_SIZE;
  const capped = parsedSamples.length <= maxSamples
    ? parsedSamples
    : [...parsedSamples]
      .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())
      .slice(0, maxSamples);
  let inserted = 0;
  for (let i = 0; i < capped.length; i += batchSize) {
    const batch = capped.slice(i, i + batchSize).map((s) => ({
      userId,
      sourceId,
      metric: s.metric,
      value: s.value,
      unit: s.unit,
      measuredAt: new Date(s.measuredAt),
    }));
    const rows = await db.insert(samples).values(batch)
      .onConflictDoUpdate({
        target: [samples.userId, samples.metric, samples.measuredAt],
        set: { value: sql`excluded.value`, unit: sql`excluded.unit` },
      })
      .returning({ id: samples.id });
    inserted += rows.length;
  }
  return inserted;
}
