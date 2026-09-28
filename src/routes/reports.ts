import type { FastifyInstance } from 'fastify';
import { eq, and, gte, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scoreSnapshots } from '../db/schema.js';
import { computeScore } from '../score/index.js';
import { requireUser, getUserSamples, METRIC_LABELS } from './helpers.js';
import { sendMail } from '../lib/mail.js';
import { weeklyReportTemplate } from '../lib/emailTemplates.js';
import { env } from '../env.js';
import '../types.js';

interface WeeklyReportResult {
  weekStart: string;
  scoreStart: number;
  scoreEnd: number;
  delta: number;
  bestMetric: string;
  worstMetric: string;
  streakDays: number;
}

const WEARABLE_SOURCE_KINDS = new Set(['apple_health', 'oura', 'withings', 'google_fit', 'strava', 'health_auto_export']);

// Counts consecutive days (ending today) that have at least one wearable
// sample — not a count of score snapshot rows, which only reflects how
// often the user opened the dashboard.
function computeWearableStreakDays(samples: Array<{ measuredAt: string; sourceKind: string }>, now: Date): number {
  const daysWithWearableData = new Set(
    samples
      .filter((s) => WEARABLE_SOURCE_KINDS.has(s.sourceKind))
      .map((s) => s.measuredAt.slice(0, 10)),
  );

  let streak = 0;
  const cursor = new Date(now);
  for (;;) {
    const dayStr = cursor.toISOString().slice(0, 10);
    if (!daysWithWearableData.has(dayStr)) break;
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

async function computeWeeklyReport(user: { id: string; birthDate: string; sex: string }): Promise<WeeklyReportResult> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = await db.select({
    computedFor: scoreSnapshots.computedFor,
    score: scoreSnapshots.score,
    breakdown: scoreSnapshots.breakdown,
  }).from(scoreSnapshots)
    .where(and(eq(scoreSnapshots.userId, user.id), gte(scoreSnapshots.computedFor, weekAgo)))
    .orderBy(asc(scoreSnapshots.computedFor));

  const userSamples = await getUserSamples(user.id);
  const streakDays = computeWearableStreakDays(userSamples, now);

  if (rows.length < 2) {
    const current = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples: userSamples,
      now,
    });
    return {
      weekStart: weekAgo,
      scoreStart: current.score,
      scoreEnd: current.score,
      delta: 0,
      bestMetric: 'vo2max',
      worstMetric: 'smoking',
      streakDays,
    };
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  const breakdown = last.breakdown as { domains?: Array<{ metrics?: Array<{ metric: string; contribution: number }> }> };
  const allMetrics: Array<{ metric: string; contribution: number }> = [];
  for (const domain of breakdown.domains ?? []) {
    for (const m of domain.metrics ?? []) {
      if (m.contribution !== undefined) allMetrics.push(m);
    }
  }
  allMetrics.sort((a, b) => b.contribution - a.contribution);
  const bestMetric = allMetrics[0]?.metric ?? 'vo2max';
  const worstMetric = allMetrics[allMetrics.length - 1]?.metric ?? 'smoking';

  return {
    weekStart: first.computedFor,
    scoreStart: first.score,
    scoreEnd: last.score,
    delta: Math.round((last.score - first.score) * 10) / 10,
    bestMetric,
    worstMetric,
    streakDays,
  };
}

export async function reportRoutes(app: FastifyInstance) {
  app.get('/weekly', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return computeWeeklyReport(user);
  });

  app.post('/send', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const report = await computeWeeklyReport(user);
    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const dashboardUrl = `${baseUrl}/report`;

    const bestLabel = METRIC_LABELS[report.bestMetric] ?? report.bestMetric;
    const worstLabel = METRIC_LABELS[report.worstMetric] ?? report.worstMetric;

    const emailContent = weeklyReportTemplate({
      displayName: user.displayName,
      score: report.scoreEnd,
      delta: report.delta,
      bestMetricLabel: bestLabel,
      worstMetricLabel: worstLabel,
      streakDays: report.streakDays,
      dashboardUrl,
    });

    try {
      await sendMail({ to: user.email, ...emailContent });
    } catch (err) {
      req.log.error(err, 'Wöchentlicher Bericht konnte nicht gesendet werden');
      return reply.status(500).send({ title: 'E-Mail konnte nicht gesendet werden.' });
    }

    return { ok: true, sentTo: user.email };
  });
}
