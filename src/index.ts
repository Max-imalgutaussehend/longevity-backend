import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { env } from './env.js';
import { db } from './db/client.js';
import { users, sources, samples, shareTokens, partnerOffers, scoreSnapshots } from './db/schema.js';
import { eq, desc, and, gte, asc } from 'drizzle-orm';
import { hash, verify as argon2Verify } from '@node-rs/argon2';
import { computeScore, simulate, suggestLevers } from './score/index.js';
import { generate } from './mock/generate.js';
import { isWeakPassword } from './lib/weakPasswords.js';
import { signTokenPayload, verifyTokenSignature, buildTokenPayload } from './lib/signing.js';
import { PgSessionStore } from './lib/pgSessionStore.js';
import { parseAppleHealthXml } from './adapters/appleHealth.js';
import { parseHealthAutoExport } from './adapters/healthAutoExport.js';
import { exchangeCodeForToken, getValidToken } from './lib/oauthTokens.js';
import { oauthProviders, providerToSourceKind } from './lib/oauthProviders.js';
import { fetchWithingsSamples } from './adapters/withings.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Sample } from './score/types.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface Session {
    userId?: string;
  }
}

async function requireUser(req: FastifyRequest, reply: FastifyReply) {
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

async function getUserSamples(userId: string): Promise<Sample[]> {
  const rows = await db.select().from(samples).where(eq(samples.userId, userId));
  return rows.map(r => ({
    metric: r.metric as Sample['metric'],
    value: r.value,
    unit: r.unit,
    measuredAt: r.measuredAt.toISOString(),
    sourceKind: 'apple_health' as Sample['sourceKind'],
  }));
}

const start = async () => {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
  });

  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } }); // 200 MB cap for AH exports

  await app.register(cookie);
  await app.register(session, {
    secret: env.SESSION_SECRET,
    store: new PgSessionStore(),
    cookie: {
      // Cloudflare terminates TLS — the API only sees HTTP from the tunnel.
      // Setting secure:true would suppress Set-Cookie on HTTP connections.
      // The cookie travels browser→Cloudflare over HTTPS, which is sufficient.
      secure: false,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
    saveUninitialized: false,
  });

  // ── OpenAPI spec ──────────────────────────────────────────────────────────────

  const openApiPath = resolve(process.cwd(), 'openapi.json');

  app.get('/api/openapi.json', { config: {} }, async (req, reply) => {
    if (!existsSync(openApiPath)) {
      return reply.status(404).send({ title: 'openapi.json nicht gefunden. Bitte pnpm gen:openapi ausführen.' });
    }
    return reply.type('application/json').send(readFileSync(openApiPath, 'utf8'));
  });

  // ── Health ────────────────────────────────────────────────────────────────────

  app.get('/api/healthz', async () => {
    await db.execute('select 1');
    return { ok: true, db: true, engineVersion: '0.1.0', commit: env.COMMIT_SHA };
  });

  // ── Auth ──────────────────────────────────────────────────────────────────────

  app.post('/api/auth/register', async (req, reply) => {
    const body = req.body as { email?: string; password?: string; birthDate?: string; sex?: string; displayName?: string };
    const { email, password, birthDate, sex, displayName } = body;

    if (!email || !password || !birthDate || !sex) {
      return reply.status(400).send({ title: 'Pflichtfelder fehlen.' });
    }
    if (password.length < 10) {
      return reply.status(400).send({ title: 'Passwort muss mindestens 10 Zeichen haben.' });
    }
    if (isWeakPassword(password)) {
      return reply.status(400).send({ title: 'Dieses Passwort ist zu häufig. Bitte wähle ein sichereres Passwort.' });
    }
    if (sex !== 'm' && sex !== 'f') {
      return reply.status(400).send({ title: 'Ungültiges Geschlecht.' });
    }

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      return reply.status(409).send({ title: 'E-Mail bereits vergeben.' });
    }

    const passwordHash = await hash(password);
    const [user] = await db.insert(users).values({
      email, passwordHash, birthDate, sex, displayName: displayName ?? null,
    }).returning();

    const [src] = await db.insert(sources).values({
      userId: user.id, kind: 'apple_health', adapter: 'mock', enabled: true, lastSyncAt: new Date(),
    }).returning();

    const mockSamples = generate(user.id.charCodeAt(0) * 31 + 7, 90);
    if (mockSamples.length > 0) {
      await db.insert(samples).values(mockSamples.map(s => ({
        userId: user.id, sourceId: src.id,
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      })));
    }

    req.session.userId = user.id;
    return reply.status(201).send({ id: user.id, email: user.email });
  });

  app.post('/api/auth/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({ title: 'Zu viele Login-Versuche. Bitte in 15 Minuten erneut versuchen.' }),
      },
    },
  }, async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return reply.status(400).send({ title: 'E-Mail und Passwort erforderlich.' });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return reply.status(401).send({ title: 'E-Mail oder Passwort falsch.' });

    const ok = await argon2Verify(user.passwordHash, password);
    if (!ok) return reply.status(401).send({ title: 'E-Mail oder Passwort falsch.' });

    req.session.userId = user.id;
    return reply.status(200).send({ ok: true });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await req.session.destroy();
    return reply.status(204).send();
  });

  // ── Me ────────────────────────────────────────────────────────────────────────

  app.get('/api/me', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const now = new Date();
    const chronoAge = (now.getTime() - new Date(user.birthDate).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    return {
      id: user.id, email: user.email, displayName: user.displayName,
      birthDate: user.birthDate, sex: user.sex,
      chronoAge: Math.round(chronoAge * 10) / 10,
    };
  });

  // ── Score ─────────────────────────────────────────────────────────────────────

  app.get('/api/score/current', async (req, reply) => {
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
    const [existing] = await db.select({ id: scoreSnapshots.id, engineVersion: scoreSnapshots.engineVersion })
      .from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, user.id), eq(scoreSnapshots.computedFor, today)))
      .limit(1);

    if (!existing || existing.engineVersion !== result.engineVersion) {
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

  app.get('/api/score/history', async (req, reply) => {
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

  app.get('/api/score/breakdown', async (req, reply) => {
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

  app.get('/api/score/levers', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const userSamples = await getUserSamples(user.id);
    return suggestLevers({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples: userSamples,
      now: new Date(),
    });
  });

  const VALID_METRICS = [
    'vo2max', 'resting_hr', 'systolic_bp', 'ldl', 'hdl', 'hba1c', 'waist',
    'sleep_duration', 'sleep_consistency', 'hrv_rmssd',
    'zone2_minutes', 'steps', 'strength_sessions',
    'smoking', 'alcohol_units', 'hscrp',
  ] as const;

  const simulateBodySchema = z.object({
    overrides: z.record(z.enum(VALID_METRICS), z.number()),
  });

  app.post('/api/score/simulate', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({ type: 'about:blank', title: 'Rate-Limit überschritten.', status: 429, detail: 'Maximal 30 Simulationen pro Minute.' }),
      },
    },
  }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsed = simulateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        type: 'about:blank', title: 'Ungültige Eingabe.', status: 400,
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

  // ── Sources ───────────────────────────────────────────────────────────────────

  app.get('/api/sources', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const rows = await db.select().from(sources).where(eq(sources.userId, user.id));
    const allSamples = await db.select({ sourceId: samples.sourceId }).from(samples).where(eq(samples.userId, user.id));

    const countMap = new Map<string, number>();
    for (const s of allSamples) countMap.set(s.sourceId, (countMap.get(s.sourceId) ?? 0) + 1);

    return rows.map(s => ({
      id: s.id, kind: s.kind, adapter: s.adapter, enabled: s.enabled,
      lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
      sampleCount: countMap.get(s.id) ?? 0,
    }));
  });

  app.patch('/api/sources/:id', async (req, reply) => {
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

    return reply.status(204).send();
  });

  app.post('/api/sources/:id/regenerate', async (req, reply) => {
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
        userId: user.id, sourceId: id,
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      })));
    }

    await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, id));

    return { ok: true, sampleCount: newSamples.length };
  });

  // ── Generic OAuth (Issue #30 — Fundament für Withings/Google Fit/Oura/Strava) ───

  app.post('/api/sources/:provider/connect', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { provider } = req.params as { provider: string };
    const oauthProvider = oauthProviders[provider];
    if (!oauthProvider) return reply.status(404).send({ title: 'Unbekannter Provider.' });

    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const state = Buffer.from(JSON.stringify({ userId: user.id, provider })).toString('base64url');

    const url = new URL(oauthProvider.authorizeUrl);
    url.searchParams.set('client_id', oauthProvider.clientId ?? '');
    url.searchParams.set('redirect_uri', oauthProvider.redirectUri(baseUrl));
    url.searchParams.set('scope', oauthProvider.scope);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    return { url: url.toString() };
  });

  app.get('/api/oauth/callback/:provider', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { code, state } = req.query as { code?: string; state?: string };
    const oauthProvider = oauthProviders[provider];
    if (!oauthProvider) return reply.status(404).send({ title: 'Unbekannter Provider.' });
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
        userId, kind: sourceKind, adapter: provider,
        enabled: true, consentAt: new Date(), credentials,
      }).returning();
    } else {
      await db.update(sources).set({ credentials, enabled: true, consentAt: new Date() }).where(eq(sources.id, src.id));
    }

    return reply.status(200).send({ ok: true, sourceId: src.id });
  });

  app.delete('/api/sources/:id/disconnect', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { id } = req.params as { id: string };
    const [source] = await db.select().from(sources)
      .where(and(eq(sources.id, id), eq(sources.userId, user.id)))
      .limit(1);

    if (!source) return reply.status(404).send({ title: 'Quelle nicht gefunden.' });

    await db.update(sources).set({ credentials: null, enabled: false }).where(eq(sources.id, id));

    return reply.status(204).send();
  });

  // ── Withings sync (Issue #36) ────────────────────────────────────────────────

  app.post('/api/sources/withings/sync', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'withings')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Withings ist nicht verbunden.' });

    const accessToken = await getValidToken(src.id, oauthProviders.withings);
    const parsedSamples = await fetchWithingsSamples(accessToken);

    let inserted = 0;
    for (const s of parsedSamples) {
      await db.insert(samples).values({
        userId: user.id, sourceId: src.id,
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
      inserted++;
    }

    await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, src.id));

    return { inserted, sourceId: src.id };
  });

  // ── Report ────────────────────────────────────────────────────────────────────

  app.get('/api/report/weekly', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const rows = await db.select({
      computedFor: scoreSnapshots.computedFor,
      score: scoreSnapshots.score,
      breakdown: scoreSnapshots.breakdown,
    }).from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, user.id), gte(scoreSnapshots.computedFor, weekAgo)))
      .orderBy(asc(scoreSnapshots.computedFor));

    if (rows.length < 2) {
      // Compute fresh and return single-point report
      const userSamples = await getUserSamples(user.id);
      const current = computeScore({
        profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
        samples: userSamples, now,
      });
      return {
        weekStart: weekAgo,
        scoreStart: current.score,
        scoreEnd: current.score,
        delta: 0,
        bestMetric: 'vo2max',
        worstMetric: 'smoking',
        streakDays: rows.length,
      };
    }

    const first = rows[0];
    const last = rows[rows.length - 1];

    // Find best/worst metric from latest breakdown
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
      streakDays: rows.length,
    };
  });

  app.post('/api/report/send', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    // Email sending is not yet wired — log and acknowledge
    app.log.info({ userId: user.id }, 'Weekly report email requested');
    return { ok: true, sentTo: user.email };
  });

  // ── Account ───────────────────────────────────────────────────────────────────

  app.delete('/api/account', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const body = req.body as { password?: string };
    if (!body.password) {
      return reply.status(400).send({ title: 'Passwort erforderlich.' });
    }

    const ok = await argon2Verify(user.passwordHash, body.password);
    if (!ok) return reply.status(401).send({ title: 'Falsches Passwort.' });

    await req.session.destroy();
    await db.delete(users).where(eq(users.id, user.id));
    return reply.status(204).send();
  });

  // ── Lab values ────────────────────────────────────────────────────────────────

  app.post('/api/labs', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const body = req.body as { values?: Array<{ metric: string; value: number; unit: string; measuredAt?: string }> };
    if (!Array.isArray(body.values) || body.values.length === 0) {
      return reply.status(400).send({ title: 'values-Array erforderlich.' });
    }

    // Upsert or create a "lab" source for this user
    let [labSource] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'lab')))
      .limit(1);

    if (!labSource) {
      [labSource] = await db.insert(sources).values({
        userId: user.id, kind: 'lab', adapter: 'manual', enabled: true,
        consentAt: new Date(), lastSyncAt: new Date(),
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
        userId: user.id, sourceId: labSource.id,
        metric: entry.metric, value: entry.value, unit: entry.unit, measuredAt,
      }).onConflictDoUpdate({
        target: [samples.userId, samples.metric, samples.measuredAt],
        set: { value: entry.value, unit: entry.unit },
      });
      inserted.push(entry.metric);
    }

    return reply.status(201).send({ inserted, sourceId: labSource.id });
  });

  // ── Share tokens ──────────────────────────────────────────────────────────────

  app.get('/api/share-tokens', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const rows = await db.select().from(shareTokens)
      .where(eq(shareTokens.userId, user.id))
      .orderBy(desc(shareTokens.issuedAt));

    return rows.map(t => ({
      id: t.id, bandLow: t.bandLow, bandHigh: t.bandHigh,
      issuedAt: t.issuedAt.toISOString(), expiresAt: t.expiresAt.toISOString(),
      revokedAt: t.revokedAt?.toISOString() ?? null, partnerRef: t.partnerRef,
    }));
  });

  app.post('/api/share-tokens', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const userSamples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples: userSamples, now: new Date(),
    });

    const { days: daysReq } = req.body as { days?: number };
    const validDays = [30, 90, 180].includes(daysReq ?? 0) ? (daysReq ?? 90) : 90;

    const id = crypto.randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + validDays * 24 * 60 * 60 * 1000);

    const payload = buildTokenPayload(id, score.band.low, score.band.high, expiresAt.toISOString());
    const signature = env.SIGNING_KEY_PRIVATE
      ? signTokenPayload(payload, env.SIGNING_KEY_PRIVATE)
      : id;

    const [token] = await db.insert(shareTokens).values({
      id, userId: user.id,
      bandLow: score.band.low, bandHigh: score.band.high,
      issuedAt, expiresAt, signature,
    }).returning();

    return reply.status(201).send({
      id: token.id, bandLow: token.bandLow, bandHigh: token.bandHigh,
      issuedAt: token.issuedAt.toISOString(), expiresAt: token.expiresAt.toISOString(),
      revokedAt: null, partnerRef: null,
    });
  });

  app.delete('/api/share-tokens/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await db.update(shareTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareTokens.id, id), eq(shareTokens.userId, user.id)));
    return reply.status(204).send();
  });

  // ── Verify (public) ───────────────────────────────────────────────────────────

  app.get('/api/verify/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [token] = await db.select().from(shareTokens).where(eq(shareTokens.id, id)).limit(1);

    if (!token) return { valid: false, reason: 'not_found' };
    if (token.revokedAt) return { valid: false, reason: 'revoked' };
    if (new Date() > token.expiresAt) return { valid: false, reason: 'expired' };

    // Verify Ed25519 signature when key is configured; fall back gracefully for legacy tokens
    if (env.SIGNING_KEY_PUBLIC && token.signature !== token.id) {
      const payload = buildTokenPayload(token.id, token.bandLow, token.bandHigh, token.expiresAt.toISOString());
      const valid = verifyTokenSignature(payload, token.signature, env.SIGNING_KEY_PUBLIC);
      if (!valid) return { valid: false, reason: 'invalid_signature' };
    }

    return {
      valid: true,
      band: { low: token.bandLow, high: token.bandHigh },
      issuedAt: token.issuedAt.toISOString(),
      expiresAt: token.expiresAt.toISOString(),
    };
  });

  // ── Apple Health XML upload ───────────────────────────────────────────────────

  app.post('/api/sources/apple-health/upload', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const data = await req.file();
    if (!data) return reply.status(400).send({ title: 'Keine Datei hochgeladen.' });

    const parsedSamples = await parseAppleHealthXml(data.file);

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'apple_health')))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId: user.id, kind: 'apple_health', adapter: 'upload',
        enabled: true, consentAt: new Date(), lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, src.id));
    }

    let inserted = 0;
    for (const s of parsedSamples) {
      await db.insert(samples).values({
        userId: user.id, sourceId: src.id,
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
      inserted++;
    }

    return { inserted, sourceId: src.id };
  });

  // ── Health Auto Export webhook ─────────────────────────────────────────────────

  app.post('/api/sources/health-auto-export/webhook', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = req.body as any;
    const parsedSamples = parseHealthAutoExport(payload);

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'apple_health'), eq(sources.adapter, 'health_auto_export')))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId: user.id, kind: 'apple_health', adapter: 'health_auto_export',
        enabled: true, consentAt: new Date(), lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, src.id));
    }

    let inserted = 0;
    for (const s of parsedSamples) {
      await db.insert(samples).values({
        userId: user.id, sourceId: src.id,
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
      inserted++;
    }

    return reply.status(200).send({ inserted, sourceId: src.id });
  });

  // ── Partner offers ────────────────────────────────────────────────────────────

  const partnerOffersHandler = async (req: FastifyRequest) => {
    const rows = await db.select().from(partnerOffers).orderBy(partnerOffers.sortOrder);
    const userId = req.session.userId;

    let band = { low: 0, high: 100 };
    if (userId) {
      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (user) {
        const userSamples = await getUserSamples(userId);
        const score = computeScore({
          profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
          samples: userSamples, now: new Date(),
        });
        band = score.band;
      }
    }

    return rows.map(o => ({
      id: o.id, partnerName: o.partnerName, title: o.title,
      description: o.description, minBand: o.minBand,
      valueLabel: o.valueLabel, isDemo: o.isDemo,
      qualified: band.low >= o.minBand,
    }));
  };

  app.get('/api/partner-offers', partnerOffersHandler);
  app.get('/api/offers', partnerOffersHandler);

  try {
    await app.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
