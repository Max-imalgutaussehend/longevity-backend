import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, desc, and } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { db } from '../db/client.js';
import { sources, samples, scoreSnapshots } from '../db/schema.js';
import { env } from '../env.js';
import { METRICS } from '../score/metrics.js';
import type { Metric } from '../score/types.js';
import { generate } from '../mock/generate.js';
import { parseAppleHealthXml } from '../adapters/appleHealth.js';
import { looksLikeZip, extractExportXml, AppleHealthZipError } from '../adapters/appleHealthZip.js';
import { parseHealthAutoExport } from '../adapters/healthAutoExport.js';
import { parseFhirBundle } from '../adapters/fhir.js';
import { exchangeCodeForToken, getValidToken, isTokenError } from '../lib/oauthTokens.js';
import { oauthProviders, providerToSourceKind } from '../lib/oauthProviders.js';
import { fetchWithingsSamples } from '../adapters/withings.js';
import { fetchGoogleFitSamples } from '../adapters/googleFit.js';
import { fetchOuraSamples } from '../adapters/oura.js';
import { fetchStravaSamples } from '../adapters/strava.js';
import { requireUser, upsertGoogleFitSamples, METRIC_LABELS, DOMAIN_LABELS } from './helpers.js';
import '../types.js';

export async function sourcesRoutes(app: FastifyInstance) {
  app.get('/sources', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const rows = await db.select().from(sources).where(eq(sources.userId, user.id));
    const allSamples = await db.select({ sourceId: samples.sourceId }).from(samples).where(eq(samples.userId, user.id));

    const countMap = new Map<string, number>();
    for (const s of allSamples) countMap.set(s.sourceId, (countMap.get(s.sourceId) ?? 0) + 1);

    return rows.map(s => ({
      id: s.id,
      kind: s.kind,
      adapter: s.adapter,
      enabled: s.enabled,
      connected: s.adapter === 'mock' ? true : (s.credentials !== null && s.syncStatus !== 'token_expired'),
      syncStatus: s.syncStatus ?? (s.adapter === 'mock' ? 'ok' : (s.credentials ? 'ok' : null)),
      syncError: s.syncError ?? null,
      lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
      sampleCount: countMap.get(s.id) ?? 0,
    }));
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

    const today = new Date().toISOString().slice(0, 10);
    await db.delete(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, user.id), eq(scoreSnapshots.computedFor, today)));

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

    return { ok: true, sourceId: src.id, sampleCount: newSamples.length };
  });

  app.post('/sources/:provider/connect', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { provider } = req.params as { provider: string };
    const oauthProvider = oauthProviders[provider];
    if (!oauthProvider) return reply.status(404).send({ title: 'Unbekannter Provider.' });
    if (!oauthProvider.clientId) {
      return reply.status(400).send({
        title: `${provider} ist noch nicht konfiguriert (Client-ID fehlt).`,
        code: 'OAUTH_NOT_CONFIGURED',
      });
    }

    const body = (req.body as { redirectUri?: string } | undefined) ?? {};
    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const state = Buffer.from(JSON.stringify({ userId: user.id, provider })).toString('base64url');
    const redirectUri = (body.redirectUri && body.redirectUri.trim()) || oauthProvider.redirectUri(baseUrl);

    const url = new URL(oauthProvider.authorizeUrl);
    url.searchParams.set('client_id', oauthProvider.clientId ?? '');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', oauthProvider.scope);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    if (provider === 'google-fit' || provider === 'google-health') {
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
    }

    return { url: url.toString() };
  });

  // HEAD handler for providers (e.g. Withings) that probe callback reachability
  app.head('/oauth/callback/:provider', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const oauthProvider = oauthProviders[provider];
    if (!oauthProvider) return reply.status(404).send();
    return reply.status(200).send();
  });

  app.get('/oauth/callback/:provider', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { code, state } = req.query as { code?: string; state?: string };
    const oauthProvider = oauthProviders[provider];
    if (!oauthProvider) return reply.status(404).send({ title: 'Unbekannter Provider.' });

    // Withings and other OAuth providers ping callback URLs with empty GET/HEAD to verify reachability
    if (!code && !state) {
      return reply.status(200).send({ ok: true, message: 'OAuth callback endpoint ready.' });
    }
    if (!code || !state) return reply.status(400).send({ title: 'code oder state fehlt.' });

    const sourceKind = providerToSourceKind(provider);
    if (!sourceKind) return reply.status(404).send({ title: 'Unbekannter Provider.' });

    let userId: string;
    try {
      ({ userId } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { userId: string });
    } catch {
      return reply.status(400).send({ title: 'Ungültiger state-Parameter.' });
    }

    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const credentials = await exchangeCodeForToken(oauthProvider, code, baseUrl);

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, userId), eq(sources.kind, sourceKind)))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId,
        kind: sourceKind,
        adapter: provider,
        enabled: true,
        consentAt: new Date(),
        credentials,
        syncStatus: 'ok',
        syncError: null,
      }).returning();
    } else {
      await db.update(sources).set({
        credentials,
        enabled: true,
        consentAt: new Date(),
        syncStatus: 'ok',
        syncError: null,
      }).where(eq(sources.id, src.id));
    }

    // Auto-sync initial samples for Google Fit / Google Health
    if (sourceKind === 'google_fit') {
      try {
        const parsedSamples = await fetchGoogleFitSamples(credentials.accessToken);
        await upsertGoogleFitSamples(userId, src.id, parsedSamples);
        await db.update(sources).set({ lastSyncAt: new Date(), syncStatus: 'ok', syncError: null }).where(eq(sources.id, src.id));
      } catch (err) {
        req.log.warn(err, 'Initial Google sync after OAuth callback failed');
      }
    }

    const acceptsHtml = req.headers.accept?.includes('text/html');
    if (acceptsHtml) {
      const targetUrl = env.NODE_ENV === 'development'
        ? `http://localhost:5173/daten?connected=${encodeURIComponent(provider)}`
        : `/daten?connected=${encodeURIComponent(provider)}`;
      return reply.redirect(targetUrl);
    }

    return reply.status(200).send({ ok: true, sourceId: src.id });
  });

  // HEAD handler for Google OAuth callback reachability probe
  app.head('/sources/google/callback', async (_req, reply) => {
    return reply.status(200).send();
  });

  // Alias for Google OAuth callback if registered as /api/sources/google/callback
  app.get('/sources/google/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const oauthProvider = oauthProviders['google-fit'];
    if (!oauthProvider) return reply.status(404).send({ title: 'Unbekannter Provider.' });

    // Reachability probe
    if (!code && !state) {
      return reply.status(200).send({ ok: true, message: 'OAuth callback endpoint ready.' });
    }
    if (!code || !state) return reply.status(400).send({ title: 'code oder state fehlt.' });

    let userId: string;
    try {
      ({ userId } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { userId: string });
    } catch {
      return reply.status(400).send({ title: 'Ungültiger state-Parameter.' });
    }

    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const redirectUri = (env.GOOGLE_REDIRECT_URI && env.GOOGLE_REDIRECT_URI.trim()) || `${baseUrl}/api/sources/google/callback`;
    const credentials = await exchangeCodeForToken(oauthProvider, code, baseUrl, redirectUri);

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, userId), eq(sources.kind, 'google_fit')))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId,
        kind: 'google_fit',
        adapter: 'google-fit',
        enabled: true,
        consentAt: new Date(),
        credentials,
        syncStatus: 'ok',
        syncError: null,
      }).returning();
    } else {
      await db.update(sources).set({
        credentials,
        enabled: true,
        consentAt: new Date(),
        syncStatus: 'ok',
        syncError: null,
      }).where(eq(sources.id, src.id));
    }

    try {
      const parsedSamples = await fetchGoogleFitSamples(credentials.accessToken);
      await upsertGoogleFitSamples(userId, src.id, parsedSamples);
      await db.update(sources).set({ lastSyncAt: new Date(), syncStatus: 'ok', syncError: null }).where(eq(sources.id, src.id));
    } catch (err) {
      req.log.warn(err, 'Initial Google sync after OAuth callback failed');
    }

    const acceptsHtml = req.headers.accept?.includes('text/html');
    if (acceptsHtml) {
      const targetUrl = env.NODE_ENV === 'development'
        ? `http://localhost:5173/daten?connected=google-fit`
        : `/daten?connected=google-fit`;
      return reply.redirect(targetUrl);
    }

    return reply.status(200).send({ ok: true, sourceId: src.id });
  });

  // Manual code exchange endpoint (for Codelab redirect_uri=https://www.google.com or manual code entry)
  app.post('/sources/:provider/exchange', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { provider } = req.params as { provider: string };
    const oauthProvider = oauthProviders[provider];
    if (!oauthProvider) return reply.status(404).send({ title: 'Unbekannter Provider.' });

    const body = req.body as { code?: string; redirectUri?: string } | undefined;
    let code = body?.code?.trim();
    if (!code) return reply.status(400).send({ title: 'Code erforderlich.' });

    // Handle user pasting complete callback URL (e.g. https://www.google.com/?code=4/0A...)
    if (code.includes('code=')) {
      try {
        const parsedUrl = new URL(code.startsWith('http') ? code : `https://${code}`);
        const parsedCode = parsedUrl.searchParams.get('code');
        if (parsedCode) code = parsedCode;
      } catch {
        // use raw code string
      }
    }

    const sourceKind = providerToSourceKind(provider);
    if (!sourceKind) return reply.status(404).send({ title: 'Unbekannter Provider.' });

    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const redirectUri = body?.redirectUri ?? (provider === 'google-fit' || provider === 'google-health' ? 'https://www.google.com' : oauthProvider.redirectUri(baseUrl));

    let credentials;
    try {
      credentials = await exchangeCodeForToken(oauthProvider, code, baseUrl, redirectUri);
    } catch {
      // If provided redirectUri failed, try with provider's configured redirectUri as fallback
      try {
        credentials = await exchangeCodeForToken(oauthProvider, code, baseUrl, oauthProvider.redirectUri(baseUrl));
      } catch {
        return reply.status(400).send({ title: 'Ungültiger Autorisierungscode oder abgelaufenes Token.' });
      }
    }

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, sourceKind)))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId: user.id,
        kind: sourceKind,
        adapter: provider,
        enabled: true,
        consentAt: new Date(),
        credentials,
        syncStatus: 'ok',
        syncError: null,
      }).returning();
    } else {
      await db.update(sources).set({
        credentials,
        enabled: true,
        consentAt: new Date(),
        syncStatus: 'ok',
        syncError: null,
      }).where(eq(sources.id, src.id));
    }

    let inserted = 0;
    if (sourceKind === 'google_fit') {
      try {
        const parsedSamples = await fetchGoogleFitSamples(credentials.accessToken);
        inserted = await upsertGoogleFitSamples(user.id, src.id, parsedSamples);
        await db.update(sources).set({ lastSyncAt: new Date(), syncStatus: 'ok', syncError: null }).where(eq(sources.id, src.id));
      } catch (err) {
        req.log.warn(err, 'Initial Google sync after manual exchange failed');
      }
    }

    return reply.status(200).send({ ok: true, sourceId: src.id, inserted });
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

    const today = new Date().toISOString().slice(0, 10);
    await db.delete(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, user.id), eq(scoreSnapshots.computedFor, today)));

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

    const today = new Date().toISOString().slice(0, 10);
    await db.delete(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, user.id), eq(scoreSnapshots.computedFor, today)));

    return reply.status(204).send();
  });

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

  app.post('/sources/apple-health/upload', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const data = await req.file();
    if (!data) return reply.status(400).send({ title: 'Keine Datei hochgeladen.' });

    const buffer = await data.toBuffer();

    let xmlStream: Readable;
    if (looksLikeZip(buffer)) {
      try {
        xmlStream = await extractExportXml(buffer);
      } catch (err) {
        const message = err instanceof AppleHealthZipError ? err.message : 'Das ZIP-Archiv konnte nicht verarbeitet werden.';
        return reply.status(400).send({ title: message });
      }
    } else {
      xmlStream = Readable.from(buffer);
    }

    const parsedSamples = await parseAppleHealthXml(xmlStream, { birthDate: user.birthDate });

    if (parsedSamples.length === 0) {
      return reply.status(400).send({
        title: 'Keine bekannten Apple-Health-Metriken in der Datei gefunden. Bitte export.xml oder das vollständige ZIP-Archiv aus der Health-App hochladen.',
      });
    }

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'apple_health')))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId: user.id,
        kind: 'apple_health',
        adapter: 'upload',
        enabled: true,
        consentAt: new Date(),
        lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, src.id));
    }

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

    return { inserted, sourceId: src.id };
  });

  app.post('/sources/health-auto-export/webhook', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = req.body as any;
    const parsedSamples = parseHealthAutoExport(payload, { birthDate: user.birthDate });

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'apple_health')))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId: user.id,
        kind: 'apple_health',
        adapter: 'health_auto_export',
        enabled: true,
        consentAt: new Date(),
        lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ adapter: 'health_auto_export', lastSyncAt: new Date() }).where(eq(sources.id, src.id));
    }

    let inserted = 0;
    for (const s of parsedSamples) {
      const rows = await db.insert(samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing().returning({ id: samples.id });
      if (rows.length > 0) inserted++;
    }

    return reply.status(200).send({ inserted, sourceId: src.id });
  });

  app.post('/labs', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const body = req.body as { values?: Array<{ metric: string; value: number; unit: string; measuredAt?: string }> };
    if (!Array.isArray(body.values) || body.values.length === 0) {
      return reply.status(400).send({ title: 'values-Array erforderlich.' });
    }

    let [labSource] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'lab')))
      .limit(1);

    if (!labSource) {
      [labSource] = await db.insert(sources).values({
        userId: user.id,
        kind: 'lab',
        adapter: 'manual',
        enabled: true,
        consentAt: new Date(),
        lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, labSource.id));
    }

    const now = new Date();
    const inserted: string[] = [];
    for (const entry of body.values) {
      if (!entry.metric || entry.value === undefined || !entry.unit) continue;
      const measuredAt = entry.measuredAt ? new Date(entry.measuredAt) : now;
      await db.insert(samples).values({
        userId: user.id,
        sourceId: labSource.id,
        metric: entry.metric,
        value: entry.value,
        unit: entry.unit,
        measuredAt,
      }).onConflictDoUpdate({
        target: [samples.userId, samples.metric, samples.measuredAt],
        set: { value: entry.value, unit: entry.unit },
      });
      inserted.push(entry.metric);
    }

    return reply.status(201).send({ inserted, sourceId: labSource.id });
  });

  app.post('/sources/fhir/upload', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsedSamples = parseFhirBundle(req.body);
    if (parsedSamples.length === 0) {
      return reply.status(400).send({ title: 'Keine bekannten LOINC-Metriken im FHIR-Bundle gefunden.' });
    }

    let [labSource] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'lab')))
      .limit(1);

    if (!labSource) {
      [labSource] = await db.insert(sources).values({
        userId: user.id,
        kind: 'lab',
        adapter: 'fhir',
        enabled: true,
        consentAt: new Date(),
        lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, labSource.id));
    }

    let inserted = 0;
    for (const s of parsedSamples) {
      const rows = await db.insert(samples).values({
        userId: user.id,
        sourceId: labSource.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoUpdate({
        target: [samples.userId, samples.metric, samples.measuredAt],
        set: { value: s.value, unit: s.unit },
      }).returning({ id: samples.id });
      if (rows.length > 0) inserted++;
    }

    return reply.status(201).send({ inserted, sourceId: labSource.id });
  });
}
