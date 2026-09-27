import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sources, samples } from '../../db/schema.js';
import { getValidToken, isTokenError } from '../../lib/oauthTokens.js';
import { oauthProviders } from '../../lib/oauthProviders.js';
import { fetchWithingsSamples } from '../../adapters/withings.js';
import { fetchGoogleFitSamples } from '../../adapters/googleFit.js';
import { fetchOuraSamples } from '../../adapters/oura.js';
import { fetchStravaSamples } from '../../adapters/strava.js';
import { requireUser, upsertGoogleFitSamples } from '../helpers.js';
import '../../types.js';

export async function sourcesSyncRoutes(app: FastifyInstance) {
  app.post('/sources/withings/sync', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'withings')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Withings ist nicht verbunden.' });
    if (!src.credentials) {
      await db.update(sources).set({
        syncStatus: 'token_expired',
        syncError: 'Withings ist nicht verknüpft oder die Autorisierung wurde getrennt.',
      }).where(eq(sources.id, src.id));
      return reply.status(400).send({
        title: 'Withings ist nicht verknüpft oder die Autorisierung wurde getrennt. Bitte verbinde Withings erneut.',
        syncStatus: 'token_expired',
      });
    }

    try {
      const accessToken = await getValidToken(src.id, oauthProviders.withings);
      const parsedSamples = await fetchWithingsSamples(accessToken);

      let inserted = 0;
      for (const s of parsedSamples) {
        await db.insert(samples).values({
          userId: user.id,
          sourceId: src.id,
          metric: s.metric,
          value: s.value,
          unit: s.unit,
          measuredAt: new Date(s.measuredAt),
        }).onConflictDoNothing();
        inserted++;
      }

      await db.update(sources).set({ lastSyncAt: new Date(), syncStatus: 'ok', syncError: null }).where(eq(sources.id, src.id));

      return { inserted, sourceId: src.id };
    } catch (err: unknown) {
      req.log.error(err, 'Withings sync failed');
      const msg = err instanceof Error ? err.message : 'Synchronisation fehlgeschlagen.';
      const isTokenExpired = isTokenError(err, msg);
      const syncStatus = isTokenExpired ? 'token_expired' : 'error';
      const errorTitle = isTokenExpired
        ? 'Withings-Autorisierung ist abgelaufen oder ungültig. Bitte verbinde Withings erneut.'
        : `Withings-Synchronisation fehlgeschlagen: ${msg}`;

      await db.update(sources).set({
        syncStatus,
        syncError: errorTitle,
      }).where(eq(sources.id, src.id));

      return reply.status(400).send({
        title: errorTitle,
        syncStatus,
      });
    }
  });

  const handleGoogleSync = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'google_fit')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Google Health ist nicht verbunden.' });
    if (!src.credentials) {
      await db.update(sources).set({
        syncStatus: 'token_expired',
        syncError: 'Google Health ist nicht verknüpft oder die Autorisierung wurde getrennt.',
      }).where(eq(sources.id, src.id));
      return reply.status(400).send({
        title: 'Google Health ist nicht verknüpft oder die Autorisierung wurde getrennt. Bitte verbinde dein Google-Konto erneut.',
        syncStatus: 'token_expired',
      });
    }

    try {
      const providerKey = (src.adapter && oauthProviders[src.adapter]) ? src.adapter : 'google-fit';
      const provider = oauthProviders[providerKey] ?? oauthProviders['google-fit'];
      const accessToken = await getValidToken(src.id, provider);
      const parsedSamples = await fetchGoogleFitSamples(accessToken);
      const inserted = await upsertGoogleFitSamples(user.id, src.id, parsedSamples);

      await db.update(sources).set({ lastSyncAt: new Date(), syncStatus: 'ok', syncError: null }).where(eq(sources.id, src.id));

      return { inserted, sourceId: src.id };
    } catch (err: unknown) {
      req.log.error(err, 'Google Health sync failed');
      const msg = err instanceof Error ? err.message : 'Synchronisation fehlgeschlagen.';
      const isTokenExpired = isTokenError(err, msg);
      const syncStatus = isTokenExpired ? 'token_expired' : 'error';
      const errorTitle = isTokenExpired
        ? 'Google Health-Autorisierung ist abgelaufen oder ungültig. Bitte verbinde Google Health erneut.'
        : `Google Health-Synchronisation fehlgeschlagen: ${msg}`;

      await db.update(sources).set({
        syncStatus,
        syncError: errorTitle,
      }).where(eq(sources.id, src.id));

      return reply.status(400).send({
        title: errorTitle,
        syncStatus,
      });
    }
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
    if (!src.credentials) {
      await db.update(sources).set({
        syncStatus: 'token_expired',
        syncError: 'Oura ist nicht verknüpft oder die Autorisierung wurde getrennt.',
      }).where(eq(sources.id, src.id));
      return reply.status(400).send({
        title: 'Oura ist nicht verknüpft oder die Autorisierung wurde getrennt. Bitte verbinde Oura erneut.',
        syncStatus: 'token_expired',
      });
    }

    try {
      const accessToken = await getValidToken(src.id, oauthProviders.oura);
      const parsedSamples = await fetchOuraSamples(accessToken);

      let inserted = 0;
      for (const s of parsedSamples) {
        await db.insert(samples).values({
          userId: user.id,
          sourceId: src.id,
          metric: s.metric,
          value: s.value,
          unit: s.unit,
          measuredAt: new Date(s.measuredAt),
        }).onConflictDoNothing();
        inserted++;
      }

      await db.update(sources).set({ lastSyncAt: new Date(), syncStatus: 'ok', syncError: null }).where(eq(sources.id, src.id));

      return { inserted, sourceId: src.id };
    } catch (err: unknown) {
      req.log.error(err, 'Oura sync failed');
      const msg = err instanceof Error ? err.message : 'Synchronisation fehlgeschlagen.';
      const isTokenExpired = isTokenError(err, msg);
      const syncStatus = isTokenExpired ? 'token_expired' : 'error';
      const errorTitle = isTokenExpired
        ? 'Oura-Autorisierung ist abgelaufen oder ungültig. Bitte verbinde Oura erneut.'
        : `Oura-Synchronisation fehlgeschlagen: ${msg}`;

      await db.update(sources).set({
        syncStatus,
        syncError: errorTitle,
      }).where(eq(sources.id, src.id));

      return reply.status(400).send({
        title: errorTitle,
        syncStatus,
      });
    }
  });

  app.post('/sources/strava/sync', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'strava')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Strava ist nicht verbunden.' });
    if (!src.credentials) {
      await db.update(sources).set({
        syncStatus: 'token_expired',
        syncError: 'Strava ist nicht verknüpft oder die Autorisierung wurde getrennt.',
      }).where(eq(sources.id, src.id));
      return reply.status(400).send({
        title: 'Strava ist nicht verknüpft oder die Autorisierung wurde getrennt. Bitte verbinde Strava erneut.',
        syncStatus: 'token_expired',
      });
    }

    try {
      const since = src.lastSyncAt ? Math.floor(src.lastSyncAt.getTime() / 1000) : Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
      const accessToken = await getValidToken(src.id, oauthProviders.strava);
      const parsedSamples = await fetchStravaSamples(accessToken, since);

      let inserted = 0;
      for (const s of parsedSamples) {
        await db.insert(samples).values({
          userId: user.id,
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

      await db.update(sources).set({ lastSyncAt: new Date(), syncStatus: 'ok', syncError: null }).where(eq(sources.id, src.id));

      return { inserted, sourceId: src.id };
    } catch (err: unknown) {
      req.log.error(err, 'Strava sync failed');
      const msg = err instanceof Error ? err.message : 'Synchronisation fehlgeschlagen.';
      const isTokenExpired = isTokenError(err, msg);
      const syncStatus = isTokenExpired ? 'token_expired' : 'error';
      const errorTitle = isTokenExpired
        ? 'Strava-Autorisierung ist abgelaufen oder ungültig. Bitte verbinde Strava erneut.'
        : `Strava-Synchronisation fehlgeschlagen: ${msg}`;

      await db.update(sources).set({
        syncStatus,
        syncError: errorTitle,
      }).where(eq(sources.id, src.id));

      return reply.status(400).send({
        title: errorTitle,
        syncStatus,
      });
    }
  });
}
