import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyBaseLogger } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sources, samples } from '../../db/schema.js';
import { getValidToken, isTokenError } from '../../lib/oauthTokens.js';
import { oauthProviders } from '../../lib/oauthProviders.js';
import { fetchWithingsSamples } from '../../adapters/withings.js';
import { fetchGoogleFitSamples } from '../../adapters/googleFit.js';
import { fetchOuraSamples } from '../../adapters/oura.js';
import { fetchStravaSamples } from '../../adapters/strava.js';
import { requireUser, upsertGoogleFitSamples, invalidateTodaySnapshot } from '../helpers.js';
import '../../types.js';

export interface SingleSyncResult {
  sourceId: string;
  kind: string;
  inserted: number;
  success: boolean;
  syncStatus: 'ok' | 'token_expired' | 'error';
  errorTitle?: string;
}

export async function syncSingleSource(
  userId: string,
  src: typeof sources.$inferSelect,
  logger?: FastifyBaseLogger
): Promise<SingleSyncResult> {
  if (!src.credentials) {
    const errorTitle = `${src.kind} ist nicht verknüpft oder die Autorisierung wurde getrennt.`;
    await db.update(sources).set({
      syncStatus: 'token_expired',
      syncError: errorTitle,
    }).where(eq(sources.id, src.id));
    return {
      sourceId: src.id,
      kind: src.kind,
      inserted: 0,
      success: false,
      syncStatus: 'token_expired',
      errorTitle,
    };
  }

  try {
    let inserted = 0;
    if (src.kind === 'withings') {
      const accessToken = await getValidToken(src.id, oauthProviders.withings);
      const parsedSamples = await fetchWithingsSamples(accessToken);
      for (const s of parsedSamples) {
        await db.insert(samples).values({
          userId,
          sourceId: src.id,
          metric: s.metric,
          value: s.value,
          unit: s.unit,
          measuredAt: new Date(s.measuredAt),
        }).onConflictDoNothing();
        inserted++;
      }
    } else if (src.kind === 'google_fit') {
      const providerKey = (src.adapter && oauthProviders[src.adapter]) ? src.adapter : 'google-fit';
      const provider = oauthProviders[providerKey] ?? oauthProviders['google-fit'];
      const accessToken = await getValidToken(src.id, provider);
      const parsedSamples = await fetchGoogleFitSamples(accessToken);
      inserted = await upsertGoogleFitSamples(userId, src.id, parsedSamples);
    } else if (src.kind === 'oura') {
      const accessToken = await getValidToken(src.id, oauthProviders.oura);
      const parsedSamples = await fetchOuraSamples(accessToken);
      for (const s of parsedSamples) {
        await db.insert(samples).values({
          userId,
          sourceId: src.id,
          metric: s.metric,
          value: s.value,
          unit: s.unit,
          measuredAt: new Date(s.measuredAt),
        }).onConflictDoNothing();
        inserted++;
      }
    } else if (src.kind === 'strava') {
      const since = src.lastSyncAt ? Math.floor(src.lastSyncAt.getTime() / 1000) : Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
      const accessToken = await getValidToken(src.id, oauthProviders.strava);
      const parsedSamples = await fetchStravaSamples(accessToken, since);
      for (const s of parsedSamples) {
        await db.insert(samples).values({
          userId,
          sourceId: src.id,
          metric: s.metric,
          value: s.value,
          unit: s.unit,
          measuredAt: new Date(s.measuredAt),
        }).onConflictDoUpdate({
          target: [samples.userId, samples.metric, samples.measuredAt],
          set: { value: s.value },
        });
        inserted++;
      }
    } else {
      return {
        sourceId: src.id,
        kind: src.kind,
        inserted: 0,
        success: true,
        syncStatus: 'ok',
      };
    }

    await db.update(sources).set({
      lastSyncAt: new Date(),
      syncStatus: 'ok',
      syncError: null,
    }).where(eq(sources.id, src.id));

    return {
      sourceId: src.id,
      kind: src.kind,
      inserted,
      success: true,
      syncStatus: 'ok',
    };
  } catch (err: unknown) {
    logger?.error(err, `${src.kind} sync failed`);
    const msg = err instanceof Error ? err.message : 'Synchronisation fehlgeschlagen.';
    const isTokenExpired = isTokenError(err, msg);
    const syncStatus = isTokenExpired ? 'token_expired' : 'error';
    const errorTitle = isTokenExpired
      ? `${src.kind}-Autorisierung ist abgelaufen oder ungültig. Bitte verbinde ${src.kind} erneut.`
      : `${src.kind}-Synchronisation fehlgeschlagen: ${msg}`;

    await db.update(sources).set({
      syncStatus,
      syncError: errorTitle,
    }).where(eq(sources.id, src.id));

    return {
      sourceId: src.id,
      kind: src.kind,
      inserted: 0,
      success: false,
      syncStatus,
      errorTitle,
    };
  }
}

export async function syncAllUserSources(userId: string, logger?: FastifyBaseLogger) {
  const userSources = await db.select().from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.enabled, true)));

  const cloudSources = userSources.filter(s =>
    ['withings', 'google_fit', 'oura', 'strava'].includes(s.kind) && s.credentials !== null
  );

  if (cloudSources.length === 0) {
    return { ok: true, synced: 0, totalInserted: 0, results: [] };
  }

  const results: SingleSyncResult[] = [];
  let totalInserted = 0;
  let successfulSyncs = 0;

  for (const src of cloudSources) {
    const res = await syncSingleSource(userId, src, logger);
    results.push(res);
    if (res.success) {
      successfulSyncs++;
      totalInserted += res.inserted;
    }
  }

  if (successfulSyncs > 0) {
    await invalidateTodaySnapshot(userId);
  }

  return {
    ok: true,
    synced: successfulSyncs,
    totalInserted,
    results,
  };
}

export async function sourcesSyncRoutes(app: FastifyInstance) {
  app.post('/sources/sync-all', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const result = await syncAllUserSources(user.id, req.log);
    return result;
  });

  app.post('/sources/withings/sync', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'withings')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Withings ist nicht verbunden.' });

    const res = await syncSingleSource(user.id, src, req.log);
    if (!res.success) {
      return reply.status(400).send({
        title: res.errorTitle,
        syncStatus: res.syncStatus,
      });
    }

    await invalidateTodaySnapshot(user.id);
    return { inserted: res.inserted, sourceId: src.id };
  });

  const handleGoogleSync = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'google_fit')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Google Health ist nicht verbunden.' });

    const res = await syncSingleSource(user.id, src, req.log);
    if (!res.success) {
      return reply.status(400).send({
        title: res.errorTitle,
        syncStatus: res.syncStatus,
      });
    }

    await invalidateTodaySnapshot(user.id);
    return { inserted: res.inserted, sourceId: src.id };
  };

  app.post('/sources/google-fit/sync', handleGoogleSync);
  app.post('/sources/google-health/sync', handleGoogleSync);

  app.post('/sources/oura/sync', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'oura')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Oura ist nicht verbunden.' });

    const res = await syncSingleSource(user.id, src, req.log);
    if (!res.success) {
      return reply.status(400).send({
        title: res.errorTitle,
        syncStatus: res.syncStatus,
      });
    }

    await invalidateTodaySnapshot(user.id);
    return { inserted: res.inserted, sourceId: src.id };
  });

  app.post('/sources/strava/sync', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'strava')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Strava ist nicht verbunden.' });

    const res = await syncSingleSource(user.id, src, req.log);
    if (!res.success) {
      return reply.status(400).send({
        title: res.errorTitle,
        syncStatus: res.syncStatus,
      });
    }

    await invalidateTodaySnapshot(user.id);
    return { inserted: res.inserted, sourceId: src.id };
  });
}
