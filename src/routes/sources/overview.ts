import type { FastifyInstance } from 'fastify';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sources, samples } from '../../db/schema.js';
import { METRICS } from '../../score/metrics.js';
import type { Metric } from '../../score/types.js';
import { generate } from '../../mock/generate.js';
import { requireUser, METRIC_LABELS, DOMAIN_LABELS, invalidateTodaySnapshot, SELF_CONNECTED_ADAPTERS } from '../helpers.js';
import '../../types.js';

export async function sourcesOverviewRoutes(app: FastifyInstance) {
  app.get('/sources', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const rows = await db.select().from(sources).where(eq(sources.userId, user.id));
    const allSamples = await db.select({ sourceId: samples.sourceId }).from(samples).where(eq(samples.userId, user.id));

    const countMap = new Map<string, number>();
    for (const s of allSamples) countMap.set(s.sourceId, (countMap.get(s.sourceId) ?? 0) + 1);

    return rows.map(s => {
      const isSelfConnected = SELF_CONNECTED_ADAPTERS.has(s.adapter);
      return {
        id: s.id,
        kind: s.kind,
        adapter: s.adapter,
        enabled: s.enabled,
        connected: isSelfConnected ? true : (s.credentials !== null && s.syncStatus !== 'token_expired'),
        syncStatus: s.syncStatus ?? (isSelfConnected ? 'ok' : (s.credentials ? 'ok' : null)),
        syncError: s.syncError ?? null,
        lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
        sampleCount: countMap.get(s.id) ?? 0,
        webhookSecret: (s.kind === 'apple_health' || s.adapter === 'health_auto_export') ? user.webhookSecret : undefined,
      };
    });
  });

  app.get('/samples/summary', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const rawSamples = await db
      .select({
        id: samples.id,
        metric: samples.metric,
        value: samples.value,
        unit: samples.unit,
        measuredAt: samples.measuredAt,
        createdAt: samples.createdAt,
        sourceKind: sources.kind,
        sourceAdapter: sources.adapter,
      })
      .from(samples)
      .innerJoin(sources, eq(samples.sourceId, sources.id))
      .where(and(eq(samples.userId, user.id), eq(sources.enabled, true)))
      .orderBy(desc(samples.measuredAt))
      .limit(5000);

    const metricDefs = new Map(METRICS.map(m => [m.metric, m]));
    const byMetric = new Map<string, typeof rawSamples>();
    for (const s of rawSamples) {
      const list = byMetric.get(s.metric) ?? [];
      list.push(s);
      byMetric.set(s.metric, list);
    }

    const metricsSummary = Array.from(byMetric.entries()).map(([metric, list]) => {
      const latest = list[0];
      const def = metricDefs.get(metric as Metric);
      const label = METRIC_LABELS[metric] ?? metric;
      const domain = def?.domain ?? 'activity';
      const domainLabel = DOMAIN_LABELS[domain] ?? domain;

      return {
        metric,
        label,
        domain,
        domainLabel,
        latestValue: latest.value,
        unit: latest.unit,
        latestMeasuredAt: latest.measuredAt.toISOString(),
        sourceKind: latest.sourceKind ?? 'manual',
        sourceAdapter: latest.sourceAdapter ?? null,
        count: list.length,
        history: list.slice(0, 90).map(item => ({
          id: Number(item.id),
          value: item.value,
          measuredAt: item.measuredAt.toISOString(),
          sourceKind: item.sourceKind ?? 'manual',
        })),
      };
    });

    metricsSummary.sort((a, b) => new Date(b.latestMeasuredAt).getTime() - new Date(a.latestMeasuredAt).getTime());

    const recentSamples = rawSamples.slice(0, 100).map(s => ({
      id: Number(s.id),
      metric: s.metric,
      label: METRIC_LABELS[s.metric] ?? s.metric,
      value: s.value,
      unit: s.unit,
      measuredAt: s.measuredAt.toISOString(),
      sourceKind: s.sourceKind ?? 'manual',
      sourceAdapter: s.sourceAdapter ?? null,
    }));

    let minDate: string | null = null;
    let maxDate: string | null = null;
    if (rawSamples.length > 0) {
      maxDate = rawSamples[0].measuredAt.toISOString();
      minDate = rawSamples[rawSamples.length - 1].measuredAt.toISOString();
    }

    return {
      metrics: metricsSummary,
      recentSamples,
      totalCount: rawSamples.length,
      dateRange: minDate && maxDate ? { min: minDate, max: maxDate } : null,
    };
  });

  app.patch('/sources/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { id } = req.params as { id: string };
    const body = req.body as { enabled?: boolean };

    if (body.enabled === undefined) {
      return reply.status(400).send({ title: 'enabled-Feld fehlt.' });
    }

    const [row] = await db.select().from(sources)
      .where(and(eq(sources.id, id), eq(sources.userId, user.id)))
      .limit(1);

    if (!row) return reply.status(404).send({ title: 'Quelle nicht gefunden.' });

    await db.update(sources)
      .set({ enabled: body.enabled, consentAt: body.enabled ? new Date() : null })
      .where(eq(sources.id, id));

    await invalidateTodaySnapshot(user.id);

    return reply.status(204).send();
  });

  app.post('/sources/:id/regenerate', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { id } = req.params as { id: string };
    const [source] = await db.select().from(sources)
      .where(and(eq(sources.id, id), eq(sources.userId, user.id)))
      .limit(1);

    if (!source) return reply.status(404).send({ title: 'Quelle nicht gefunden.' });
    if (source.adapter !== 'mock') return reply.status(400).send({ title: 'Nur Mock-Quellen können regeneriert werden.' });

    await db.delete(samples).where(and(eq(samples.sourceId, id), eq(samples.userId, user.id)));

    const seed = user.id.charCodeAt(0) * 31 + Date.now() % 1000;
    const newSamples = generate(seed, 90);
    if (newSamples.length > 0) {
      await db.insert(samples).values(newSamples.map(s => ({
        userId: user.id,
        sourceId: id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      })));
    }

    await db.update(sources).set({ lastSyncAt: new Date(), enabled: true }).where(eq(sources.id, id));
    await invalidateTodaySnapshot(user.id);

    return { ok: true, sampleCount: newSamples.length };
  });

  app.post('/sources/mock/generate', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.adapter, 'mock')))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId: user.id,
        kind: 'apple_health',
        adapter: 'mock',
        enabled: true,
      }).returning();
    } else {
      await db.update(sources).set({ enabled: true, lastSyncAt: new Date() }).where(eq(sources.id, src.id));
    }

    await db.delete(samples).where(and(eq(samples.sourceId, src.id), eq(samples.userId, user.id)));

    const seed = user.id.charCodeAt(0) * 31 + Date.now() % 1000;
    const newSamples = generate(seed, 90);
    if (newSamples.length > 0) {
      await db.insert(samples).values(newSamples.map(s => ({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      })));
    }

    await invalidateTodaySnapshot(user.id);

    return { ok: true, sourceId: src.id, sampleCount: newSamples.length };
  });

  app.delete('/sources/:id/disconnect', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { id } = req.params as { id: string };
    const query = req.query as { deleteData?: string } | undefined;
    const shouldDeleteData = query?.deleteData === 'true' || query?.deleteData === '1';

    const [source] = await db.select().from(sources)
      .where(and(eq(sources.id, id), eq(sources.userId, user.id)))
      .limit(1);

    if (!source) return reply.status(404).send({ title: 'Quelle nicht gefunden.' });

    if (source.adapter === 'mock' || shouldDeleteData) {
      await db.delete(samples).where(and(eq(samples.sourceId, id), eq(samples.userId, user.id)));
    }

    await db.update(sources).set({ credentials: null, enabled: false, syncStatus: null, syncError: null }).where(eq(sources.id, id));
    await invalidateTodaySnapshot(user.id);

    return reply.status(204).send();
  });

  app.delete('/sources/:id/samples', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { id } = req.params as { id: string };
    const [source] = await db.select().from(sources)
      .where(and(eq(sources.id, id), eq(sources.userId, user.id)))
      .limit(1);

    if (!source) return reply.status(404).send({ title: 'Quelle nicht gefunden.' });

    await db.delete(samples).where(and(eq(samples.sourceId, id), eq(samples.userId, user.id)));
    await db.update(sources).set({ lastSyncAt: null }).where(eq(sources.id, id));
    await invalidateTodaySnapshot(user.id);

    return reply.status(204).send();
  });
}
