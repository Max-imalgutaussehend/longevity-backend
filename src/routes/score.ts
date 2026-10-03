import type { FastifyInstance } from 'fastify';
import { eq, and, gte, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { scoreSnapshots } from '../db/schema.js';
import { computeScore, simulate, suggestLevers } from '../score/index.js';
import { env } from '../env.js';
import { requireUser, getUserSamples } from './helpers.js';
import '../types.js';

const VALID_METRICS = [
  'vo2max', 'resting_hr', 'systolic_bp', 'ldl', 'hdl', 'hba1c', 'waist',
  'sleep_duration', 'sleep_consistency', 'hrv_rmssd',
  'zone2_minutes', 'steps', 'strength_sessions',
  'smoking', 'alcohol_units', 'hscrp',
] as const;

const simulateBodySchema = z.object({
  overrides: z.record(z.enum(VALID_METRICS), z.number()),
});

export async function scoreRoutes(app: FastifyInstance) {
  app.get('/current', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const now = new Date();
    const userSamples = await getUserSamples(user.id);
    const result = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples: userSamples,
      now,
    });

    // Lazy upsert today's snapshot
    const today = now.toISOString().slice(0, 10);
    const [existing] = await db.select({
      id: scoreSnapshots.id,
      score: scoreSnapshots.score,
      coverage: scoreSnapshots.coverage,
      engineVersion: scoreSnapshots.engineVersion,
    })
      .from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, user.id), eq(scoreSnapshots.computedFor, today)))
      .limit(1);

    if (
      !existing ||
      existing.score !== result.score ||
      existing.coverage !== result.coverage ||
      existing.engineVersion !== result.engineVersion
    ) {
      await db.insert(scoreSnapshots).values({
        userId: user.id,
        computedFor: today,
        score: result.score,
        coverage: result.coverage,
        bioAge: result.bioAge,
        breakdown: result as unknown as Record<string, unknown>,
        engineVersion: result.engineVersion,
      }).onConflictDoUpdate({
        target: [scoreSnapshots.userId, scoreSnapshots.computedFor],
        set: {
          score: result.score,
          coverage: result.coverage,
          bioAge: result.bioAge,
          breakdown: result as unknown as Record<string, unknown>,
          engineVersion: result.engineVersion,
        },
      });
    }

    return result;
  });

  app.get('/history', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const daysParam = (req.query as Record<string, string>)['days'];
    const days = Math.min(365, Math.max(1, parseInt(daysParam ?? '90', 10) || 90));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const rows = await db.select({
      computedFor: scoreSnapshots.computedFor,
      score: scoreSnapshots.score,
      coverage: scoreSnapshots.coverage,
    }).from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, user.id), gte(scoreSnapshots.computedFor, since)))
      .orderBy(asc(scoreSnapshots.computedFor));

    return rows.map(r => ({
      date: r.computedFor,
      score: r.score,
      coverage: r.coverage,
    }));
  });

  app.get('/breakdown', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const dateParam = (req.query as Record<string, string>)['date'];
    const targetDate = dateParam ?? new Date().toISOString().slice(0, 10);

    const [row] = await db.select({ breakdown: scoreSnapshots.breakdown })
      .from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, user.id), eq(scoreSnapshots.computedFor, targetDate)))
      .limit(1);

    if (!row) return reply.status(404).send({ title: 'Kein Snapshot für dieses Datum.' });
    return row.breakdown;
  });

  app.get('/levers', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const userSamples = await getUserSamples(user.id);
    return suggestLevers({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples: userSamples,
      now: new Date(),
    });
  });

  app.post('/simulate', {
    config: {
      rateLimit: {
        max: env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || !!process.env.CI ? 10_000 : 120,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({
          statusCode: 429,
          type: 'about:blank',
          title: 'Rate-Limit überschritten.',
          status: 429,
          detail: 'Maximal 120 Simulationen pro Minute.',
        }),
      },
    },
  }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsed = simulateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        type: 'about:blank',
        title: 'Ungültige Eingabe.',
        status: 400,
        detail: parsed.error.issues.map(i => i.message).join('; '),
      });
    }

    const userSamples = await getUserSamples(user.id);
    const result = simulate(
      { profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' }, samples: userSamples, now: new Date() },
      parsed.data.overrides,
    );

    return result;
  });
}
