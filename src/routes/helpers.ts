import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, samples, sources, scoreSnapshots } from '../db/schema.js';
import type { Role } from '../db/schema.js';
import type { Sample } from '../score/types.js';
import { filterPlausibleSamples } from '../score/plausibility.js';
import '../types.js';

export const METRIC_LABELS: Record<string, string> = {
  vo2max: 'VO₂max',
  resting_hr: 'Ruhepuls',
  systolic_bp: 'Systol. Blutdruck',
  ldl: 'LDL-Cholesterin',
  hdl: 'HDL-Cholesterin',
  hba1c: 'HbA1c',
  waist: 'Taillenumfang',
  sleep_duration: 'Schlafdauer',
  sleep_consistency: 'Schlafkonsistenz',
  hrv_rmssd: 'HRV (RMSSD)',
  zone2_minutes: 'Zone-2-Minuten',
  steps: 'Schritte',
  strength_sessions: 'Krafteinheiten',
  smoking: 'Rauchen',
  alcohol_units: 'Alkohol',
  hscrp: 'hsCRP',
};

export const DOMAIN_LABELS: Record<string, string> = {
  cardiometabolic: 'Kardiometabolik',
  recovery: 'Regeneration',
  activity: 'Aktivität',
  risk: 'Risiko',
};

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const userId = req.session.userId;
  if (!userId) {
    reply.status(401).send({ title: 'Nicht angemeldet.' });
    return null;
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    reply.status(401).send({ title: 'Benutzer nicht gefunden.' });
    return null;
  }
  return user;
}

export async function requireRole(req: FastifyRequest, reply: FastifyReply, roles: readonly Role[]) {
  const user = await requireUser(req, reply);
  if (!user) return null;
  if (!roles.includes(user.role as Role)) {
    reply.status(403).send({ title: 'Keine Berechtigung für diese Aktion.' });
    return null;
  }
  return user;
}
export type SourceTrustLevel = 'mock' | 'unverified' | 'cloud_verified' | 'certified_medical';

export const CLOUD_VERIFIED_ADAPTERS = new Set([
  'withings',
  'oura',
  'strava',
  'google-fit',
  'google_fit',
  'google-health',
  'google_health',
  'oauth',
]);

export function determineSourceTrustLevel(adapter: string, credentials?: unknown): SourceTrustLevel {
  if (adapter === 'mock') return 'mock';
  if (adapter === 'fhir') return 'certified_medical';
  if (CLOUD_VERIFIED_ADAPTERS.has(adapter)) {
    return credentials === null ? 'unverified' : 'cloud_verified';
  }
  return 'unverified';
}

export async function getUserSamples(userId: string): Promise<Sample[]> {
  const rows = await db
    .select({
      metric: samples.metric,
      value: samples.value,
      unit: samples.unit,
      measuredAt: samples.measuredAt,
      sourceKind: sources.kind,
    })
    .from(samples)
    .innerJoin(sources, eq(samples.sourceId, sources.id))
    .where(and(eq(samples.userId, userId), eq(sources.enabled, true)));

  return rows.map(r => ({
    metric: r.metric as Sample['metric'],
    value: r.value,
    unit: r.unit,
    measuredAt: r.measuredAt.toISOString(),
    sourceKind: (r.sourceKind ?? 'apple_health') as Sample['sourceKind'],
  }));
}

export async function getVerifiedUserSamples(userId: string, options?: { verifiedOnly?: boolean }): Promise<{
  samples: Sample[];
  verifiedSources: string[];
  totalSampleCount: number;
  excludedSampleCount: number;
  implausibleCount: number;
  trustLevel: 'unverified' | 'cloud_verified' | 'certified_medical';
  hasVerifiedData: boolean;
  activeDays: number;
}> {
  const verifiedOnly = options?.verifiedOnly ?? false;

  const rows = await db
    .select({
      metric: samples.metric,
      value: samples.value,
      unit: samples.unit,
      measuredAt: samples.measuredAt,
      sourceKind: sources.kind,
      sourceAdapter: sources.adapter,
      credentials: sources.credentials,
    })
    .from(samples)
    .innerJoin(sources, eq(samples.sourceId, sources.id))
    .where(and(eq(samples.userId, userId), eq(sources.enabled, true)));

  let excludedSampleCount = 0;
  const verifiedSourcesSet = new Set<string>();
  const activeDaysSet = new Set<string>();
  let highestTrust: 'unverified' | 'cloud_verified' | 'certified_medical' = 'unverified';

  const rawCandidateSamples: Sample[] = [];

  for (const r of rows) {
    const trust = determineSourceTrustLevel(r.sourceAdapter, r.credentials);
    const isVerified = trust === 'cloud_verified' || trust === 'certified_medical';

    if (verifiedOnly && !isVerified) {
      excludedSampleCount++;
      continue;
    }

    if (isVerified) {
      verifiedSourcesSet.add(r.sourceKind);
      if (trust === 'certified_medical') {
        highestTrust = 'certified_medical';
      } else if (highestTrust !== 'certified_medical') {
        highestTrust = 'cloud_verified';
      }
    }

    const isoDate = r.measuredAt.toISOString();
    activeDaysSet.add(isoDate.slice(0, 10));

    rawCandidateSamples.push({
      metric: r.metric as Sample['metric'],
      value: r.value,
      unit: r.unit,
      measuredAt: isoDate,
      sourceKind: (r.sourceKind ?? 'apple_health') as Sample['sourceKind'],
    });
  }

  // Filter out any biologically impossible or fraudulent values
  const { plausible, implausibleCount } = filterPlausibleSamples(rawCandidateSamples);

  return {
    samples: plausible,
    verifiedSources: Array.from(verifiedSourcesSet),
    totalSampleCount: rows.length,
    excludedSampleCount: excludedSampleCount + implausibleCount,
    implausibleCount,
    trustLevel: highestTrust,
    hasVerifiedData: verifiedSourcesSet.size > 0 && plausible.length > 0,
    activeDays: activeDaysSet.size,
  };
}

export async function upsertGoogleFitSamples(userId: string, sourceId: string, parsedSamples: Sample[]): Promise<number> {
  if (parsedSamples.length === 0) return 0;
  // Clean up previous raw/fragmented samples for this source to ensure pristine daily history
  await db.delete(samples).where(eq(samples.sourceId, sourceId));

  const chunkSize = 200;
  for (let i = 0; i < parsedSamples.length; i += chunkSize) {
    const chunk = parsedSamples.slice(i, i + chunkSize);
    await db.insert(samples).values(chunk.map(s => ({
      userId,
      sourceId,
      metric: s.metric,
      value: s.value,
      unit: s.unit,
      measuredAt: new Date(s.measuredAt),
    }))).onConflictDoUpdate({
      target: [samples.userId, samples.metric, samples.measuredAt],
      set: {
        value: sql`EXCLUDED.value`,
        unit: sql`EXCLUDED.unit`,
      },
    });
  }
  return parsedSamples.length;
}

/**
 * Invalidates (deletes) today's score snapshot for the given user.
 * Called whenever new health samples are ingested or synced, or sources are toggled/deleted.
 */
export async function invalidateTodaySnapshot(userId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await db.delete(scoreSnapshots)
    .where(and(eq(scoreSnapshots.userId, userId), eq(scoreSnapshots.computedFor, today)));
}
