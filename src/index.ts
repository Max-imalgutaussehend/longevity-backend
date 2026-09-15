import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { env } from './env.js';
import { db } from './db/client.js';
import { users, sources, samples, shareTokens, partnerOffers, scoreSnapshots, organizations } from './db/schema.js';
import type { Role } from './db/schema.js';
import { eq, desc, and, gte, asc, sql, inArray } from 'drizzle-orm';
import { hash, verify as argon2Verify } from '@node-rs/argon2';
import { computeScore, simulate, suggestLevers } from './score/index.js';
import { METRICS } from './score/metrics.js';
import { generate } from './mock/generate.js';
import { isWeakPassword } from './lib/weakPasswords.js';
import { signTokenPayload, verifyTokenSignature, buildTokenPayload } from './lib/signing.js';

const METRIC_LABELS: Record<string, string> = {
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

const DOMAIN_LABELS: Record<string, string> = {
  cardiometabolic: 'Kardiometabolik',
  recovery: 'Regeneration',
  activity: 'Aktivität',
  risk: 'Risiko',
};
import { PgSessionStore } from './lib/pgSessionStore.js';
import { parseAppleHealthXml } from './adapters/appleHealth.js';
import { looksLikeZip, extractExportXml, AppleHealthZipError } from './adapters/appleHealthZip.js';
import { parseHealthAutoExport } from './adapters/healthAutoExport.js';
import { parseFhirBundle } from './adapters/fhir.js';
import { exchangeCodeForToken, getValidToken } from './lib/oauthTokens.js';
import { oauthProviders, providerToSourceKind } from './lib/oauthProviders.js';
import { fetchWithingsSamples } from './adapters/withings.js';
import { fetchGoogleFitSamples } from './adapters/googleFit.js';
import { fetchOuraSamples } from './adapters/oura.js';
import { fetchStravaSamples } from './adapters/strava.js';
import { readFileSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import type { Sample, Metric } from './score/types.js';
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

async function requireRole(req: FastifyRequest, reply: FastifyReply, roles: readonly Role[]) {
  const user = await requireUser(req, reply);
  if (!user) return null;
  if (!roles.includes(user.role as Role)) {
    reply.status(403).send({ title: 'Keine Berechtigung für diese Aktion.' });
    return null;
  }
  return user;
}

async function getUserSamples(userId: string): Promise<Sample[]> {
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

async function upsertGoogleFitSamples(userId: string, sourceId: string, parsedSamples: Sample[]): Promise<number> {
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

const start = async () => {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
  });

  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } }); // 500 MB cap for AH exports (ZIP or raw XML)

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

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      done(err as Error, undefined);
    }
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

  // ── Google Sign-In ────────────────────────────────────────────────────────────

  app.post('/api/auth/google/url', async (req) => {
    const googleClientId = env.GOOGLE_FIT_CLIENT_ID ?? env.GOOGLE_HEALTH_CLIENT_ID;
    if (!googleClientId) return { url: null };
    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const redirectUri = (env.GOOGLE_REDIRECT_URI && env.GOOGLE_REDIRECT_URI.trim()) || `${baseUrl}/api/auth/google/callback`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', googleClientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('prompt', 'select_account');
    return { url: url.toString() };
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    const { code } = req.query as { code?: string };
    const googleClientId = env.GOOGLE_FIT_CLIENT_ID ?? env.GOOGLE_HEALTH_CLIENT_ID;
    const googleClientSecret = env.GOOGLE_FIT_CLIENT_SECRET ?? env.GOOGLE_HEALTH_CLIENT_SECRET;
    if (!googleClientId || !googleClientSecret || !code) {
      return reply.redirect('/login?error=google_auth_failed');
    }

    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const redirectUri = (env.GOOGLE_REDIRECT_URI && env.GOOGLE_REDIRECT_URI.trim()) || `${baseUrl}/api/auth/google/callback`;

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: googleClientId,
          client_secret: googleClientSecret,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error('Token exchange failed');
      const tokenData = await tokenRes.json() as { access_token: string };

      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userRes.ok) throw new Error('UserInfo request failed');
      const userInfo = await userRes.json() as { email?: string; name?: string };

      if (!userInfo.email) {
        return reply.redirect('/login?error=no_email');
      }

      const [existingUser] = await db.select().from(users).where(eq(users.email, userInfo.email)).limit(1);
      if (existingUser) {
        req.session.userId = existingUser.id;
        return reply.redirect('/dashboard');
      }

      return reply.redirect(`/register?googleEmail=${encodeURIComponent(userInfo.email)}&name=${encodeURIComponent(userInfo.name ?? '')}`);
    } catch (err) {
      req.log.error(err, 'Google Sign-In failed');
      return reply.redirect('/login?error=google_auth_failed');
    }
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
      role: user.role, organizationId: user.organizationId,
    };
  });

  app.post('/api/organizations/join', async (req, reply) => {
    const user = await requireRole(req, reply, ['b2c']);
    if (!user) return;

    const { joinCode } = req.body as { joinCode?: string };
    if (!joinCode) return reply.status(400).send({ title: 'Beitrittscode erforderlich.' });

    const [org] = await db.select().from(organizations).where(eq(organizations.joinCode, joinCode)).limit(1);
    if (!org || org.status !== 'active') {
      return reply.status(404).send({ title: 'Ungültiger Beitrittscode.' });
    }

    await db.update(users).set({ organizationId: org.id }).where(eq(users.id, user.id));
    return reply.status(200).send({ ok: true, organizationName: org.name });
  });

  app.post('/api/organizations/leave', async (req, reply) => {
    const user = await requireRole(req, reply, ['b2c']);
    if (!user) return;
    await db.update(users).set({ organizationId: null }).where(eq(users.id, user.id));
    return reply.status(204).send();
  });

  app.get('/api/insurer/overview', async (req, reply) => {
    const user = await requireRole(req, reply, ['insurer_admin', 'insurer_staff']);
    if (!user) return;
    if (!user.organizationId) return reply.status(404).send({ title: 'Keine Organisation zugeordnet.' });

    const members = await db.select({ id: users.id, birthDate: users.birthDate, sex: users.sex })
      .from(users)
      .where(and(eq(users.organizationId, user.organizationId), eq(users.role, 'b2c')));

    const memberIds = members.map((m) => m.id);
    const activeMemberCount = memberIds.length;

    let averageScore: number | null = null;
    let averageCoverage: number | null = null;
    let membersWithScoreCount = 0;

    if (memberIds.length > 0) {
      const latestPerMember = await db
        .select({ userId: scoreSnapshots.userId, score: scoreSnapshots.score, coverage: scoreSnapshots.coverage, computedFor: scoreSnapshots.computedFor })
        .from(scoreSnapshots)
        .where(inArray(scoreSnapshots.userId, memberIds))
        .orderBy(desc(scoreSnapshots.computedFor));

      const latestByUser = new Map<string, { score: number; coverage: number }>();
      for (const row of latestPerMember) {
        if (!latestByUser.has(row.userId)) {
          latestByUser.set(row.userId, { score: row.score, coverage: row.coverage });
        }
      }

      const scores = [...latestByUser.values()];
      membersWithScoreCount = scores.length;
      if (scores.length > 0) {
        averageScore = Math.round((scores.reduce((sum, s) => sum + s.score, 0) / scores.length) * 10) / 10;
        averageCoverage = Math.round((scores.reduce((sum, s) => sum + s.coverage, 0) / scores.length) * 100) / 100;
      }
    }

    const [org] = await db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);

    return {
      organizationName: org?.name ?? null,
      activeMemberCount,
      averageScore,
      averageCoverage,
      membersWithScoreCount,
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

  app.get('/api/samples/summary', async (req, reply) => {
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

    const today = new Date().toISOString().slice(0, 10);
    await db.delete(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, user.id), eq(scoreSnapshots.computedFor, today)));

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

    await db.update(sources).set({ lastSyncAt: new Date(), enabled: true }).where(eq(sources.id, id));

    return { ok: true, sampleCount: newSamples.length };
  });

  app.post('/api/sources/mock/generate', async (req, reply) => {
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
        userId: user.id, sourceId: src.id,
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      })));
    }

    return { ok: true, sourceId: src.id, sampleCount: newSamples.length };
  });

  // ── Generic OAuth (Issue #30 — Fundament für Withings/Google Fit/Oura/Strava) ───

  app.post('/api/sources/:provider/connect', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { provider } = req.params as { provider: string };
    const oauthProvider = oauthProviders[provider];
    if (!oauthProvider) return reply.status(404).send({ title: 'Unbekannter Provider.' });

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

    // Auto-sync initial samples for Google Fit / Google Health
    if (sourceKind === 'google_fit') {
      try {
        const parsedSamples = await fetchGoogleFitSamples(credentials.accessToken);
        await upsertGoogleFitSamples(userId, src.id, parsedSamples);
        await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, src.id));
      } catch (err) {
        req.log.warn(err, 'Initial Google sync after OAuth callback failed');
      }
    }

    const acceptsHtml = req.headers.accept?.includes('text/html');
    if (acceptsHtml) {
      return reply.redirect('/daten?connected=' + encodeURIComponent(provider));
    }

    return reply.status(200).send({ ok: true, sourceId: src.id });
  });

  // Alias for Google OAuth callback if registered as /api/sources/google/callback
  app.get('/api/sources/google/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const oauthProvider = oauthProviders['google-fit'];
    if (!oauthProvider) return reply.status(404).send({ title: 'Unbekannter Provider.' });
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
        userId, kind: 'google_fit', adapter: 'google-fit',
        enabled: true, consentAt: new Date(), credentials,
      }).returning();
    } else {
      await db.update(sources).set({ credentials, enabled: true, consentAt: new Date() }).where(eq(sources.id, src.id));
    }

    try {
      const parsedSamples = await fetchGoogleFitSamples(credentials.accessToken);
      await upsertGoogleFitSamples(userId, src.id, parsedSamples);
      await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, src.id));
    } catch (err) {
      req.log.warn(err, 'Initial Google sync after OAuth callback failed');
    }

    const acceptsHtml = req.headers.accept?.includes('text/html');
    if (acceptsHtml) {
      return reply.redirect('/daten?connected=google-fit');
    }

    return reply.status(200).send({ ok: true, sourceId: src.id });
  });

  // Manual code exchange endpoint (for Codelab redirect_uri=https://www.google.com or manual code entry)
  app.post('/api/sources/:provider/exchange', async (req, reply) => {
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
        userId: user.id, kind: sourceKind, adapter: provider,
        enabled: true, consentAt: new Date(), credentials,
      }).returning();
    } else {
      await db.update(sources).set({ credentials, enabled: true, consentAt: new Date() }).where(eq(sources.id, src.id));
    }

    let inserted = 0;
    if (sourceKind === 'google_fit') {
      try {
        const parsedSamples = await fetchGoogleFitSamples(credentials.accessToken);
        inserted = await upsertGoogleFitSamples(user.id, src.id, parsedSamples);
        await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, src.id));
      } catch (err) {
        req.log.warn(err, 'Initial Google sync after manual exchange failed');
      }
    }

    return reply.status(200).send({ ok: true, sourceId: src.id, inserted });
  });

  app.delete('/api/sources/:id/disconnect', async (req, reply) => {
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

    await db.update(sources).set({ credentials: null, enabled: false }).where(eq(sources.id, id));

    const today = new Date().toISOString().slice(0, 10);
    await db.delete(scoreSnapshots)
      .where(and(eq(scoreSnapshots.userId, user.id), eq(scoreSnapshots.computedFor, today)));

    return reply.status(204).send();
  });

  app.delete('/api/sources/:id/samples', async (req, reply) => {
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

  // ── Google Fit sync (Issue #37) ──────────────────────────────────────────────

  app.post('/api/sources/google-fit/sync', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'google_fit')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Google Fit ist nicht verbunden.' });

    const accessToken = await getValidToken(src.id, oauthProviders['google-fit']);
    const parsedSamples = await fetchGoogleFitSamples(accessToken);
    const inserted = await upsertGoogleFitSamples(user.id, src.id, parsedSamples);

    await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, src.id));

    return { inserted, sourceId: src.id };
  });

  // ── Oura sync (Issue #33) ────────────────────────────────────────────────────

  app.post('/api/sources/oura/sync', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'oura')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Oura ist nicht verbunden.' });

    const accessToken = await getValidToken(src.id, oauthProviders.oura);
    const parsedSamples = await fetchOuraSamples(accessToken);

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

  // ── Strava sync (Issue #34) ──────────────────────────────────────────────────

  app.post('/api/sources/strava/sync', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'strava')))
      .limit(1);

    if (!src) return reply.status(404).send({ title: 'Strava ist nicht verbunden.' });

    const since = src.lastSyncAt ? Math.floor(src.lastSyncAt.getTime() / 1000) : Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
    const accessToken = await getValidToken(src.id, oauthProviders.strava);
    const parsedSamples = await fetchStravaSamples(accessToken, since);

    let inserted = 0;
    for (const s of parsedSamples) {
      await db.insert(samples).values({
        userId: user.id, sourceId: src.id,
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoUpdate({
        target: [samples.userId, samples.metric, samples.measuredAt],
        set: { value: s.value },
      });
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

  app.get('/api/account/export', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [userSources, userSamples, userSnapshots, userShareTokens] = await Promise.all([
      db.select().from(sources).where(eq(sources.userId, user.id)),
      db.select().from(samples).where(eq(samples.userId, user.id)),
      db.select().from(scoreSnapshots).where(eq(scoreSnapshots.userId, user.id)),
      db.select().from(shareTokens).where(eq(shareTokens.userId, user.id)),
    ]);

    const exportData = {
      user: {
        email: user.email,
        displayName: user.displayName,
        birthDate: user.birthDate,
        sex: user.sex,
        createdAt: user.createdAt.toISOString(),
      },
      sources: userSources.map((s) => ({
        id: s.id, kind: s.kind, adapter: s.adapter, enabled: s.enabled,
        consentAt: s.consentAt?.toISOString() ?? null,
        lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
      })),
      samples: userSamples.map((s) => ({
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: s.measuredAt.toISOString(),
      })),
      scoreSnapshots: userSnapshots.map((s) => ({
        computedFor: s.computedFor, score: s.score, coverage: s.coverage,
        bioAge: s.bioAge, breakdown: s.breakdown, engineVersion: s.engineVersion,
      })),
      shareTokens: userShareTokens.map((t) => ({
        bandLow: t.bandLow, bandHigh: t.bandHigh,
        issuedAt: t.issuedAt.toISOString(), expiresAt: t.expiresAt.toISOString(),
        revokedAt: t.revokedAt?.toISOString() ?? null, partnerRef: t.partnerRef,
      })),
    };

    const date = new Date().toISOString().slice(0, 10);
    reply.header('Content-Disposition', `attachment; filename="longevity-export-${date}.json"`);
    return reply.type('application/json').send(exportData);
  });

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

  // ── FHIR lab import (Issue #39) ──────────────────────────────────────────────

  app.post('/api/sources/fhir/upload', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
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
        userId: user.id, kind: 'lab', adapter: 'fhir', enabled: true,
        consentAt: new Date(), lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, labSource.id));
    }

    let inserted = 0;
    for (const s of parsedSamples) {
      const rows = await db.insert(samples).values({
        userId: user.id, sourceId: labSource.id,
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoUpdate({
        target: [samples.userId, samples.metric, samples.measuredAt],
        set: { value: s.value, unit: s.unit },
      }).returning({ id: samples.id });
      if (rows.length > 0) inserted++;
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

    // Buffered (not streamed to disk) since ZIP central-directory parsing needs
    // random access; the 500 MB multipart limit bounds per-request memory use.
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
    const parsedSamples = parseHealthAutoExport(payload, { birthDate: user.birthDate });

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'apple_health')))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId: user.id, kind: 'apple_health', adapter: 'health_auto_export',
        enabled: true, consentAt: new Date(), lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ adapter: 'health_auto_export', lastSyncAt: new Date() }).where(eq(sources.id, src.id));
    }

    let inserted = 0;
    for (const s of parsedSamples) {
      const rows = await db.insert(samples).values({
        userId: user.id, sourceId: src.id,
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing().returning({ id: samples.id });
      if (rows.length > 0) inserted++;
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
