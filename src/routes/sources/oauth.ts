import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sources } from '../../db/schema.js';
import { env } from '../../env.js';
import { exchangeCodeForToken } from '../../lib/oauthTokens.js';
import { oauthProviders, providerToSourceKind } from '../../lib/oauthProviders.js';
import { signOAuthState, verifyOAuthState } from '../../lib/oauthState.js';
import { fetchGoogleFitSamples } from '../../adapters/googleFit.js';
import { requireUser, upsertGoogleFitSamples, invalidateTodaySnapshot } from '../helpers.js';
import '../../types.js';

export async function sourcesOAuthRoutes(app: FastifyInstance) {
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
    const state = signOAuthState({ userId: user.id, provider });
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

    // google-health shares google-fit's OAuth redirect endpoint (see oauthProviders.ts),
    // so a state signed for 'google-health' arrives here with :provider === 'google-fit'.
    const acceptedStateProviders = provider === 'google-fit' ? ['google-fit', 'google-health'] : [provider];
    const stateResult = verifyOAuthState(state, acceptedStateProviders);
    if (!stateResult.ok) {
      return reply.status(400).send({ title: 'Ungültiger oder abgelaufener state-Parameter.' });
    }
    const { userId } = stateResult;

    // A wearable connect always originates from an authenticated session
    // (POST /sources/:provider/connect requires one); the callback must see
    // that same session, not merely "a session if one happens to be present".
    if (!req.session.userId || req.session.userId !== userId) {
      return reply.status(403).send({ title: 'State gehört nicht zur aktuellen Sitzung.' });
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
        await invalidateTodaySnapshot(userId);
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

    const stateResult = verifyOAuthState(state, ['google-fit', 'google-health']);
    if (!stateResult.ok) {
      return reply.status(400).send({ title: 'Ungültiger oder abgelaufener state-Parameter.' });
    }
    const { userId } = stateResult;

    // A wearable connect always originates from an authenticated session
    // (POST /sources/:provider/connect requires one); the callback must see
    // that same session, not merely "a session if one happens to be present".
    if (!req.session.userId || req.session.userId !== userId) {
      return reply.status(403).send({ title: 'State gehört nicht zur aktuellen Sitzung.' });
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
      await invalidateTodaySnapshot(userId);
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
}
