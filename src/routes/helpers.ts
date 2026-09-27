import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, samples, sources } from '../db/schema.js';
import type { Role } from '../db/schema.js';
import type { Sample } from '../score/types.js';
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
